import React, { useEffect, useState, useMemo } from 'react';

type LogEntry = {
  ts: string;
  level: string;
  message: string;
  meta?: Record<string, any>;
};

declare global {
  interface Window { zradaLogger?: any }
}

export const LogWindow: React.FC = () => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState<string>('debug');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!window.zradaLogger) return;
    const unsub = window.zradaLogger.subscribe((entry: LogEntry) => {
      setLogs((s) => {
        const next = [entry, ...s];
        if (next.length > 500) next.length = 500; // keep newest 500
        return next;
      });
    });
    return () => unsub && unsub();
  }, []);

  const clearAll = async () => {
    // clear UI
    setLogs([]);
    // clear disk logs via main
    if ((window as any).zradaAdmin?.clearLogs) {
      try {
        const res = await (window as any).zradaAdmin.clearLogs();
        if (!res?.ok) alert('Clear logs failed: ' + (res?.err || 'unknown'));
      } catch (e) {
        alert('Clear logs error: ' + String(e));
      }
    }
  };

  const filtered = useMemo(() => logs.filter(l => {
    const levels = ['debug','info','warn','error'];
    if (levels.indexOf(l.level) < levels.indexOf(levelFilter)) return false;
    if (search && !(l.message.includes(search) || JSON.stringify(l.meta || {}).includes(search))) return false;
    return true;
  }), [logs, levelFilter, search]);

  return (
    <div style={{fontFamily:'monospace', padding:10}}>
      <div style={{display:'flex', gap:8, marginBottom:8}}>
        <select value={levelFilter} onChange={e=>setLevelFilter(e.target.value)}>
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <input placeholder="Search" value={search} onChange={e=>setSearch(e.target.value)} />
      </div>
      <div style={{maxHeight:400, overflow:'auto', background:'#111', color:'#eee', padding:8}}>
        {filtered.map((l, i) => (
          <div key={i} style={{borderBottom:'1px solid #222', padding:'6px 0'}}>
            <div style={{fontSize:12, color:'#999'}}>{l.ts} [{l.level}]</div>
            <div>{l.message}</div>
            {l.meta && <pre style={{whiteSpace:'pre-wrap', margin:0}}>{JSON.stringify(l.meta)}</pre>}
          </div>
        ))}
      </div>
      <div style={{display:'flex', justifyContent:'flex-end', marginTop:8}}>
        <button onClick={clearAll}>Clear</button>
      </div>
    </div>
  );
};

export default LogWindow;
