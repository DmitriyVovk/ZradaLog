import React from 'react';
import LogWindow from './components/LogWindow';

export const App: React.FC = () => {
  const [state, setState] = React.useState<string>('idle');
  const [fps, setFps] = React.useState<number>(1);
  const [mode, setMode] = React.useState<'video' | 'image'>('video');
  const [outputFps, setOutputFps] = React.useState<number>(24);

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
      // fetch current mode
      try {
        const m = (window as any).zradaControls?.getMode?.();
        const rm = (typeof m === 'string') ? m : (await m)?.mode;
        if (rm === 'image' || rm === 'video') setMode(rm);
      } catch (_) {}
      // fetch output fps
      try {
        const of = (window as any).zradaControls?.getOutputFps?.();
        const ro = (typeof of === 'number') ? of : (await of)?.fps;
        if (typeof ro === 'number') setOutputFps(Number(ro) || 24);
      } catch (_) {}
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
            <label style={{color:'#9fd', fontSize:12}}>Mode</label>
            <select value={mode} onChange={async (e) => {
              const v = (e.target as HTMLSelectElement).value as 'video'|'image';
              setMode(v);
              try { await (window as any).zradaControls?.setMode?.(v); } catch (err) { console.error('setMode failed', err); }
            }} style={{background:'#222',color:'#9fd',border:'1px solid #444',padding:'4px'}}>
              <option value="video">Video</option>
              <option value="image">Image</option>
            </select>
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
            <div style={{width:10}} />
            <label style={{color:'#9fd', fontSize:12}}>Out FPS</label>
            <input
              type="range"
              min={1}
              max={60}
              step={1}
              value={outputFps}
              onChange={async (e) => {
                const v = Number((e.target as HTMLInputElement).value);
                setOutputFps(v);
                try { await (window as any).zradaControls?.setOutputFps?.(v); } catch (err) { console.error('setOutputFps failed', err); }
              }}
              style={{width:140}}
            />
            <div style={{color:'#9fd', minWidth:48, textAlign:'right'}}>{outputFps} fps</div>
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
