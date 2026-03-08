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

// Notify main that renderer is ready to receive logs
(globalThis as any).addEventListener?.('DOMContentLoaded', () => {
  try { ipcRenderer.send('zrada:renderer-ready'); } catch (_) {}
});
