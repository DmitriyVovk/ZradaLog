import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { spawn, execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { LoggerService } from './services/LoggerService';
import { RecorderEngine } from './services/RecorderEngine';
import { MergerService } from './services/MergerService';

let mainWindow: BrowserWindow | null = null;
let logger: LoggerService;
let recorder: RecorderEngine | null = null;
let merger: MergerService | null = null;
let rendererReady = false;
const pendingLogs: any[] = [];
let outputFps = 24;
// persisted settings path
const settingsPath = path.join(app.getPath('userData') || '.', 'settings.json');
let settingsCache: any = null;
let dedupSettings: { algorithm: string; threshold: number } = { algorithm: 'phash', threshold: 12 };

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      settingsCache = JSON.parse(raw || '{}');
    } else {
      settingsCache = {};
    }
  } catch (e) {
    settingsCache = {};
  }
  return settingsCache;
}

function saveSettings() {
  try {
    settingsCache = settingsCache || {};
    settingsCache.dedupSettings = dedupSettings;
    settingsCache.outputFps = outputFps;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settingsCache, null, 2), 'utf8');
    logger && logger.info && logger.info('Settings saved', { path: settingsPath });
    return { ok: true };
  } catch (e: any) {
    logger && logger.error && logger.error('Save settings failed', { err: e?.message });
    return { ok: false, err: e?.message };
  }
}

function checkActiveCaptureProcesses() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
      const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const matches: Array<{ image: string; pid: number; raw: string }> = [];
      for (const line of lines) {
        // CSV: "Image Name","PID","Session Name","Session#","Mem Usage"
        const parts = line.split(/","|","/).map(p => p.replace(/^"|"$/g, ''));
        const img = parts[0] || '';
        const pid = Number(parts[1] || 0) || 0;
        if (/ffmpeg/i.test(img)) matches.push({ image: img, pid, raw: line });
      }
      return matches;
    } else {
      // fallback: ps on *nix
      try {
        const out = execFileSync('ps', ['-axo', 'pid,comm,args'], { encoding: 'utf8' });
        const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const matches: Array<{ image: string; pid: number; raw: string }> = [];
        for (const line of lines.slice(1)) {
          if (/ffmpeg/i.test(line)) {
            const parts = line.trim().split(/\s+/);
            const pid = Number(parts[0] || 0) || 0;
            matches.push({ image: parts[1] || 'ffmpeg', pid, raw: line });
          }
        }
        return matches;
      } catch (_) { return []; }
    }
  } catch (e) {
    return [];
  }
}

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
  // load persisted settings if any
  try {
    const loaded = loadSettings() || {};
    if (loaded.outputFps) outputFps = Number(loaded.outputFps) || outputFps;
    if (loaded.dedupSettings) {
      dedupSettings.algorithm = loaded.dedupSettings.algorithm ?? dedupSettings.algorithm;
      dedupSettings.threshold = typeof loaded.dedupSettings.threshold === 'number' ? loaded.dedupSettings.threshold : dedupSettings.threshold;
    }
    logger.info('Loaded persisted settings', { outputFps, dedupSettings });
  } catch (_) {}
  // create recorder engine and wire events
  recorder = new RecorderEngine(logger);
  merger = new MergerService(logger);
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
    // automatic merge on STOP
    try {
      const segs = recorder?.getSegments() || [];
      if (segs.length > 0 && merger) {
        const outDir = path.join(app.getPath('userData'), 'output');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, formatNowForFilename());
        logger.info('Auto-merge triggered on stop', { count: segs.length, outPath });
        // obtain recorder FPS
        let inputFpsRaw: any = 1;
        try { inputFpsRaw = recorder?.getFps?.(); } catch (_) { inputFpsRaw = 1; }
        let resolvedInputFps = 1;
        if (typeof inputFpsRaw === 'number') resolvedInputFps = inputFpsRaw;
        else if (inputFpsRaw && typeof inputFpsRaw === 'object' && 'fps' in inputFpsRaw) resolvedInputFps = Number((inputFpsRaw as any).fps) || 1;
        else resolvedInputFps = 1;

        // If recorder is in image mode, assemble images into a video
        try {
          const mode = (recorder as any).getMode ? (recorder as any).getMode() : 'video';
          if (mode === 'image') {
            // assume images are in segments/images/img_%06d.jpg
            const imagesPattern = path.join(app.getPath('userData'), 'segments', 'images', 'img_%06d.jpg');
            const args = ['-y', '-framerate', String(outputFps), '-i', imagesPattern, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outPath];
            logger.info('Assembling images to video', { args });
            const ff = spawn('ffmpeg', args, { windowsHide: true });
            ff.stderr.on('data', (c) => logger.debug('ffmpeg', { stderr: c.toString() }));
            ff.on('close', (code) => {
              if (code === 0) {
                logger.info('Image-assemble finished', { outPath });
                if (rendererReady && mainWindow) mainWindow.webContents.send('zrada:merge-done', outPath);
                // cleanup images
                try {
                  const imgDir = path.join(app.getPath('userData'), 'segments', 'images');
                  if (fs.existsSync(imgDir)) {
                    const files = fs.readdirSync(imgDir);
                    for (const f of files) { try { fs.unlinkSync(path.join(imgDir, f)); } catch (_) {} }
                    logger.info('Images cleaned after assemble', { cleaned: files.length });
                    if (rendererReady && mainWindow) mainWindow.webContents.send('zrada:segments-cleaned');
                  }
                } catch (e: any) { logger.error('Images cleanup failed', { err: e?.message }); }
              } else {
                logger.error('Image assemble failed', { code });
                if (rendererReady && mainWindow) mainWindow.webContents.send('zrada:merge-error', `ffmpeg exit ${code}`);
              }
            });
          } else {
            // default: use MergerService for video segments
            merger.mergeSegments(segs, outPath, { inputFps: resolvedInputFps, outputFps: 30 }).then(() => {
              logger.info('Auto-merge finished', { outPath });
              if (rendererReady && mainWindow) mainWindow.webContents.send('zrada:merge-done', outPath);
              // delete segments after successful merge
              try {
                for (const s of segs) { try { fs.unlinkSync(s); } catch (_) {} }
                logger.info('Segments cleaned after merge', { cleaned: segs.length });
                if (rendererReady && mainWindow) mainWindow.webContents.send('zrada:segments-cleaned');
              } catch (e: any) { logger.error('Segment cleanup failed', { err: e?.message }); }
            }).catch((err) => {
              logger.error('Auto-merge failed', { err: err.message });
              if (rendererReady && mainWindow) mainWindow.webContents.send('zrada:merge-error', err.message);
            });
          }
        } catch (e: any) { logger.error('Auto-merge handler failed', { err: e?.message }); }
      }
    } catch (e: any) {
      logger.error('Auto-merge error', { err: e?.message });
    }
  });
  // forward image/segment events and provide simple used/skip heuristic
  let lastImageSize: number | null = null;
  const recentFrames: Array<{ file: string; size: number; status: string; ts: string }> = [];
  recorder.on('image', (filePath: string) => {
    try {
      let status = 'used';
      let size = 0;
      try { const st = fs.statSync(filePath); size = st.size; } catch (_) { size = 0; }
      if (lastImageSize !== null && lastImageSize > 0 && size > 0) {
        const diff = Math.abs(size - lastImageSize);
        const ratio = diff / Math.max(size, lastImageSize);
        // if size very similar (within 2%) treat as skipped candidate
        if (ratio <= 0.02) status = 'skipped';
      }
      lastImageSize = size || lastImageSize;
      logger.debug('Image event', { filePath, size, status });
      // keep small in-memory buffer for renderer to query
      try {
        recentFrames.push({ file: filePath, size: size || 0, status, ts: new Date().toISOString() });
        if (recentFrames.length > 64) recentFrames.shift();
      } catch (_) {}
      logger.info('Forwarding frame to renderer', { file: filePath, size, status });
      if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('zrada:frame', { file: filePath, size, status });
    } catch (e: any) { logger.error('Forward image event failed', { err: e?.message }); }
  });
  recorder.on('segment', (filePath: string) => {
    try {
      if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('zrada:segment', { file: filePath });
    } catch (e: any) { logger.error('Forward segment event failed', { err: e?.message }); }
  });

  ipcMain.handle('zrada:get-recent-frames', () => {
    try {
      return { ok: true, frames: recentFrames.slice(-16) };
    } catch (e: any) {
      logger.error('Get recent frames failed', { err: e?.message });
      return { ok: false, err: e?.message };
    }
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
      case 'start': {
        try {
          const active = checkActiveCaptureProcesses();
          if (active && active.length > 0) {
            logger.warn('Start blocked: active capture processes detected', { count: active.length });
            if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('zrada:start-blocked', { procs: active });
            return;
          }
        } catch (e: any) { logger.error('Start pre-check failed', { err: e?.message }); }
        recorder.start();
        break;
      }
      case 'pause': recorder.pause(); break;
      case 'resume': recorder.resume(); break;
      case 'stop': recorder.stop(); break;
    }
  });

  ipcMain.handle('zrada:get-state', () => {
    return recorder ? recorder.getState() : 'idle';
  });

  ipcMain.handle('zrada:set-fps', (_ev, fps: number) => {
    try {
      const v = Number(fps) || 1;
      recorder?.setFps(v);
      logger.info('FPS set via IPC', { fps: v });
      return { ok: true, fps: v };
    } catch (e: any) {
      logger.error('Set FPS failed', { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle('zrada:get-fps', () => {
    try {
      const v = recorder ? recorder.getFps() : 1;
      return { ok: true, fps: v };
    } catch (e: any) {
      logger.error('Get FPS failed', { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle('zrada:open-segments', async () => {
    try {
      const dir = path.join(app.getPath('userData'), 'segments');
      // ensure exists
      const fs = require('fs');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      await shell.openPath(dir);
      return { ok: true, dir };
    } catch (e: any) {
      logger.error('Open segments folder failed', { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle('zrada:delete-all', async () => {
    try {
      const segDir = path.join(app.getPath('userData'), 'segments');
      let deleted = 0;
      if (fs.existsSync(segDir)) {
        const items = fs.readdirSync(segDir);
        for (const it of items) {
          const p = path.join(segDir, it);
          try {
            const st = fs.statSync(p);
            if (st.isFile()) { try { fs.unlinkSync(p); deleted++; } catch (_) {} }
            else if (st.isDirectory()) {
              const inner = fs.readdirSync(p);
              for (const f of inner) { try { fs.unlinkSync(path.join(p, f)); deleted++; } catch (_) {} }
            }
          } catch (_) {}
        }
      }
      logger.info('Deleted segment files', { deleted });
      return { ok: true, deleted };
    } catch (e: any) {
      logger.error('Delete all failed', { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle('zrada:set-output-fps', (_ev, fps: number) => {
    try {
      const v = Number(fps) || 24;
      outputFps = v;
      logger.info('Output FPS set via IPC', { outputFps: v });
      try { settingsCache = settingsCache || {}; settingsCache.outputFps = outputFps; saveSettings(); } catch (_) {}
      return { ok: true, fps: v };
    } catch (e: any) {
      logger.error('Set output FPS failed', { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle('zrada:get-output-fps', () => {
    try {
      return { ok: true, fps: outputFps };
    } catch (e: any) {
      logger.error('Get output FPS failed', { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle('zrada:set-mode', (_ev, mode: 'video' | 'image') => {
    try {
      recorder?.setMode(mode);
      logger.info('Recorder mode set via IPC', { mode });
      try { settingsCache = settingsCache || {}; settingsCache.mode = mode; saveSettings(); } catch (_) {}
      return { ok: true, mode };
    } catch (e: any) {
      logger.error('Set mode failed', { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });
  ipcMain.handle('zrada:get-dedup-settings', () => {
    return { ok: true, settings: dedupSettings };
  });
  ipcMain.handle('zrada:set-dedup-settings', (_ev, s: any) => {
    try {
      dedupSettings.algorithm = s?.algorithm ?? dedupSettings.algorithm;
      dedupSettings.threshold = typeof s?.threshold === 'number' ? s.threshold : dedupSettings.threshold;
      logger.info('Dedup settings updated', dedupSettings);
      try { settingsCache = settingsCache || {}; settingsCache.dedupSettings = dedupSettings; saveSettings(); } catch (_) {}
      return { ok: true, settings: dedupSettings };
    } catch (e: any) {
      logger.error('Set dedup settings failed', { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle('zrada:get-settings', () => {
    try {
      const s = loadSettings() || {};
      return { ok: true, settings: s };
    } catch (e: any) {
      logger.error('Get settings failed', { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle('zrada:preview-dedup-scan', async (_ev, opts: any) => {
    try {
      const sampleN = Number(opts?.sampleN) || 200;
      const alg = opts?.algorithm ?? dedupSettings.algorithm;
      const thr = Number(opts?.threshold ?? dedupSettings.threshold) || dedupSettings.threshold;
      const imagesDir = path.join(app.getPath('userData'), 'segments', 'images');
      if (!fs.existsSync(imagesDir)) return { ok: true, total: 0, kept: 0, discarded: 0 };
      const files = fs.readdirSync(imagesDir).filter(f => /\.(jpe?g|png)$/i.test(f)).sort();
      const sample = files.slice(Math.max(0, files.length - sampleN));

      // Simple heuristic: group by file size to approximate duplicates
      const groups: Record<number, string[]> = {};
      for (const f of sample) {
        try {
          const st = fs.statSync(path.join(imagesDir, f));
          const k = Math.round(st.size / 100); // coarse bucket
          groups[k] = groups[k] || [];
          groups[k].push(f);
        } catch (_) {}
      }
      let kept = 0;
      let discarded = 0;
      for (const k of Object.keys(groups)) {
        const arr = groups[Number(k)];
        if (arr.length > 0) { kept += 1; discarded += arr.length - 1; }
      }
      const total = sample.length;
      logger.info('Preview dedup scan', { algorithm: alg, threshold: thr, total, kept, discarded });
      return { ok: true, algorithm: alg, threshold: thr, total, kept, discarded, status: 'done' };
    } catch (e: any) {
      logger.error('Preview dedup scan failed', { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle('zrada:check-active-capture-processes', () => {
    try {
      const procs = checkActiveCaptureProcesses();
      return { ok: true, procs };
    } catch (e: any) {
      logger.error('Check active capture processes failed', { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle('zrada:set-settings', (_ev, s: any) => {
    try {
      settingsCache = settingsCache || {};
      settingsCache = { ...settingsCache, ...(s || {}) };
      if (s?.dedupSettings) {
        dedupSettings = { ...dedupSettings, ...s.dedupSettings };
      }
      if (s?.outputFps) outputFps = Number(s.outputFps) || outputFps;
      saveSettings();
      return { ok: true, settings: settingsCache };
    } catch (e: any) {
      logger.error('Set settings failed', { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle('zrada:get-mode', () => {
    try {
      const m = recorder?.getMode ? recorder.getMode() : 'video';
      return { ok: true, mode: m };
    } catch (e: any) {
      logger.error('Get mode failed', { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle('zrada:clear-logs', async () => {
    try {
      (logger as LoggerService).clear();
      return { ok: true };
    } catch (e: any) {
      logger.error('Clear logs failed', { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

function pad(n: number, w = 2) { return n.toString().padStart(w, '0'); }
function formatNowForFilename() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const MM = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  return `zradalog_${yyyy}_${MM}_${dd}_${hh}_${mm}.mp4`;
}

app.on('window-all-closed', () => {
  logger && logger.close();
  if (process.platform !== 'darwin') app.quit();
});
