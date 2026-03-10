import React from 'react';

export interface ModeControlsProps {
  mode: 'video'|'image';
  setMode: (m: 'video'|'image') => void;
  fps: number;
  setFps: (v: number) => void;
  outputFps: number;
  setOutputFps: (v: number) => void;
}

const ModeControls: React.FC<ModeControlsProps> = ({ mode, setMode, fps, setFps, outputFps, setOutputFps }) => {
  const [dedupAlg, setDedupAlg] = React.useState<'none' | 'phash' | 'ssim'>('phash');
  const [dedupThreshold, setDedupThreshold] = React.useState<number>(12);
  const [scanResult, setScanResult] = React.useState<any>(null);
  const [lastFrame, setLastFrame] = React.useState<{ file?: string; size?: number; status?: string } | null>(null);

  React.useEffect(() => {
    // subscribe to recent frames for indicator
    if ((window as any).zradaFrames?.subscribe) {
      const unsub = (window as any).zradaFrames.subscribe((entry: any) => {
        const s = (entry && entry.status && String(entry.status).toLowerCase()) === 'skipped' ? 'skipped' : 'used';
        setLastFrame({ file: entry?.file, size: entry?.size, status: s });
      });
      (async () => {
        try {
          const r = await (window as any).zradaFrames?.getRecent?.(8);
          if (r && r.ok && Array.isArray(r.frames) && r.frames.length > 0) {
            const last = r.frames[r.frames.length - 1];
            const s2 = last && String(last.status).toLowerCase() === 'skipped' ? 'skipped' : 'used';
            setLastFrame({ file: last.file, size: last.size, status: s2 });
          }
        } catch (_) {}
      })();
      return () => unsub && unsub();
    }
    // try to load persisted dedup settings from main process
    const load = async () => {
      try {
        const res = await (window as any).zradaControls?.getDedupSettings?.();
        if (res && res.ok && res.settings) {
          const s = res.settings;
          if (s.algorithm) setDedupAlg(s.algorithm === 'phash' ? 'phash' : s.algorithm === 'ssim' ? 'ssim' : 'none');
          if (typeof s.threshold === 'number') setDedupThreshold(Number(s.threshold));
        }
      } catch (_) {}
    };
    load();
  }, []);

  const handleSetDedup = async (alg: 'none'|'phash'|'ssim', thr: number) => {
    setDedupAlg(alg); setDedupThreshold(thr);
    try { await (window as any).zradaControls?.setDedupSettings?.({ algorithm: alg === 'phash' ? 'phash' : alg === 'ssim' ? 'ssim' : 'none', threshold: thr }); } catch (_) {}
  };

  const handlePreviewScan = async () => {
    setScanResult({ status: 'scanning' });
    try {
      const r = await (window as any).zradaControls?.previewDedupScan?.({ algorithm: dedupAlg, threshold: dedupThreshold, sampleN: 200 });
      setScanResult(r);
    } catch (e) { setScanResult({ error: String(e) }); }
  };

  return (
    <div>
      <h2>Mode & FPS</h2>
      <div style={{marginTop:8, display:'flex', alignItems:'center', gap:10}}>
        <div style={{fontSize:12}}>Last frame:</div>
        <div style={{display:'flex', alignItems:'center', gap:8}}>
          <span style={{width:14, height:14, borderRadius:7, display:'inline-block', background: lastFrame ? (lastFrame.status === 'skipped' ? '#ff8800' : '#22cc44') : '#888', boxShadow:'0 0 4px rgba(0,0,0,0.4)'}} />
          <div style={{minWidth:80, fontWeight:600}}>{lastFrame ? (lastFrame.status === 'skipped' ? 'SKIPPED' : 'USED') : '—'}</div>
          <div style={{fontSize:11, color:'#666'}}>{lastFrame?.file ? lastFrame.file.split(/[\\/]/).pop() : ''}</div>
        </div>
      </div>
      <div style={{marginTop:8}}>
        <label style={{display:'block', marginBottom:6}}>Mode</label>
        <select value={mode} onChange={(e) => setMode((e.target as HTMLSelectElement).value as any)} style={{padding:6, background:'#222', color:'#fff'}}>
          <option value="video">Video</option>
          <option value="image">Image</option>
        </select>
      </div>

      <div style={{marginTop:12}}>
        <label>Capture FPS</label>
        <div style={{display:'flex', alignItems:'center', gap:8}}>
          <input type="range" min={0.1} max={5} step={0.1} value={fps} onChange={(e) => setFps(Number(e.target.value))} style={{flex:1}} />
          <div style={{minWidth:48, textAlign:'right'}}>{fps.toFixed(1)} fps</div>
        </div>
      </div>

      <div style={{marginTop:12}}>
        <label>Output Speed</label>
        <div style={{display:'flex', alignItems:'center', gap:8}}>
          <input type="range" min={1} max={60} step={1} value={outputFps} onChange={(e) => setOutputFps(Number(e.target.value))} style={{flex:1}} />
          <div style={{minWidth:48, textAlign:'right'}}>{outputFps} fps</div>
        </div>
      </div>

      <div style={{marginTop:12, fontSize:13}}>
        <strong>Preview — 1 hour capture:</strong>
        <div style={{marginTop:6, color:'#666'}}>
          {(() => {
            const frames = Number(fps) * 3600;
            const seconds = outputFps > 0 ? frames / Number(outputFps) : 0;
            const s = Math.max(0, Math.round(seconds));
            const hh = Math.floor(s / 3600);
            const mm = Math.floor((s % 3600) / 60);
            const ss = s % 60;
            const hhStr = hh > 0 ? `${hh}:` : '';
            const mmStr = hh > 0 ? String(mm).padStart(2, '0') : String(mm);
            const timeStr = `${hhStr}${mmStr}:${String(ss).padStart(2, '0')}`;
            return <span>Resulting video length: <strong>{timeStr}</strong> ({s} seconds) — {frames.toFixed(0)} frames</span>;
          })()}
        </div>
      </div>

      <div style={{marginTop:12, fontSize:12, color:'#888'}}>Dedup threshold: placeholder (will add later)</div>
      <div style={{marginTop:16, paddingTop:8, borderTop:'1px dashed #eee'}}>
        <h3 style={{margin:'6px 0'}}>Frame Deduplication</h3>
        <div style={{display:'flex', gap:8, alignItems:'center'}}>
          <label style={{minWidth:80}}>Algorithm</label>
          <select value={dedupAlg} onChange={(e) => handleSetDedup((e.target as HTMLSelectElement).value as any, dedupThreshold)} style={{padding:6}}>
            <option value="none">None</option>
            <option value="phash">pHash (fast)</option>
            <option value="ssim" disabled>SSIM (disabled)</option>
          </select>
        </div>

        <div style={{marginTop:10}}>
          <label>pHash threshold</label>
          <div style={{display:'flex', alignItems:'center', gap:8}}>
            <input type="range" min={0} max={64} step={1} value={dedupThreshold} onChange={(e) => handleSetDedup(dedupAlg, Number(e.target.value))} style={{flex:1}} />
            <div style={{minWidth:48, textAlign:'right'}}>{dedupThreshold}</div>
          </div>
        </div>

        <div style={{marginTop:12, display:'flex', gap:8}}>
          <button onClick={handlePreviewScan} style={{padding:'8px 12px'}}>Preview Scan</button>
          <div style={{color:'#666', fontSize:13}}>{scanResult ? (scanResult.error ? `Error: ${scanResult.error}` : (scanResult.status === 'scanning' ? 'Scanning...' : `${scanResult.total} frames, keep ${scanResult.kept}, discard ${scanResult.discarded}`)) : 'No scan yet'}</div>
        </div>
      </div>
    </div>
  );
};

export default ModeControls;
