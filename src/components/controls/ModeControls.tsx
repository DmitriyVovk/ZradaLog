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
  return (
    <div>
      <h2>Mode & FPS</h2>
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
    </div>
  );
};

export default ModeControls;
