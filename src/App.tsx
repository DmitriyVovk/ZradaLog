import React from 'react';
import LogWindow from './components/LogWindow';

export const App: React.FC = () => {
  const [state, setState] = React.useState<string>('idle');
  const [fps, setFps] = React.useState<number>(1);

  React.useEffect(() => {
    const init = async () => {
      // get current recorder state
      const s = (window as any).zradaControls?.getState?.() ?? 'idle';
      // getState may be a Promise
      const resolved = typeof s === 'string' ? s : await s;
      setState(resolved);
      // fetch current FPS
      try {
        const g = (window as any).zradaControls?.getFps?.();
        const got = typeof g === 'number' ? g : await g;
        const v = got?.fps ?? got ?? 1;
        setFps(Number(v) || 1);
      } catch (_) {
        setFps(1);
      }
      // subscribe to state changes
      const unsub = (window as any).zradaControls?.subscribeState?.((st: string) => setState(st));
      return () => { if (typeof unsub === 'function') unsub(); };
    };
    init();
  }, []);

  return (
    <div style={{display:'flex', flexDirection:'column', height:'100vh'}}>
      <header style={{padding:10, background:'#282c34', color:'#fff', display:'flex', alignItems:'center', justifyContent:'space-between'}}>
        <div>ZradaLog — Dev UI</div>
        <div style={{display:'flex', gap:8}}>
          <div style={{alignSelf:'center', color:'#9fd'}}>{state.toUpperCase()}</div>
          <div style={{display:'flex', alignItems:'center', gap:8}}>
            <label style={{color:'#9fd', fontSize:12}}>FPS</label>
            <input
              type="range"
              min={0.1}
              max={5}
              step={0.1}
              value={fps}
              onChange={async (e) => {
                const v = Number((e.target as HTMLInputElement).value);
                setFps(v);
                try {
                  await (window as any).zradaControls?.setFps?.(v);
                } catch (err) {
                  console.error('setFps failed', err);
                }
              }}
              style={{width:140}}
            />
            <div style={{color:'#9fd', minWidth:40, textAlign:'right'}}>{fps.toFixed(1)} fps</div>
          </div>
          <button onClick={() => (window as any).zradaControls?.start?.()}>Start</button>
          <button onClick={() => (window as any).zradaControls?.pause?.()}>Pause</button>
          <button onClick={() => (window as any).zradaControls?.resume?.()}>Resume</button>
          <button onClick={() => (window as any).zradaControls?.stop?.()}>Stop</button>
          <button onClick={async () => {
            const res = await (window as any).zradaFS?.openSegmentsFolder?.();
            if (!res?.ok) alert('Open folder failed: ' + (res?.err || 'unknown'));
          }}>Open segments folder</button>
          <button onClick={async () => {
            if (!confirm('Delete ALL segments and output files? This cannot be undone.')) return;
            const res = await (window as any).zradaAdmin?.deleteAllFiles?.();
            if (res?.ok) alert('Deleted files: ' + res.deleted);
            else alert('Delete failed: ' + (res?.err || 'unknown'));
          }}>Delete all files</button>
          <button onClick={async () => {
            if (!confirm('Clear logs?')) return;
            const res = await (window as any).zradaAdmin?.clearLogs?.();
            if (res?.ok) alert('Logs cleared'); else alert('Clear failed: ' + (res?.err || 'unknown'));
          }}>Clear logs</button>
        </div>
      </header>
      <main style={{padding:10, flex:1}}>
        <h3>Logs</h3>
        <LogWindow />
      </main>
    </div>
  );
};

export default App;
