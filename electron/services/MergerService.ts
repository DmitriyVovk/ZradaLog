import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { LoggerService } from './LoggerService';
import { getFFmpegPath } from '../utils/ffmpegUtils';
const FFMPEG_PATH = getFFmpegPath();
const stat = promisify(fs.stat);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FFMPEG_PROGRESS_LOG_INTERVAL_MS = 5000;

async function waitForFileStable(filePath: string, stableMs = 800, timeoutMs = 15000) {
  const start = Date.now();
  let lastSize = -1;
  while (Date.now() - start < timeoutMs) {
    try {
      const s = await stat(filePath);
      const size = s.size;
      if (size === lastSize) {
        await sleep(stableMs);
        const s2 = await stat(filePath);
        if (s2.size === size) return;
        lastSize = s2.size;
      } else {
        lastSize = size;
      }
    } catch (e) {
      await sleep(300);
    }
    await sleep(200);
  }
  throw new Error(`file did not stabilize in ${timeoutMs}ms: ${filePath}`);
}

function lowerProcessPriority(pid?: number, logger?: LoggerService) {
  if (process.platform !== 'win32' || !pid) return;
  try {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.PriorityClass = 'BelowNormal' }`,
    ], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) {
      logger?.info('Lowered merge ffmpeg priority', { pid, priority: 'BelowNormal' });
    } else {
      logger?.warn('Failed to lower merge ffmpeg priority', {
        pid,
        status: result.status,
        stderr: result.stderr,
      });
    }
  } catch (e) {
    logger?.warn('Failed to lower merge ffmpeg priority', {
      pid,
      err: (e as Error).message,
    });
  }
}

function isFfmpegProgress(text: string) {
  return /(^|\r|\n)\s*frame=\s*\d+/m.test(text);
}

function runFfmpeg(args: string[], opts: { cwd?: string, logger?: LoggerService } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG_PATH, args, { windowsHide: true, cwd: opts.cwd || undefined });
    lowerProcessPriority(p.pid, opts.logger);
    p.on('error', (err) => reject(err));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
  });
}

export class MergerService {
  private logger: LoggerService;

  constructor(logger: LoggerService) {
    this.logger = logger;
  }

  /**
   * Merge segments into single MP4 using ffmpeg concat demuxer.
   * segments: array of absolute paths
   */
  public async mergeSegments(segments: string[], outPath: string, options?: { inputFps?: number, outputFps?: number }): Promise<void> {
    if (!segments || segments.length === 0) throw new Error('No segments to merge');

    // sort segments by numeric index if they follow segment_XXXX.mp4 pattern
    const ordered = segments.slice().sort((a, b) => {
      const na = path.basename(a).match(/segment_(\d+)\.mp4$/);
      const nb = path.basename(b).match(/segment_(\d+)\.mp4$/);
      const ia = na ? parseInt(na[1], 10) : Number.POSITIVE_INFINITY;
      const ib = nb ? parseInt(nb[1], 10) : Number.POSITIVE_INFINITY;
      return ia - ib;
    });

    this.logger.info('Merging segments', { count: ordered.length, outPath });

    // create a temporary concat list file
    const dir = path.dirname(outPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const listFile = path.join(dir, `concat_${Date.now()}.txt`);

    const inputFps = options?.inputFps ?? 1;
    const outputFps = options?.outputFps ?? 30;
    // We'll ignore original PTS and assign sequential PTS per frame so each input frame
    // becomes exactly one output frame at `outputFps`. This avoids long first-frame artifacts.
    const factor = inputFps > 0 ? (outputFps / inputFps) : outputFps;
    const trimSeconds = 0; // trimming not used when reassigning PTS by frame index
    // Filter out empty or trivially-small segment files before merging to avoid ffmpeg concat errors
    const MIN_SEGMENT_BYTES = 2048; // skip files smaller than ~2KiB
    const valid: string[] = [];
    const skipped: Array<{ file: string; size: number; reason?: string }> = [];
    for (const s of ordered) {
      try {
        const st = await stat(s);
        if (st.size < MIN_SEGMENT_BYTES) {
          skipped.push({ file: s, size: st.size, reason: 'size' });
          continue;
        }
        // Prefer to use ffprobe to ensure the file actually contains playable video frames.
        // If ffprobe is unavailable or fails, fall back to size-based acceptance.
        let probed: { status: number | null; stdout: string } | null = null;
        try {
          const out = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nokey=1:noprint_wrappers=1', s], { encoding: 'utf8', windowsHide: true });
          probed = { status: out.status ?? null, stdout: out.stdout ?? '' };
        } catch (_) {
          probed = null;
        }

        if (probed && probed.status === 0) {
          const dur = Number((probed.stdout || '').trim());
          if (!isNaN(dur) && dur > 0) {
            valid.push(s);
          } else {
            skipped.push({ file: s, size: st.size, reason: 'ffprobe-duration-zero' });
          }
        } else if (probed) {
          // ffprobe returned error (likely corrupt segment: missing moov, bad container)
          skipped.push({ file: s, size: st.size, reason: 'ffprobe-invalid-file' });
        } else {
          // ffprobe not available (e.g., missing ffprobe binary), then fallback to size-based acceptance
          this.logger.warn('ffprobe unavailable: using size fallback', { file: s, size: st.size });
          valid.push(s);
        }
      } catch (e) {
        // file missing or unreadable -> treat as skipped
        skipped.push({ file: s, size: 0, reason: 'stat-failed' });
      }
    }

    if (skipped.length > 0) this.logger.warn('Skipping empty/small segments before merge', { skipped });

    if (valid.length === 0) {
      // try to provide helpful diagnostic: look for ffmpeg logs near the first segment
      let ffmpegLog: string | null = null;
      try {
        const firstDir = path.dirname(ordered[0] || outPath);
        const files = fs.readdirSync(firstDir).filter(f => /^ffmpeg-.*\.log$/.test(f));
        if (files.length > 0) {
          files.sort((a, b) => {
            const sa = fs.statSync(path.join(firstDir, a)).mtime.getTime();
            const sb = fs.statSync(path.join(firstDir, b)).mtime.getTime();
            return sa - sb;
          });
          ffmpegLog = path.join(firstDir, files[files.length - 1]);
        }
      } catch (_) {}

      const msg = `No valid segments to merge (all segments empty or too small). Skipped ${skipped.length} files.` + (ffmpegLog ? ` See ffmpeg log: ${ffmpegLog}` : '');
      this.logger.error('Merge aborted: no valid segments', { skipped, ffmpegLog });
      throw new Error(msg);
    }

    // If only one valid segment, remux it first (fast, no re-encode) to ensure container is well-formed,
    // then re-encode with per-frame PTS assignment.
    if (valid.length === 1) {
      const orig = valid[0];
      const tmpRemux = path.join(path.dirname(orig), `${path.basename(orig, path.extname(orig))}.remux${path.extname(orig)}`);
      try {
        // remux copy to ensure moov atom and proper container
        await runFfmpeg(['-y', '-i', orig, '-c', 'copy', tmpRemux], { logger: this.logger });
      } catch (e) {
        this.logger.error('Remux failed for single segment', { file: orig, err: (e as Error).message });
        throw e;
      }

      try {
        const single = tmpRemux;
        const vf = `setpts=N/(${outputFps}*TB)`;
        const args = [
          '-y', '-i', single,
          '-vf', vf,
          '-r', String(outputFps),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
          outPath
        ];
        await runFfmpeg(args, { logger: this.logger });
        this.logger.info('Merge complete (single)', { outPath });
        // cleanup originals and tmp
        try { fs.unlinkSync(orig); } catch (_) {}
        try { fs.unlinkSync(tmpRemux); } catch (_) {}
        return;
      } catch (e) {
        this.logger.error('Merge failed (single)', { err: (e as Error).message });
        try { fs.unlinkSync(tmpRemux); } catch (_) {}
        throw e;
      }
    }

    // Multiple valid segments: build concat list using filtered valid files
    const escapeForList = (p: string) => p.replace(/'/g, "'\\''");
    const contents = valid.map(s => `file '${escapeForList(s)}'`).join('\n');
    fs.writeFileSync(listFile, contents, { encoding: 'utf8' });

    return new Promise((resolve, reject) => {
      // Re-encode and remap timestamps to create a time-lapse video
      // assign sequential timestamps based on frame index (N) so each frame is one output frame
      const vf = `setpts=N/(${outputFps}*TB)`;
      const args = [
        '-f', 'concat', '-safe', '0', '-i', listFile,
        '-vf', vf,
        '-r', String(outputFps),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        outPath
      ];
      const ff = spawn(FFMPEG_PATH, args, { windowsHide: true });
      lowerProcessPriority(ff.pid, this.logger);
      let lastProgressLogAt = 0;

      ff.stderr.on('data', (chunk) => {
        const stderr = chunk.toString();
        if (isFfmpegProgress(stderr)) {
          const now = Date.now();
          if (now - lastProgressLogAt < FFMPEG_PROGRESS_LOG_INTERVAL_MS) return;
          lastProgressLogAt = now;
          this.logger.debug('ffmpeg progress', { stderr });
          return;
        }
        this.logger.debug('ffmpeg', { stderr });
      });

      ff.on('close', (code) => {
        try { fs.unlinkSync(listFile); } catch (_) {}
        if (code === 0) {
          // cleanup original segments after successful merge
          for (const s of valid) {
            try { fs.unlinkSync(s); } catch (_) {}
          }
          // also try to remove skipped small files (best effort)
          for (const s of skipped.map(x => x.file)) {
            try { fs.unlinkSync(s); } catch (_) {}
          }
          this.logger.info('Merge complete', { outPath, mergedCount: valid.length, skippedCount: skipped.length });
          resolve();
        } else {
          this.logger.error('Merge failed', { code, mergedCount: valid.length, skippedCount: skipped.length });
          // try to help by pointing to latest ffmpeg log if present
          let ffmpegLog: string | null = null;
          try {
            const firstDir = path.dirname(valid[0] || ordered[0] || outPath);
            const files = fs.readdirSync(firstDir).filter(f => /^ffmpeg-.*\.log$/.test(f));
            if (files.length > 0) {
              files.sort((a, b) => {
                const sa = fs.statSync(path.join(firstDir, a)).mtime.getTime();
                const sb = fs.statSync(path.join(firstDir, b)).mtime.getTime();
                return sa - sb;
              });
              ffmpegLog = path.join(firstDir, files[files.length - 1]);
            }
          } catch (_) {}
          const errMsg = `ffmpeg exited with ${code}` + (ffmpegLog ? `; see ${ffmpegLog}` : '');
          reject(new Error(errMsg));
        }
      });

      ff.on('error', (err) => {
        try { fs.unlinkSync(listFile); } catch (_) {}
        this.logger.error('ffmpeg spawn failed', { err: err.message });
        reject(err);
      });
    });
  }
}

export default MergerService;
