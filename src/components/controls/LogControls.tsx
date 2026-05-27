import React from 'react';
import LogWindow from '../../components/LogWindow';

type LogEntry = {
  ts: string;
  level: string;
  message: string;
  meta?: Record<string, any>;
};

interface LogControlsProps {
  logs: LogEntry[];
  onClearLogs?: () => void;
}

const LogControls: React.FC<LogControlsProps> = ({ logs, onClearLogs }) => {
  const clearLogs = async () => {
    if (!confirm('Clear logs?')) return;
    // Clear UI logs first
    onClearLogs?.();
    // Clear disk logs
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
        <LogWindow logs={logs} onClearLogs={onClearLogs} />
      </div>
    </div>
  );
};

export default LogControls;
