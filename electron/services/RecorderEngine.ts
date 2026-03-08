import { EventEmitter } from 'events';
import { LoggerService } from './LoggerService';

export type RecorderState = 'idle' | 'recording' | 'paused' | 'stopped';

export class RecorderEngine extends EventEmitter {
  private logger: LoggerService;
  private state: RecorderState = 'idle';
  private segmentIntervalSec: number = 300; // default 5 minutes

  constructor(logger: LoggerService) {
    super();
    this.logger = logger;
    this.logger.info('RecorderEngine initialized');
  }

  public setSegmentInterval(seconds: number) {
    this.segmentIntervalSec = seconds;
    this.logger.debug('Segment interval set', { seconds });
  }

  public start() {
    if (this.state === 'recording') return;
    this.state = 'recording';
    this.logger.info('Recording started');
    // TODO: wire up desktopCapturer -> frames -> ffmpeg pipe
    // For now emit fake segment events periodically for testing.
    this.emit('started');
  }

  public pause() {
    if (this.state !== 'recording') return;
    this.state = 'paused';
    this.logger.info('Recording paused');
    this.emit('paused');
  }

  public resume() {
    if (this.state !== 'paused') return;
    this.state = 'recording';
    this.logger.info('Recording resumed');
    this.emit('resumed');
  }

  public stop() {
    if (this.state === 'idle' || this.state === 'stopped') return;
    this.state = 'stopped';
    this.logger.info('Recording stopped');
    this.emit('stopped');
  }

  public getState() {
    return this.state;
  }
}

export default RecorderEngine;
