import fs from 'fs';
import path from 'path';
import { LoggerService } from './LoggerService';

export class SegmentManager {
  private segments: string[] = [];
  private baseDir: string;
  private logger: LoggerService;

  constructor(baseDir: string, logger: LoggerService) {
    this.baseDir = baseDir;
    this.logger = logger;
    if (!fs.existsSync(this.baseDir)) fs.mkdirSync(this.baseDir, { recursive: true });
  }

  public addSegment(tmpPath: string) {
    const name = path.basename(tmpPath);
    const dest = path.join(this.baseDir, name);
    try {
      fs.renameSync(tmpPath, dest);
      this.segments.push(dest);
      this.logger.info('Segment added', { path: dest });
      return dest;
    } catch (e) {
      this.logger.error('Failed to move segment', { tmpPath, err: (e as Error).message });
      throw e;
    }
  }

  public listSegments() {
    return [...this.segments];
  }

  public clear() {
    this.segments = [];
  }
}

export default SegmentManager;
