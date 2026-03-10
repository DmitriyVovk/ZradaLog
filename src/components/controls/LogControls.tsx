import React from 'react';
import LogWindow from '../../components/LogWindow';

const LogControls: React.FC = () => {
  const clearLogs = async () => {
    if (!confirm('Clear logs?')) return;
    const res = await (window as any).zradaAdmin?.clearLogs?.();
    if (res?.ok) alert('Logs cleared'); else alert('Clear failed');
  };

  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
        <h2>Logs</h2>
        <div>
          <button onClick={clearLogs}>Clear logs</button>
        </div>
      </div>
      <div style={{flex:1, minHeight:120, marginTop:8}}>
        <LogWindow />
      </div>
    </div>
  );
};

export default LogControls;
