import React from 'react';
import RecordingControls from './components/controls/RecordingControls';
import ModeControls from './components/controls/ModeControls';
import FileControls from './components/controls/FileControls';
import LogControls from './components/controls/LogControls';

type LogEntry = {
  ts: string;
  level: string;
  message: string;
  meta?: Record<string, any>;
};

export const App: React.FC = () => {
  const [state, setState] = React.useState<string>('idle');
  const [fps, setFps] = React.useState<number>(1);
  const [mode, setMode] = React.useState<'video' | 'image'>('image');
  const [outputFps, setOutputFps] = React.useState<number>(24);
  const [activeTab, setActiveTab] = React.useState<'recording'|'files'|'logs'>('recording');
  const [logs, setLogs] = React.useState<LogEntry[]>([]);

  React.useEffect(() => {
    const init = async () => {
      const s = (window as any).zradaControls?.getState?.() ?? 'idle';
      const resolved = typeof s === 'string' ? s : await s;
      setState(resolved);

      try {
        const g = (window as any).zradaControls?.getFps?.();
        const got = typeof g === 'number' ? g : await g;
        const v = got?.fps ?? got ?? 1;
        setFps(Number(v) || 1);
      } catch (_) { setFps(1); }

      try {
        const m = (window as any).zradaControls?.getMode?.();
        const rm = (typeof m === 'string') ? m : (await m)?.mode;
        if (rm === 'image' || rm === 'video') setMode(rm);
      } catch (_) {}

      try {
        const of = (window as any).zradaControls?.getOutputFps?.();
        const ro = (typeof of === 'number') ? of : (await of)?.fps;
        if (typeof ro === 'number') setOutputFps(Number(ro) || 24);
      } catch (_) {}

      const unsub = (window as any).zradaControls?.subscribeState?.((st: string) => setState(st));
      return () => { if (typeof unsub === 'function') unsub(); };
    };
    init();
  }, []);

  // Subscribe to logs globally
  React.useEffect(() => {
    if (!(window as any).zradaLogger) return;
    const unsub = (window as any).zradaLogger.subscribe((entry: LogEntry) => {
      setLogs((s) => {
        const next = [entry, ...s];
        if (next.length > 500) next.length = 500; // keep newest 500
        return next;
      });
    });
    return () => unsub && unsub();
  }, []);

  const clearLogs = () => setLogs([]);

  // Handlers passed to controls
  const handleStartPauseToggle = () => {
    try {
      const api = (window as any).zradaControls;
      if (!api) return;
      if (state === 'recording') api.pause?.();
      else if (state === 'paused') api.resume?.();
      else api.start?.();
    } catch (e) { /* ignore */ }
  };
  const handleStop = () => (window as any).zradaControls?.stop?.();

  const setModeAndPersist = async (m: 'video'|'image') => {
    setMode(m);
    try { await (window as any).zradaControls?.setMode?.(m); } catch (err) { /* ignore */ }
  };
  const setFpsAndPersist = async (v: number) => {
    setFps(v);
    try { await (window as any).zradaControls?.setFps?.(v); } catch (err) { /* ignore */ }
  };
  const setOutputFpsAndPersist = async (v: number) => {
    setOutputFps(v);
    try { await (window as any).zradaControls?.setOutputFps?.(v); } catch (err) { /* ignore */ }
  };

  const tabStyle: React.CSSProperties = { padding:12, cursor:'pointer' };
  const activeTabStyle: React.CSSProperties = { background:'#1f6feb', color:'#fff' };

  return (
    <div style={{display:'flex', height:'100vh', fontFamily:'Segoe UI, Roboto, sans-serif'}}>
      <aside style={{width:220, background:'#0f1720', color:'#cfe', padding:10, boxSizing:'border-box', display:'flex', flexDirection:'column'}}>
        <div style={{fontWeight:700, marginBottom:12}}>ZradaLog</div>
        <div role="tablist" aria-orientation="vertical" style={{display:'flex', flexDirection:'column', gap:6}}>
          <div role="tab" aria-selected={activeTab==='recording'} onClick={() => setActiveTab('recording')} style={{...tabStyle, ...(activeTab==='recording'?activeTabStyle:{})}}>Record</div>
          <div role="tab" aria-selected={activeTab==='files'} onClick={() => setActiveTab('files')} style={{...tabStyle, ...(activeTab==='files'?activeTabStyle:{})}}>Files</div>
          <div role="tab" aria-selected={activeTab==='logs'} onClick={() => setActiveTab('logs')} style={{...tabStyle, ...(activeTab==='logs'?activeTabStyle:{})}}>Logs</div>
        </div>
        
      </aside>

      <section style={{flex:1, padding:16, display:'flex', flexDirection:'column', overflow:'auto'}}>
        <div style={{borderBottom:'1px solid #eee', paddingBottom:8, marginBottom:12, display:'flex', justifyContent:'space-between', alignItems:'center'}}>
          <h1 style={{margin:0, fontSize:18, fontWeight:600}}>{activeTab[0].toUpperCase()+activeTab.slice(1)}</h1>
        </div>

        <div style={{flex:1, overflow:'auto'}}>
          {activeTab === 'recording' && (
            <div style={{display:'flex', flexDirection:'column', gap:12}}>
              <div style={{minWidth:360}}>
                <RecordingControls state={state} onStart={handleStartPauseToggle} onStop={handleStop} />
              </div>
              <div style={{minWidth:360}}>
                <ModeControls mode={mode} setMode={setModeAndPersist} fps={fps} setFps={setFpsAndPersist} outputFps={outputFps} setOutputFps={setOutputFpsAndPersist} />
              </div>
            </div>
          )}
          {activeTab === 'files' && <FileControls />}
          {activeTab === 'logs' && <LogControls logs={logs} onClearLogs={clearLogs} />}
        </div>
      </section>
    </div>
  );
};

export default App;
