import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { LoggerService } from './LoggerService';

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
    // compute speedup factor: how much to compress time. If inputFps is low (eg 0.2 fps = one frame per 5s)
    // we want output to play at outputFps, so factor = outputFps / inputFps
    const factor = inputFps > 0 ? (outputFps / inputFps) : outputFps;

    // If only one segment, avoid concat demuxer (can fail on some MP4s); re-encode single file directly
    if (ordered.length === 1) {
      const single = ordered[0];
      return new Promise((resolve, reject) => {
        const args = [
          '-i', single,
          '-vf', `setpts=PTS/${factor}`,
          '-r', String(outputFps),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
          outPath
        ];
        const ff = spawn('ffmpeg', args, { windowsHide: true });

        ff.stderr.on('data', (chunk) => { this.logger.debug('ffmpeg', { stderr: chunk.toString() }); });

        ff.on('close', (code) => {
          if (code === 0) {
            this.logger.info('Merge complete (single)', { outPath });
            resolve();
          } else {
            this.logger.error('Merge failed (single)', { code });
            reject(new Error(`ffmpeg exited with ${code}`));
          }
        });

        ff.on('error', (err) => { this.logger.error('ffmpeg spawn failed', { err: err.message }); reject(err); });
      });
    }

    // Multiple segments: build concat list
    const escapeForList = (p: string) => p.replace(/'/g, "'\\''");
    const contents = ordered.map(s => `file '${escapeForList(s)}'`).join('\n');
    fs.writeFileSync(listFile, contents, { encoding: 'utf8' });

    return new Promise((resolve, reject) => {
      // Re-encode and remap timestamps to create a time-lapse video
      const args = [
        '-f', 'concat', '-safe', '0', '-i', listFile,
        '-vf', `setpts=PTS/${factor}`,
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
