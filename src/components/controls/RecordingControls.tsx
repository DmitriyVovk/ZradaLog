import React from 'react';

export interface RecordingControlsProps {
  state: string;
  onStart?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onStop?: () => void;
}

const btnStyle: React.CSSProperties = { padding: '10px 14px', margin: 6, minWidth: 88 };

const RecordingControls: React.FC<RecordingControlsProps> = ({ state, onStart, onPause, onResume, onStop }) => {
  const [lastFrame, setLastFrame] = React.useState<{ file?: string; size?: number; status?: string } | null>(null);

  React.useEffect(() => {
    if (!(window as any).zradaFrames?.subscribe) return;
    const unsub = (window as any).zradaFrames.subscribe((entry: any) => {
      setLastFrame(entry);
    });
    return () => unsub && unsub();
  }, []);
  return (
    <div>
      <h2>Recording</h2>
      <div style={{display:'flex', flexWrap:'wrap', alignItems:'center'}}>
        <button style={{...btnStyle, background:'#2d8cff', color:'#fff', border:'none'}} onClick={onStart}>Start</button>
        <button style={btnStyle} onClick={onPause}>Pause</button>
        <button style={btnStyle} onClick={onResume}>Resume</button>
        <button style={btnStyle} onClick={onStop}>Stop</button>
      </div>
      <div style={{marginTop:12}}>
        <strong>State:</strong> <span style={{padding:'4px 8px', background:'#111', color:'#9fd', marginLeft:8}}>{state.toUpperCase()}</span>
      </div>
      <div style={{marginTop:8, display:'flex', alignItems:'center', gap:8}}>
        <div style={{fontSize:12}}>Last frame:</div>
        <div style={{padding:'6px 10px', borderRadius:6, background: lastFrame?.status === 'skipped' ? '#2b2b2b' : '#0f3', color: lastFrame?.status === 'skipped' ? '#999' : '#042', minWidth:120, textAlign:'center'}}>
          {lastFrame ? (lastFrame.status === 'skipped' ? 'SKIPPED' : 'USED') : '—'}
        </div>
        <div style={{fontSize:11, color:'#666'}}>{lastFrame?.file ? lastFrame.file.split(/[\\/]/).pop() : ''}</div>
      </div>
      <div style={{marginTop:8, fontSize:12, color:'#888'}}>Hints: R = start/stop (configurable later)</div>
    </div>
  );
};

export default RecordingControls;
