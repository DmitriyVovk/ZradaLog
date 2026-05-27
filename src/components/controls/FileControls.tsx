import React from 'react';

const FileControls: React.FC = () => {
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
    </div>
  );
};

export default FileControls;
