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
  subscribeState: (cb: (state: string) => void) => {
    const handler = (_ev: IpcRendererEvent, state: string) => cb(state);
    ipcRenderer.on('zrada:recorder-state', handler);
    return () => ipcRenderer.removeListener('zrada:recorder-state', handler);
  }
});

contextBridge.exposeInMainWorld('zradaFS', {
  openSegmentsFolder: () => ipcRenderer.invoke('zrada:open-segments')
});

contextBridge.exposeInMainWorld('zradaAdmin', {
  deleteAllFiles: () => ipcRenderer.invoke('zrada:delete-all'),
  clearLogs: () => ipcRenderer.invoke('zrada:clear-logs')
});

// Notify main that renderer is ready to receive logs
(globalThis as any).addEventListener?.('DOMContentLoaded', () => {
  try { ipcRenderer.send('zrada:renderer-ready'); } catch (_) {}
});
