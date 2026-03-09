import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogEntry {
  ts: string; // ISO
  level: LogLevel;
  message: string;
  meta?: Record<string, any>;
}

export class LoggerService extends EventEmitter {
  private dir: string;
  private stream: fs.WriteStream | null = null;
  private filePath: string;
  private maxFileSize = 10 * 1024 * 1024; // 10 MB rotation default

  constructor(logDir: string) {
    super();
    this.dir = logDir;
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    this.filePath = this.makeFilePath();
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
  }

  private makeFilePath() {
    const name = `zradalog_${new Date().toISOString().replace(/[:.]/g, '-')}.logl`;
    return path.join(this.dir, name);
  }

  private rotateIfNeeded() {
    try {
      if (!this.stream) return;
      const stats = fs.statSync(this.filePath);
      if (stats.size >= this.maxFileSize) {
        this.stream.end();
        this.filePath = this.makeFilePath();
        this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
        this.emit('rotated', this.filePath);
      }
    } catch (e) {
      // ignore stat errors
    }
  }

  private write(entry: LogEntry) {
    const line = JSON.stringify(entry) + '\n';
    if (this.stream) this.stream.write(line);
    this.emit('log', entry);
    this.rotateIfNeeded();
  }

  public log(level: LogLevel, message: string, meta?: Record<string, any>) {
    const entry: LogEntry = { ts: LoggerService.formatTimestamp(new Date()), level, message, meta };
    this.write(entry);
  }

  public info(msg: string, meta?: Record<string, any>) { this.log('info', msg, meta); }
  public warn(msg: string, meta?: Record<string, any>) { this.log('warn', msg, meta); }
  public error(msg: string, meta?: Record<string, any>) { this.log('error', msg, meta); }
  public debug(msg: string, meta?: Record<string, any>) { this.log('debug', msg, meta); }

  public close() {
    if (this.stream) this.stream.end();
    this.stream = null;
  }

  public clear() {
    try {
      if (this.stream) this.stream.end();
      const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.logl'));
      for (const f of files) {
        try { fs.unlinkSync(path.join(this.dir, f)); } catch (_) {}
      }
      this.filePath = this.makeFilePath();
      this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
      this.info('Logs cleared');
    } catch (e) {
      // ignore
    }
  }
}

export default LoggerService;

// Helper: format Date -> yyyy:mm:dd hh:mm:ss.mmm (local time)
export namespace LoggerService {
  export function pad(n: number, width = 2) { return n.toString().padStart(width, '0'); }
  export function formatTimestamp(d: Date) {
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const min = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    const ms = pad(d.getMilliseconds(), 3);
    return `${yyyy}:${mm}:${dd} ${hh}:${min}:${ss}.${ms}`;
  }
}
