import React from 'react';

const FileControls: React.FC = () => {
  const [workspace, setWorkspace] = React.useState<{ root: string; isDefault: boolean } | null>(null);

  const loadWorkspace = React.useCallback(async () => {
    try {
      const res = await (window as any).zradaWorkspace?.get?.();
      if (res?.ok) setWorkspace({ root: res.root, isDefault: res.isDefault });
    } catch (_) { /* ignore */ }
  }, []);

  React.useEffect(() => { loadWorkspace(); }, [loadWorkspace]);

  const openWorkspaceFolder = async () => {
    try {
      await (window as any).zradaWorkspace?.open?.();
    } catch (_) {
      alert('Open working folder failed');
    }
  };

  const changeWorkspace = async () => {
    try {
      const res = await (window as any).zradaWorkspace?.change?.();
      if (res?.cancelled) return;
      if (res?.ok) {
        // App relaunches after a successful move; show a hint in case it doesn't.
        alert('Working directory changed. Restarting application…');
      } else {
        alert('Change working directory failed: ' + (res?.err || 'unknown error'));
      }
    } catch (err) {
      alert('Change working directory failed');
    }
  };

  const openOutputFolder = async () => {
    try {
      await (window as any).zradaFS?.openOutputFolder?.();
    } catch (err) {
      alert('Open output folder failed');
    }
  };

  const deleteAll = async () => {
    if (!confirm('Move all application data (logs, segments, recordings, output files) to Recycle Bin?')) return;
    const res = await (window as any).zradaAdmin?.deleteAllFiles?.();
    if (res?.ok) alert('Moved application data to Recycle Bin: ' + res.deleted + ' item(s)');
    else alert('Clear failed: ' + (res?.err || 'unknown error'));
  };

  const mergeAll = async () => {
    try {
      // First check if there are segments to merge
      const checkRes = await (window as any).zradaAdmin?.checkSegments?.();
      if (!checkRes) {
        alert('Failed to check segments');
        return;
      }
      if (!checkRes.hasSegments) {
        alert(`No segments found to merge (${checkRes.count || 0} files)`);
        return;
      }

      const confirmed = confirm(`Found ${checkRes.count} segment(s). Merge them into a video?`);
      if (!confirmed) return;

      const res = await (window as any).zradaAdmin?.mergeAll?.();
      if (res?.ok) {
        alert(`Merge completed! Output: ${res.outPath}`);
      } else {
        alert(`Merge failed: ${res?.err || 'Unknown error'}`);
      }
    } catch (err) {
      alert('Merge failed');
    }
  };

  return (
    <div>
      <h2>Files</h2>
      <div style={{display:'flex', flexDirection:'column', gap:8}}>
        <button onClick={mergeAll}>Merge all</button>
        <button onClick={openOutputFolder}>Open output folder</button>
        <button onClick={deleteAll} style={{color:'#900'}}>Clear all application data</button>
      </div>

      <h2 style={{marginTop:24}}>Working directory</h2>
      <div style={{display:'flex', flexDirection:'column', gap:8}}>
        <div style={{fontSize:12, color:'#555', wordBreak:'break-all'}}>
          {workspace
            ? <>Current: <code>{workspace.root}</code>{workspace.isDefault ? ' (default)' : ''}</>
            : 'Loading…'}
        </div>
        <div style={{display:'flex', gap:8}}>
          <button onClick={changeWorkspace}>Change working directory…</button>
          <button onClick={openWorkspaceFolder}>Open working folder</button>
        </div>
        <div style={{fontSize:11, color:'#888'}}>
          Changing the directory moves all files (settings, logs, segments, recordings)
          to the new location and restarts the application.
        </div>
      </div>
    </div>
  );
};

export default FileControls;
