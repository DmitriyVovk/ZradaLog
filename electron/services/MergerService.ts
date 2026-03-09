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
  public async mergeSegments(segments: string[], outPath: string): Promise<void> {
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
    const contents = ordered.map(s => `file '${s.replace(/'/g, "'\\'\'")}'`).join('\n');
    fs.writeFileSync(listFile, contents);

    return new Promise((resolve, reject) => {
      const args = ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath];
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
