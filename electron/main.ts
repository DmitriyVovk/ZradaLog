import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import os from 'os';
import { LoggerService } from './services/LoggerService';
import { RecorderEngine } from './services/RecorderEngine';

let mainWindow: BrowserWindow | null = null;
let logger: LoggerService;
let recorder: RecorderEngine | null = null;
let rendererReady = false;
const pendingLogs: any[] = [];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const devUrl = 'http://localhost:5173';
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  const logDir = path.join(userData, 'logs');
  logger = new LoggerService(logDir);

  // forward logs to renderer (buffer until renderer ready)
  logger.on('log', (entry) => {
    if (rendererReady && mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('zrada:log', entry);
    } else {
      pendingLogs.push(entry);
    }
  });

  createWindow();
  // create recorder engine and wire events
  recorder = new RecorderEngine(logger);
  recorder.on('started', () => {
    logger.info('Recorder state', { state: recorder?.getState() });
    if (rendererReady && mainWindow) mainWindow.webContents.send('zrada:recorder-state', recorder?.getState());
  });
  recorder.on('paused', () => {
    logger.info('Recorder state', { state: recorder?.getState() });
    if (rendererReady && mainWindow) mainWindow.webContents.send('zrada:recorder-state', recorder?.getState());
  });
  recorder.on('resumed', () => {
    logger.info('Recorder state', { state: recorder?.getState() });
    if (rendererReady && mainWindow) mainWindow.webContents.send('zrada:recorder-state', recorder?.getState());
  });
  recorder.on('stopped', () => {
    logger.info('Recorder state', { state: recorder?.getState() });
    if (rendererReady && mainWindow) mainWindow.webContents.send('zrada:recorder-state', recorder?.getState());
  });
  // now emit startup info (after window created and forwarder registered)
  logger.info('App starting', { platform: os.platform() });
  // welcome + structured startup info
  logger.info('Welcome to ZradaLog', { message: 'ZradaLog started' });

  const startupConfig = {
    fps: 1,
    segmentIntervalSec: 300,
    codec: 'libx264',
    crf: 23,
    maxDurationSec: 8 * 3600,
    maxSizeBytes: 5 * 1024 * 1024 * 1024
  };
  logger.info('Default configuration', startupConfig);

  const sysInfo = {
    platform: os.platform(),
    arch: os.arch(),
    cpuCount: os.cpus().length,
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    nodeVersion: process.version,
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    appVersion: app.getVersion(),
    userDataPath: app.getPath('userData')
  };
  logger.info('System info', sysInfo);

  // listen for renderer readiness signal and flush pending logs
  ipcMain.on('zrada:renderer-ready', () => {
    rendererReady = true;
    if (mainWindow && mainWindow.webContents) {
      for (const e of pendingLogs) mainWindow.webContents.send('zrada:log', e);
      pendingLogs.length = 0;
    }
  });

  ipcMain.on('zrada:log:fromRenderer', (_ev, payload) => {
    const { level, message, meta } = payload;
    // write to main logger
    (logger as LoggerService).log(level, message, meta);
  });

  // control messages from renderer (start/pause/resume/stop)
  ipcMain.on('zrada:control', (_ev, action: string) => {
    if (!recorder) return;
    switch (action) {
      case 'start': recorder.start(); break;
      case 'pause': recorder.pause(); break;
      case 'resume': recorder.resume(); break;
      case 'stop': recorder.stop(); break;
    }
  });

  ipcMain.handle('zrada:get-state', () => {
    return recorder ? recorder.getState() : 'idle';
  });

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  logger && logger.close();
  if (process.platform !== 'darwin') app.quit();
});
