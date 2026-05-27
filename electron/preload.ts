import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('zradaLogger', {
  subscribe: (cb: (entry: any) => void) => {
    const handler = (_ev: IpcRendererEvent, entry: any) => cb(entry);
    ipcRenderer.on('zrada:log', handler);
    return () => ipcRenderer.removeListener('zrada:log', handler);
  },
  send: (level: string, message: string, meta?: Record<string, any>) => {
    ipcRenderer.send('zrada:log:fromRenderer', { level, message, meta });
  }
});

contextBridge.exposeInMainWorld('zradaControls', {
  start: () => ipcRenderer.send('zrada:control', 'start'),
  pause: () => ipcRenderer.send('zrada:control', 'pause'),
  resume: () => ipcRenderer.send('zrada:control', 'resume'),
  stop: () => ipcRenderer.send('zrada:control', 'stop'),
  getState: () => ipcRenderer.invoke('zrada:get-state'),
  setFps: (fps: number) => ipcRenderer.invoke('zrada:set-fps', fps),
  getFps: () => ipcRenderer.invoke('zrada:get-fps'),
  setMode: (mode: 'video' | 'image') => ipcRenderer.invoke('zrada:set-mode', mode),
  getMode: () => ipcRenderer.invoke('zrada:get-mode'),
  setOutputFps: (fps: number) => ipcRenderer.invoke('zrada:set-output-fps', fps),
  getOutputFps: () => ipcRenderer.invoke('zrada:get-output-fps'),
  // dedup settings
  getDedupSettings: () => ipcRenderer.invoke('zrada:get-dedup-settings'),
  setDedupSettings: (s: any) => ipcRenderer.invoke('zrada:set-dedup-settings', s),
  // mpdecimate settings (hi, lo, frac)
  getMpdecimate: () => ipcRenderer.invoke('zrada:get-mpdecimate'),
  setMpdecimate: (s: any) => ipcRenderer.invoke('zrada:set-mpdecimate', s),
  previewDedupScan: (opts: any) => ipcRenderer.invoke('zrada:preview-dedup-scan', opts),
  getSettings: () => ipcRenderer.invoke('zrada:get-settings'),
  setSettings: (s: any) => ipcRenderer.invoke('zrada:set-settings', s),
  checkActiveCaptureProcesses: () => ipcRenderer.invoke('zrada:check-active-capture-processes'),
  subscribeStartBlocked: (cb: (payload: any) => void) => {
    const handler = (_ev: IpcRendererEvent, payload: any) => cb(payload);
    ipcRenderer.on('zrada:start-blocked', handler);
    return () => ipcRenderer.removeListener('zrada:start-blocked', handler);
  },
  subscribeState: (cb: (state: string) => void) => {
    const handler = (_ev: IpcRendererEvent, state: string) => cb(state);
    ipcRenderer.on('zrada:recorder-state', handler);
    return () => ipcRenderer.removeListener('zrada:recorder-state', handler);
  }
});

// dedup fallback notifications
contextBridge.exposeInMainWorld('zradaAlerts', {
  subscribeDedupFallback: (cb: (payload: any) => void) => {
    const handler = (_ev: IpcRendererEvent, payload: any) => cb(payload);
    ipcRenderer.on('zrada:dedup-fallback', handler);
    return () => ipcRenderer.removeListener('zrada:dedup-fallback', handler);
  }
});

// frame events (used/skipped) from main
contextBridge.exposeInMainWorld('zradaFrames', {
  subscribe: (cb: (entry: any) => void) => {
    const handler = (_ev: IpcRendererEvent, entry: any) => cb(entry);
    ipcRenderer.on('zrada:frame', handler);
    return () => ipcRenderer.removeListener('zrada:frame', handler);
  }
  ,
  getRecent: (n = 8) => ipcRenderer.invoke('zrada:get-recent-frames', n)
});

// subscribe to candidate events (immediate used/skipped decisions)
contextBridge.exposeInMainWorld('zradaCandidates', {
  subscribe: (cb: (entry: any) => void) => {
    const handler = (_ev: IpcRendererEvent, entry: any) => cb(entry);
    ipcRenderer.on('zrada:frame-candidate', handler);
    return () => ipcRenderer.removeListener('zrada:frame-candidate', handler);
  },
  // saved count helpers
  getSavedCount: () => ipcRenderer.invoke('zrada:get-saved-count'),
  subscribeSavedCount: (cb: (count: any) => void) => {
    const handler = (_ev: IpcRendererEvent, payload: any) => cb(payload);
    ipcRenderer.on('zrada:saved-count', handler);
    return () => ipcRenderer.removeListener('zrada:saved-count', handler);
  }
});

contextBridge.exposeInMainWorld('zradaFS', {
  openOutputFolder: () => ipcRenderer.invoke('zrada:open-output')
});

contextBridge.exposeInMainWorld('zradaAdmin', {
  deleteAllFiles: () => ipcRenderer.invoke('zrada:delete-all'),
  mergeAll: () => ipcRenderer.invoke('zrada:merge-all'),
  checkSegments: () => ipcRenderer.invoke('zrada:check-segments'),
  clearLogs: () => ipcRenderer.invoke('zrada:clear-logs')
});

// Notify main that renderer is ready to receive logs
(globalThis as any).addEventListener?.('DOMContentLoaded', () => {
  try { ipcRenderer.send('zrada:renderer-ready'); } catch (_) {}
});
