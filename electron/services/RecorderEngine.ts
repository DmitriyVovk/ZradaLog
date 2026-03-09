import { EventEmitter } from 'events';
import { LoggerService } from './LoggerService';
import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import { app, dialog } from 'electron';

export type RecorderState = 'idle' | 'recording' | 'paused' | 'stopped';

export class RecorderEngine extends EventEmitter {
  private logger: LoggerService;
  private state: RecorderState = 'idle';
  private segmentIntervalSec: number = 300; // default 5 minutes
  private fps: number = 1;
  private ff?: ChildProcessWithoutNullStreams;
  private segmentsDir: string;
  private segments: string[] = [];
  private codec = 'libx264';
  private crf = 23;

  constructor(logger: LoggerService) {
    super();
    this.logger = logger;
    const userData = app.getPath('userData');
    this.segmentsDir = path.join(userData, 'segments');
    if (!fs.existsSync(this.segmentsDir)) fs.mkdirSync(this.segmentsDir, { recursive: true });
    this.logger.info('RecorderEngine initialized', { segmentsDir: this.segmentsDir });
  }

  public setSegmentInterval(seconds: number) {
    this.segmentIntervalSec = seconds;
    this.logger.debug('Segment interval set', { seconds });
  }

  public setFps(fps: number) {
    this.fps = fps;
    this.logger.debug('FPS set', { fps });
  }

  public getSegments() {
    try { return fs.readdirSync(this.segmentsDir).map(f => path.join(this.segmentsDir, f)).sort(); }
    catch { return []; }
  }

  private buildFfmpegArgs(outPattern: string, startNumber = 0) {
    // Using gdigrab for Windows screen capture. Assumes ffmpeg is available.
    const args: string[] = [
      '-y',
      '-f', 'gdigrab',
      '-framerate', String(this.fps),
      '-i', 'desktop',
      '-c:v', this.codec,
      '-preset', 'veryfast',
      '-crf', String(this.crf),
      '-g', String(Math.max(2, this.fps * 2)),
      '-f', 'segment',
      '-reset_timestamps', '1',
      '-segment_time', String(this.segmentIntervalSec),
      '-segment_start_number', String(startNumber),
      outPattern
    ];
    return args;
  }

  private computeNextIndex(fileNames: string[]) {
    let max = -1;
    for (const name of fileNames) {
      const m = name.match(/segment_(\d+)\.mp4$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!isNaN(n) && n > max) max = n;
      }
    }
    return max + 1;
  }

  public start() {
    if (this.state === 'recording') return;
    // ensure segments dir exists
    if (!fs.existsSync(this.segmentsDir)) fs.mkdirSync(this.segmentsDir, { recursive: true });
    const outPattern = path.join(this.segmentsDir, 'segment_%04d.mp4');

    // quick check: is ffmpeg available in PATH?
    try {
      const check = spawnSync('ffmpeg', ['-version'], { windowsHide: true });
      if (check.error || check.status !== 0) {
        const msg = 'FFmpeg not found in PATH. Please install FFmpeg and ensure ffmpeg.exe is available in your PATH.';
        this.logger.error('ffmpeg missing', { err: check.error ? check.error.message : `status=${check.status}` });
        try {
          dialog.showMessageBoxSync({
            type: 'error',
            title: 'FFmpeg not found',
            message: 'FFmpeg executable not found',
            detail: msg + "\n\nRecommended: download from https://ffmpeg.org/download.html or install via Chocolatey: `choco install ffmpeg`",
          });
        } catch (_) {}
        this.emit('error', new Error('ffmpeg not found'));
        return;
      }
    } catch (err: any) {
      this.logger.error('ffmpeg detection failed', { err: err?.message });
      this.emit('error', err);
      return;
    }

    const existing = this.getSegments();
    const existingFiles = existing.map(f => path.basename(f));
    this.logger.debug('Existing segments before start', { count: existing.length, files: existingFiles });
    const nextIndex = this.computeNextIndex(existingFiles);

    const args = this.buildFfmpegArgs(outPattern, nextIndex);
    this.logger.info('Spawning ffmpeg', { args, startIndex: nextIndex });

    this.ff = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    this.state = 'recording';
    this.logger.info('Recording started');
    this.emit('started');

    this.ff.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      this.logger.debug('ffmpeg', { stderr: s });
      // detect new segment creation
      const m = /Opening '(.+segment_\d+\.mp4)' for writing/.exec(s) || /Opening '(.+segment_\d+\.mp4)'/.exec(s);
      if (m && m[1]) {
        const file = m[1];
        const abs = path.isAbsolute(file) ? file : path.join(this.segmentsDir, path.basename(file));
        this.segments.push(abs);
        this.logger.info('Segment created', { file: abs });
        this.emit('segment', abs);
      }
    });

    this.ff.on('close', (code) => {
      this.logger.info('ffmpeg exited', { code });
      // if recording, treat that as stopped
      if (this.state === 'recording') {
        this.state = 'stopped';
        this.emit('stopped');
      }
      this.ff = undefined;
    });

    this.ff.on('error', (err) => {
      this.logger.error('ffmpeg error', { err: (err as any).message });
      this.emit('error', err);
    });
  }

  public pause() {
    if (this.state !== 'recording') return;
    // stop ffmpeg gracefully by sending 'q' to stdin
    if (this.ff && this.ff.stdin.writable) {
      try { this.ff.stdin.write('q'); } catch (_) {}
    }
    this.state = 'paused';
    this.logger.info('Recording paused');
    this.emit('paused');
  }

  public resume() {
    if (this.state !== 'paused') return;
    // resume by starting a new ffmpeg process (creates new segment files)
    this.start();
    this.logger.info('Recording resumed');
    this.emit('resumed');
  }

  public stop() {
    if (this.state === 'idle' || this.state === 'stopped') return;
    if (this.ff && this.ff.stdin.writable) {
      try { this.ff.stdin.write('q'); } catch (_) {}
    }
    this.state = 'stopped';
    this.logger.info('Recording stopped');
    this.emit('stopped');
  }

  public getState() {
    return this.state;
  }
}

export default RecorderEngine;
