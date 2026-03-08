ZradaLog — prototype

This workspace contains initial stubs for LoggerService, preload bridge and a simple React `LogWindow`.

Developer primer (for C++/Visual Studio devs)
-----------------------------------------

This project uses Node.js, npm, Electron and Vite + React (TypeScript).

- **Node.js / npm**: similar to package managers in C++ (vcpkg, nuget). Install Node.js (LTS) from nodejs.org — it provides `node` and `npm` commands.
- **TypeScript**: like C++ with stronger typing; compiles to JavaScript. Files in `electron/` are TypeScript and must be compiled to JS before Electron can run the main process.
- **Vite**: fast dev server for frontend (renderer). During development we run Vite (serves React app on http://localhost:5173) and Electron loads that URL.
- **Main vs Renderer**: Electron has two contexts: the main process (like a backend/native process) and renderer processes (browser-like UIs). Communication uses IPC channels. `preload.ts` exposes a safe bridge into renderer.

Quickstart (first-time setup)
1. Install Node.js (LTS) if not present: https://nodejs.org/
2. From the repo root run:

```bash
npm install
```

3. Development run (starts Vite and Electron):

```bash
npm run dev
```

This runs Vite and then launches Electron which loads the Vite URL.

Building the Electron main process
---------------------------------

The Electron main code is in `electron/*.ts`. Before packaging or running Electron outside Vite you should compile it:

```bash
npm run build:electron
```

This runs `tsc -p tsconfig.electron.json` and emits JS into `electron/build/`. The `main` field in `package.json` points to `electron/build/main.js`.

Running production build of renderer
-----------------------------------

```bash
npm run build
npm run build:electron
npm start
```

Notes & analogies for C++ devs
------------------------------
- Think of `npm install` as pulling libraries; `tsc` is like `cl.exe`/`msbuild` for TypeScript.
- Electron main = native entrypoint (like a native Windows app `WinMain`). Renderer = web UI (HTML/JS) like an embedded browser control.
- `preload.ts` is like a small native shim that safely exposes selected native APIs to the UI.
- Logging: `LoggerService` writes structured JSON logs to disk and emits events to the renderer for real-time display in `LogWindow`.

If you'd like, I can also generate a Visual Studio friendly launch workflow (tasks) or PowerShell scripts to run these commands similarly to how you run builds in Visual Studio.
