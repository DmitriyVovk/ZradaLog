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
  // Recording controls do not show the last-frame indicator (moved to Mode tab)
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
      {/* Last-frame indicator moved to ModeControls */}
      <div style={{marginTop:8, fontSize:12, color:'#888'}}>Hints: R = start/stop (configurable later)</div>
    </div>
  );
};

export default RecordingControls;
