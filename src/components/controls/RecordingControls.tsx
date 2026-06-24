import React from 'react';

export interface RecordingControlsProps {
  state: string;
  onStart?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onPause?: () => void;
  onResume?: () => void;
  onStop?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

const btnStyle: React.CSSProperties = { padding: '10px 14px', margin: 6, minWidth: 88 };

const RecordingControls: React.FC<RecordingControlsProps> = ({ state, onStart, onPause, onResume, onStop }) => {
  // Recording controls: main start/stop buttons and current state
  const bg = state === 'recording' ? '#e11' : state === 'paused' ? '#ff8800' : '#2d8cff';
  const label = 'RECORD/PAUSE';
  return (
    <div>
      <h2>Recording</h2>
      <div style={{display:'flex', flexWrap:'wrap', alignItems:'center'}}>
        <button type="button" style={{...btnStyle, background: bg, color:'#fff', border:'none'}} onClick={onStart}>{label}</button>
        <button type="button" style={btnStyle} onClick={onStop}>Stop</button>
      </div>
      
      {/* Last-frame indicator moved to ModeControls */}
      <div style={{marginTop:8, fontSize:12, color:'#888'}}>Hints: R = start/stop (configurable later)</div>
    </div>
  );
};

export default RecordingControls;
