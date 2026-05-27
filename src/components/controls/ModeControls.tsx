import React from 'react';

export interface ModeControlsProps {
  mode: 'video'|'image';
  setMode: (m: 'video'|'image') => void;
  fps: number;
  setFps: (v: number) => void;
  outputFps: number;
  setOutputFps: (v: number) => void;
}

const DelayedHelp: React.FC<{ text: string }> = ({ text }) => {
  const [visible, setVisible] = React.useState(false);
  const timerRef = React.useRef<number | null>(null);

  const show = () => {
    timerRef.current = window.setTimeout(() => setVisible(true), 1000);
  };
  const hide = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setVisible(false);
  };

  return (
    <span
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      tabIndex={0}
      style={{
        position:'relative',
        display:'inline-flex',
        alignItems:'center',
        justifyContent:'center',
        width:16,
        height:16,
        marginLeft:6,
        borderRadius:'50%',
        background:'#333',
        color:'#fff',
        fontSize:11,
        cursor:'help',
        userSelect:'none'
      }}
    >
      ?
      {visible && (
        <span
          style={{
            position:'absolute',
            zIndex:10,
            left:22,
            top:-8,
            width:280,
            padding:'8px 10px',
            background:'#111',
            color:'#fff',
            border:'1px solid #444',
            borderRadius:4,
            boxShadow:'0 6px 18px rgba(0,0,0,0.35)',
            fontSize:12,
            lineHeight:1.35,
            fontWeight:400,
            textAlign:'left'
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
};

const mpdecimateHelp = {
  hi: 'Maximum per-block difference threshold. Higher values are more tolerant and drop fewer frames; lower values make the filter more aggressive.',
  lo: 'Lower per-block difference threshold. Raising it makes small changes count as motion; lowering it ignores more minor noise.',
  frac: 'Required fraction of changed blocks, from 0 to 1. Higher values require more of the screen to change before a frame is kept.'
};

const ModeControls: React.FC<ModeControlsProps> = ({ mode, setMode, fps, setFps, outputFps, setOutputFps }) => {
  const [dedupAlg, setDedupAlg] = React.useState<'none' | 'phash' | 'ssim'>('phash');
  const [dedupThreshold, setDedupThreshold] = React.useState<number>(12);
  const [dedupEnabled, setDedupEnabled] = React.useState<boolean>(false);
  const [mpdecimateEnabled, setMpdecimateEnabled] = React.useState<boolean>(true);
  const [mpHi, setMpHi] = React.useState<number>(20000);
  const [mpLo, setMpLo] = React.useState<number>(1500);
  const [mpFrac, setMpFrac] = React.useState<number>(0.3);
  const [scanResult, setScanResult] = React.useState<any>(null);
  const [lastFrame, setLastFrame] = React.useState<{ file?: string; size?: number; status?: string } | null>(null);
  const [savedCount, setSavedCount] = React.useState<number>(0);

  React.useEffect(() => {
    // subscribe to candidate events for immediate indicator updates
    let unsubCandidate: any = null;
    let unsubSavedCount: any = null;
    try {
      if ((window as any).zradaCandidates?.subscribe) {
        unsubCandidate = (window as any).zradaCandidates.subscribe((entry: any) => {
          try {
            const s = entry && String(entry.status).toLowerCase() === 'skipped' ? 'skipped' : 'used';
            // prefer showing reserved dest filename when available
            const file = entry?.dest || entry?.tmp || entry?.file;
            setLastFrame({ file, size: entry?.size, status: s });
          } catch (_) {}
        });
      }
      // obtain saved count from main and subscribe to updates
      (async () => {
        try {
          if ((window as any).zradaCandidates?.getSavedCount) {
            const r = await (window as any).zradaCandidates.getSavedCount();
            if (r && r.ok && typeof r.count === 'number') setSavedCount(r.count);
          } else if ((window as any).zradaFrames?.getRecent) {
            // fallback to frames buffer
            const r = await (window as any).zradaFrames.getRecent?.(8);
            if (r && r.ok && Array.isArray(r.frames)) {
              const cnt = r.frames.filter((f: any) => String(f.status).toLowerCase() === 'used').length;
              setSavedCount(cnt);
            }
          }
        } catch (_) {}
      })();
      if ((window as any).zradaCandidates?.subscribeSavedCount) {
        unsubSavedCount = (window as any).zradaCandidates.subscribeSavedCount((p: any) => {
          try { setSavedCount(Number(p?.count || 0)); } catch (_) {}
        });
      }
    } catch (_) {}

    // try to load persisted dedup settings from main process
    const load = async () => {
      try {
        const res = await (window as any).zradaControls?.getDedupSettings?.();
        if (res && res.ok && res.settings) {
          const s = res.settings;
          if (s.algorithm) setDedupAlg(s.algorithm === 'phash' ? 'phash' : s.algorithm === 'ssim' ? 'ssim' : 'none');
          if (typeof s.threshold === 'number') setDedupThreshold(Number(s.threshold));
              if (typeof s.enabled === 'boolean') setDedupEnabled(Boolean(s.enabled));
        }
      } catch (_) {}
      try {
        const r = await (window as any).zradaControls?.getMpdecimate?.();
        if (r && r.ok && r.mpdecimate) {
          const m = r.mpdecimate;
          setMpdecimateEnabled(Boolean(m.enabled));
          if (typeof m.hi === 'number') setMpHi(Number(m.hi));
          if (typeof m.lo === 'number') setMpLo(Number(m.lo));
          if (typeof m.frac === 'number') setMpFrac(Number(m.frac));
        }
      } catch (_) {}
    };
    load();

    return () => {
      try { if (unsubCandidate && typeof unsubCandidate === 'function') unsubCandidate(); } catch (_) {}
      try { if (unsubSavedCount && typeof unsubSavedCount === 'function') unsubSavedCount(); } catch (_) {}
    };
  }, []);
  
  React.useEffect(() => {
    // subscribe to dedup fallback notifications to inform user
    let unsubDedup: any = null;
    try {
      if ((window as any).zradaAlerts?.subscribeDedupFallback) {
        unsubDedup = (window as any).zradaAlerts.subscribeDedupFallback((p: any) => {
          try {
            setScanResult({ status: 'dedup-fallback', info: p });
            // clear message after a short delay
            setTimeout(() => setScanResult(null), 8000);
          } catch (_) {}
        });
      }
    } catch (_) {}
    return () => { try { if (unsubDedup && typeof unsubDedup === 'function') unsubDedup(); } catch (_) {} };
  }, []);

  const handleSetDedup = async (alg: 'none'|'phash'|'ssim', thr: number) => {
    setDedupAlg(alg); setDedupThreshold(thr);
    try {
      await (window as any).zradaControls?.setDedupSettings?.({ algorithm: alg === 'phash' ? 'phash' : alg === 'ssim' ? 'ssim' : 'none', threshold: thr, enabled: dedupEnabled });
    } catch (_) {}
  };

  const toggleDedupEnabled = async (v: boolean) => {
    setDedupEnabled(v);
    try { await (window as any).zradaControls?.setDedupSettings?.({ enabled: v, algorithm: dedupAlg, threshold: dedupThreshold }); } catch (_) {}
  };

  const toggleMpdecimateEnabled = async (v: boolean) => {
    setMpdecimateEnabled(v);
    try { await (window as any).zradaControls?.setMpdecimate?.({ enabled: v, hi: mpHi, lo: mpLo, frac: mpFrac }); } catch (_) {}
  };

  const setMpdecimate = async (k: 'hi' | 'lo' | 'frac', val: number) => {
    try {
      if (k === 'hi') { setMpHi(val); }
      else if (k === 'lo') { setMpLo(val); }
      else { setMpFrac(val); }
      await (window as any).zradaControls?.setMpdecimate?.({ enabled: mpdecimateEnabled, hi: (k==='hi'?val:mpHi), lo: (k==='lo'?val:mpLo), frac: (k==='frac'?val:mpFrac) });
    } catch (_) {}
  };

  const handlePreviewScan = async () => {
    setScanResult({ status: 'scanning' });
    try {
      const r = await (window as any).zradaControls?.previewDedupScan?.({ algorithm: dedupAlg, threshold: dedupThreshold, sampleN: 200 });
      setScanResult(r);
    } catch (e) { setScanResult({ error: String(e) }); }
  };

  return (
    <div style={{paddingBottom:22}}>
      <h2 style={{margin:'0 0 8px 0'}}>Mode & FPS</h2>
      <div style={{marginTop:8, display:'flex', alignItems:'center', gap:8}}>
        <label style={{minWidth:50, fontWeight:600}}>Mode</label>
        <button onClick={() => setMode('video')} style={{flex:1, padding:'6px 12px', background: mode === 'video' ? '#0a7' : '#333', color:'#fff', border:'none', borderRadius:4, cursor:'pointer', fontWeight: mode === 'video' ? 600 : 400}}>Video</button>
        <button onClick={() => setMode('image')} style={{flex:1, padding:'6px 12px', background: mode === 'image' ? '#0a7' : '#333', color:'#fff', border:'none', borderRadius:4, cursor:'pointer', fontWeight: mode === 'image' ? 600 : 400}}>Image</button>
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

      {mode === 'video' && (
        <div style={{marginTop:16, paddingTop:8, borderTop:'1px dashed #eee'}}>
          <h3 style={{margin:'0 0 6px 0'}}>Video Deduplication (mpdecimate)</h3>
          <div style={{marginTop:6}}>
            <label style={{display:'inline-flex', alignItems:'center', gap:8}}>
              <input type="checkbox" checked={mpdecimateEnabled} onChange={(e) => toggleMpdecimateEnabled((e.target as HTMLInputElement).checked)} />
              <span>Enable mpdecimate</span>
            </label>
          </div>
          <div style={{marginTop:8}}>
            <label>hi<DelayedHelp text={mpdecimateHelp.hi} /></label>
            <div style={{display:'flex', alignItems:'center', gap:8}}>
              <input type="range" min={0} max={100000} step={100} value={mpHi} onChange={(e) => setMpdecimate('hi', Number(e.target.value))} style={{flex:1}} disabled={!mpdecimateEnabled} />
              <div style={{minWidth:72, textAlign:'right'}}>{mpHi}</div>
            </div>
          </div>
          <div style={{marginTop:8}}>
            <label>lo<DelayedHelp text={mpdecimateHelp.lo} /></label>
            <div style={{display:'flex', alignItems:'center', gap:8}}>
              <input type="range" min={0} max={10000} step={50} value={mpLo} onChange={(e) => setMpdecimate('lo', Number(e.target.value))} style={{flex:1}} disabled={!mpdecimateEnabled} />
              <div style={{minWidth:72, textAlign:'right'}}>{mpLo}</div>
            </div>
          </div>
          <div style={{marginTop:8}}>
            <label>frac<DelayedHelp text={mpdecimateHelp.frac} /></label>
            <div style={{display:'flex', alignItems:'center', gap:8}}>
              <input type="range" min={0} max={1} step={0.01} value={mpFrac} onChange={(e) => setMpdecimate('frac', Number(e.target.value))} style={{flex:1}} disabled={!mpdecimateEnabled} />
              <div style={{minWidth:72, textAlign:'right'}}>{mpFrac.toFixed(2)}</div>
            </div>
          </div>
        </div>
      )}

      {mode === 'image' && (
        <div style={{marginTop:16, paddingTop:8, borderTop:'1px dashed #eee'}}>
          <h3 style={{margin:'0 0 6px 0'}}>Image Deduplication</h3>
          <div style={{marginTop:6}}>
            <label style={{display:'inline-flex', alignItems:'center', gap:8}}>
              <input type="checkbox" checked={dedupEnabled} onChange={(e) => toggleDedupEnabled((e.target as HTMLInputElement).checked)} />
              <span>Enable dedup</span>
            </label>
          </div>
          <div style={{marginTop:8}}>
            <label>Algorithm</label>
            <select value={dedupAlg} onChange={(e) => handleSetDedup((e.target as HTMLSelectElement).value as any, dedupThreshold)} style={{padding:6, background:'#222', color:'#fff', width:'100%'}} disabled={!dedupEnabled}>
              <option value="none">None</option>
              <option value="phash">pHash</option>
              <option value="ssim">SSIM</option>
            </select>
          </div>
          <div style={{marginTop:8}}>
            <label>Threshold</label>
            <div style={{display:'flex', alignItems:'center', gap:8}}>
              <input type="range" min={0} max={50} step={1} value={dedupThreshold} onChange={(e) => handleSetDedup(dedupAlg, Number(e.target.value))} style={{flex:1}} disabled={!dedupEnabled} />
              <div style={{minWidth:48, textAlign:'right'}}>{dedupThreshold}</div>
            </div>
          </div>
          <div style={{marginTop:8}}>
            <button onClick={handlePreviewScan} disabled={!dedupEnabled} style={{padding:'6px 12px', background:'#444', color:'#fff', border:'none', borderRadius:4}}>Preview Scan</button>
          </div>
          {scanResult && (
            <div style={{marginTop:8, fontSize:12, color: scanResult.error ? '#f44' : scanResult.status === 'dedup-fallback' ? '#fa4' : '#4f4'}}>
              {scanResult.error ? `Error: ${scanResult.error}` :
               scanResult.status === 'dedup-fallback' ? `Fallback: ${JSON.stringify(scanResult.info)}` :
               scanResult.status === 'scanning' ? 'Scanning...' :
               `Total: ${scanResult.total}, Kept: ${scanResult.kept}, Discarded: ${scanResult.discarded}`}
            </div>
          )}
        </div>
      )}

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
            return <span>Resulting video length (MAX): <strong>{timeStr}</strong> ({s} seconds) — {frames.toFixed(0)} frames</span>;
          })()}
        </div>
      </div>

      
      
    </div>
  );
};

export default ModeControls;
