import React from 'react';

const FileControls: React.FC = () => {
  const openFolder = async () => {
    try {
      await (window as any).zradaFS?.openSegmentsFolder?.();
    } catch (err) {
      console.error(err);
      alert('Open folder failed');
    }
  };

  const deleteAll = async () => {
    if (!confirm('Delete ALL segments and output files? This cannot be undone.')) return;
    const res = await (window as any).zradaAdmin?.deleteAllFiles?.();
    if (res?.ok) alert('Deleted files: ' + res.deleted); else alert('Delete failed');
  };

  const mergeAll = async () => {
    try {
      await (window as any).zradaAdmin?.mergeAll?.();
      alert('Merge requested');
    } catch (err) {
      console.error(err);
      alert('Merge failed');
    }
  };

  return (
    <div>
      <h2>Files</h2>
      <div style={{display:'flex', flexDirection:'column', gap:8}}>
        <button onClick={mergeAll}>Merge all</button>
        <button onClick={openFolder}>Open segments folder</button>
        <button onClick={deleteAll} style={{color:'#900'}}>Delete all files</button>
      </div>
    </div>
  );
};

export default FileControls;
