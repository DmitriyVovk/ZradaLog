import React from 'react';
import LogWindow from './components/LogWindow';

export const App: React.FC = () => {
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100vh'}}>
      <header style={{padding:10, background:'#282c34', color:'#fff'}}>ZradaLog — Dev UI</header>
      <main style={{padding:10, flex:1}}>
        <h3>Logs</h3>
        <LogWindow />
      </main>
    </div>
  );
};

export default App;
