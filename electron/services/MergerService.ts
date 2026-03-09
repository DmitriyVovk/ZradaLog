import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { LoggerService } from './LoggerService';

const stat = promisify(fs.stat);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function runFfmpeg(args: string[], opts: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { windowsHide: true, cwd: opts.cwd || undefined });
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
    // wait for files to stabilize on disk (avoid merging while ffmpeg still finalizes)
    for (const s of ordered) {
      try {
        await waitForFileStable(s);
      } catch (e) {
        this.logger.warn('File did not stabilize before merge, proceeding anyway', { file: s, err: (e as Error).message });
      }
    }

    // If only one segment, remux it first (fast, no re-encode) to ensure container is well-formed,
    // then re-encode with per-frame PTS assignment.
    if (ordered.length === 1) {
      const orig = ordered[0];
      const tmpRemux = path.join(path.dirname(orig), `${path.basename(orig, path.extname(orig))}.remux${path.extname(orig)}`);
      try {
        // remux copy to ensure moov atom and proper container
        await runFfmpeg(['-y', '-i', orig, '-c', 'copy', tmpRemux]);
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
        await runFfmpeg(args);
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

    // Multiple segments: build concat list
    const escapeForList = (p: string) => p.replace(/'/g, "'\\''");
    const contents = ordered.map(s => `file '${escapeForList(s)}'`).join('\n');
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
      const ff = spawn('ffmpeg', args, { windowsHide: true });

      ff.stderr.on('data', (chunk) => {
        this.logger.debug('ffmpeg', { stderr: chunk.toString() });
      });

      ff.on('close', (code) => {
        try { fs.unlinkSync(listFile); } catch (_) {}
        if (code === 0) {
          // cleanup original segments after successful merge
          for (const s of ordered) {
            try { fs.unlinkSync(s); } catch (_) {}
          }
          this.logger.info('Merge complete', { outPath });
          resolve();
        } else {
          this.logger.error('Merge failed', { code });
          reject(new Error(`ffmpeg exited with ${code}`));
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
