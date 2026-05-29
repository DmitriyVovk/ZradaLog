import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  powerMonitor,
} from "electron";
// Workaround: some older dependencies call util._extend which is deprecated (DEP0060).
// Replace util._extend with Object.assign early to avoid runtime deprecation warnings.
import util from "util";
try {
  if ((util as any)._extend) {
    (util as any)._extend = Object.assign;
  }
} catch (_) {}
import { spawn, execFileSync, spawnSync } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";
import { LoggerService } from "./services/LoggerService";
import { RecorderEngine } from "./services/RecorderEngine";
import { MergerService } from "./services/MergerService";
import { getFFmpegPath } from "./utils/ffmpegUtils";

let FFMPEG_PATH: string;

function ensureFFmpegCopy(): void {
  try {
    const targetDir = path.join(process.resourcesPath, "ffmpeg");
    const targetPath = path.join(targetDir, "ffmpeg.exe");

    // If our guaranteed copy already exists, skip
    if (fs.existsSync(targetPath)) {
      logger &&
        logger.info &&
        logger.info("FFmpeg copy already exists", { path: targetPath });
      return;
    }

    // Try to find source FFmpeg
    let sourcePath: string | null = null;
    try {
      const bundledPath = require("@ffmpeg-installer/ffmpeg")?.path;
      sourcePath = bundledPath || null;
    } catch (_) {}

    if (!sourcePath || !fs.existsSync(sourcePath)) {
      // Try asar unpacked path
      const asarUnpacked = path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "@ffmpeg-installer",
        "win32-x64",
        "ffmpeg.exe",
      );
      if (fs.existsSync(asarUnpacked)) {
        sourcePath = asarUnpacked;
      }
    }

    if (sourcePath && fs.existsSync(sourcePath)) {
      // Copy FFmpeg to guaranteed location
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
      logger &&
        logger.info &&
        logger.info("FFmpeg copied to guaranteed location", {
          from: sourcePath,
          to: targetPath,
        });

      // Update FFMPEG_PATH to use the guaranteed copy
      FFMPEG_PATH = targetPath;
    } else {
      logger &&
        logger.warn &&
        logger.warn("Could not find FFmpeg to copy", {
          triedSource: sourcePath,
        });
    }
  } catch (e: any) {
    logger &&
      logger.error &&
      logger.error("Failed to ensure FFmpeg copy", { error: e?.message });
  }
}

let mainWindow: BrowserWindow | null = null;
let logger: LoggerService;
let recorder: RecorderEngine | null = null;
let merger: MergerService | null = null;
let rendererReady = false;
const pendingLogs: any[] = [];
let outputFps = 24;
let savedCount = 0;
const AUTO_MERGE_MAX_VIDEO_BYTES = 1536 * 1024 * 1024;
const AUTO_MERGE_MAX_VIDEO_SEGMENTS = 16;
// Flag: was recording auto-paused by sleep event (vs manual pause by user)
let sleepPausedRec = false;
// Flag: Windows screen is currently locked (gdigrab cannot access desktop while locked)
let screenIsLocked = false;
// Timer handle for delayed auto-resume after wake
let wakeResumeTimer: NodeJS.Timeout | null = null;
// persisted settings path
const settingsPath = path.join(app.getPath("userData") || ".", "settings.json");
let settingsCache: any = null;
let dedupSettings: { algorithm: string; threshold: number; enabled?: boolean } =
  { algorithm: "phash", threshold: 12, enabled: false };
let mpdecimateSettings: {
  enabled: boolean;
  hi: number;
  lo: number;
  frac: number;
} = { enabled: true, hi: 20000, lo: 1500, frac: 0.3 };

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, "utf8");
      settingsCache = JSON.parse(raw || "{}");
    } else {
      settingsCache = {};
    }
  } catch (e) {
    settingsCache = {};
  }
  return settingsCache;
}

function saveSettings() {
  try {
    settingsCache = settingsCache || {};
    settingsCache.dedupSettings = dedupSettings;
    settingsCache.outputFps = outputFps;
    settingsCache.mpdecimateSettings = mpdecimateSettings;
    try {
      settingsCache.mode =
        recorder && typeof (recorder as any).getMode === "function"
          ? (recorder as any).getMode()
          : settingsCache.mode;
    } catch (_) {}
    try {
      settingsCache.fps =
        recorder && typeof (recorder as any).getFps === "function"
          ? (recorder as any).getFps()
          : settingsCache.fps;
    } catch (_) {}
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(settingsCache, null, 2),
      "utf8",
    );
    logger &&
      logger.info &&
      logger.info("Settings saved", { path: settingsPath });
    return { ok: true };
  } catch (e: any) {
    logger &&
      logger.error &&
      logger.error("Save settings failed", { err: e?.message });
    return { ok: false, err: e?.message };
  }
}

function checkFFmpeg(): boolean {
  try {
    const result = spawnSync(FFMPEG_PATH, ["-version"], {
      windowsHide: true,
      encoding: "utf8",
    });
    if (result.error || result.status !== 0) {
      logger &&
        logger.warn &&
        logger.warn("FFmpeg check failed", {
          path: FFMPEG_PATH,
          error: result.error?.message,
        });
      return false;
    }
    logger && logger.info && logger.info("FFmpeg found", { path: FFMPEG_PATH });
    return true;
  } catch (e: any) {
    logger &&
      logger.error &&
      logger.error("FFmpeg check error", {
        path: FFMPEG_PATH,
        error: e?.message,
      });
    return false;
  }
}

function checkActiveCaptureProcesses() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], {
        encoding: "utf8",
      });
      const lines = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const matches: Array<{ image: string; pid: number; raw: string }> = [];
      for (const line of lines) {
        // CSV: "Image Name","PID","Session Name","Session#","Mem Usage"
        const parts = line.split(/","|","/).map((p) => p.replace(/^"|"$/g, ""));
        const img = parts[0] || "";
        const pid = Number(parts[1] || 0) || 0;
        if (/ffmpeg/i.test(img)) matches.push({ image: img, pid, raw: line });
      }
      return matches;
    } else {
      // fallback: ps on *nix
      try {
        const out = execFileSync("ps", ["-axo", "pid,comm,args"], {
          encoding: "utf8",
        });
        const lines = out
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const matches: Array<{ image: string; pid: number; raw: string }> = [];
        for (const line of lines.slice(1)) {
          if (/ffmpeg/i.test(line)) {
            const parts = line.trim().split(/\s+/);
            const pid = Number(parts[0] || 0) || 0;
            matches.push({ image: parts[1] || "ffmpeg", pid, raw: line });
          }
        }
        return matches;
      } catch (_) {
        return [];
      }
    }
  } catch (e) {
    return [];
  }
}

function getFilesStats(files: string[]) {
  let existing = 0;
  let totalBytes = 0;
  const missing: string[] = [];
  for (const file of files) {
    try {
      const st = fs.statSync(file);
      if (st.isFile()) {
        existing += 1;
        totalBytes += st.size;
      }
    } catch (_) {
      missing.push(file);
    }
  }
  return { existing, totalBytes, missing };
}

function summarizeSegmentFiles(files: string[]) {
  const items = files
    .map((file) => {
      try {
        const st = fs.statSync(file);
        return {
          file,
          name: path.basename(file),
          ext: path.extname(file).toLowerCase(),
          size: st.size,
          birthtimeMs: st.birthtime.getTime(),
          mtimeMs: st.mtime.getTime(),
          birthtime: st.birthtime.toISOString(),
          mtime: st.mtime.toISOString(),
        };
      } catch (e: any) {
        return {
          file,
          name: path.basename(file),
          ext: path.extname(file).toLowerCase(),
          size: 0,
          birthtimeMs: 0,
          mtimeMs: 0,
          birthtime: null,
          mtime: null,
          err: e?.message,
        };
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const mp4Items = items.filter((item) => item.ext === ".mp4");
  const totalBytes = mp4Items.reduce((sum, item) => sum + item.size, 0);
  const byMtime = mp4Items
    .filter((item) => item.mtimeMs > 0)
    .slice()
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  const first = byMtime[0] || null;
  const last = byMtime[byMtime.length - 1] || null;
  return {
    totalInputFiles: items.length,
    mp4Count: mp4Items.length,
    nonMp4Count: items.length - mp4Items.length,
    totalMp4Bytes: totalBytes,
    firstMp4: first
      ? { name: first.name, size: first.size, mtime: first.mtime }
      : null,
    lastMp4: last ? { name: last.name, size: last.size, mtime: last.mtime } : null,
    mp4MtimeSpanSec:
      first && last ? Math.round((last.mtimeMs - first.mtimeMs) / 1000) : null,
    samples: items.slice(0, 30).map((item) => ({
      name: item.name,
      ext: item.ext,
      size: item.size,
      birthtime: item.birthtime,
      mtime: item.mtime,
      err: (item as any).err,
    })),
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    icon: path.join(__dirname, "../build/zradalog-icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
    },
  });

  const devUrl = "http://localhost:5173";
  if (process.env.NODE_ENV === "development") {
    logger && logger.info && logger.info("Loading dev URL", { url: devUrl });
    mainWindow.loadURL(devUrl);
  } else {
    // In production, __dirname is resources/app.asar/electron/build/
    // We need to go up to resources/app.asar/dist/index.html
    const filePath = path.join(
      process.resourcesPath,
      "app.asar",
      "dist",
      "index.html",
    );
    logger && logger.info && logger.info("Loading file", { path: filePath });
    mainWindow.loadFile(filePath);
  }

  // Log any errors
  mainWindow.webContents.on("crashed", () => {
    logger && logger.error && logger.error("Renderer process crashed", {});
  });

  mainWindow.webContents.on("render-process-gone", (event, details) => {
    logger &&
      logger.error &&
      logger.error("Render process gone", { reason: details.reason });
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  const userData = app.getPath("userData");
  const logDir = path.join(userData, "logs");
  logger = new LoggerService(logDir);

  // Initialize FFmpeg path after logger is available
  FFMPEG_PATH = getFFmpegPath();

  // Ensure FFmpeg is available in guaranteed location
  ensureFFmpegCopy();

  // Check FFmpeg availability
  const ffmpegOk = checkFFmpeg();
  if (!ffmpegOk) {
    logger.warn("FFmpeg not found in PATH", {});
    const response = dialog.showMessageBoxSync({
      type: "warning",
      title: "FFmpeg Not Found",
      message: "FFmpeg executable not found in PATH",
      detail:
        "ZradaLog requires FFmpeg to record and merge videos.\n\nPlease install FFmpeg:\n- Windows: choco install ffmpeg\n- Mac: brew install ffmpeg\n- Linux: sudo apt install ffmpeg\n\nOr download from: https://ffmpeg.org/download.html",
      buttons: ["OK", "Open FFmpeg Website"],
    });
    if (response === 1) {
      shell.openExternal("https://ffmpeg.org/download.html");
    }
  } else {
    logger.info("FFmpeg found", {});
  }

  // forward logs to renderer (buffer until renderer ready)
  logger.on("log", (entry) => {
    if (rendererReady && mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("zrada:log", entry);
    } else {
      pendingLogs.push(entry);
    }
  });

  createWindow();
  // load persisted settings if any
  try {
    const loaded = loadSettings() || {};
    if (loaded.outputFps) outputFps = Number(loaded.outputFps) || outputFps;
    if (loaded.dedupSettings) {
      dedupSettings.algorithm =
        loaded.dedupSettings.algorithm ?? dedupSettings.algorithm;
      dedupSettings.threshold =
        typeof loaded.dedupSettings.threshold === "number"
          ? loaded.dedupSettings.threshold
          : dedupSettings.threshold;
      dedupSettings.enabled =
        typeof loaded.dedupSettings.enabled === "boolean"
          ? loaded.dedupSettings.enabled
          : dedupSettings.enabled;
    }
    if (loaded.mpdecimateSettings) {
      mpdecimateSettings.enabled =
        typeof loaded.mpdecimateSettings.enabled === "boolean"
          ? loaded.mpdecimateSettings.enabled
          : mpdecimateSettings.enabled;
      mpdecimateSettings.hi =
        typeof loaded.mpdecimateSettings.hi === "number"
          ? loaded.mpdecimateSettings.hi
          : mpdecimateSettings.hi;
      mpdecimateSettings.lo =
        typeof loaded.mpdecimateSettings.lo === "number"
          ? loaded.mpdecimateSettings.lo
          : mpdecimateSettings.lo;
      mpdecimateSettings.frac =
        typeof loaded.mpdecimateSettings.frac === "number"
          ? loaded.mpdecimateSettings.frac
          : mpdecimateSettings.frac;
    }
    logger.info("Loaded persisted settings", { outputFps, dedupSettings });
  } catch (_) {}
  // create recorder engine and wire events
  recorder = new RecorderEngine(logger);
  try {
    recorder.setMpdecimateSettings &&
      recorder.setMpdecimateSettings(mpdecimateSettings);
  } catch (_) {}
  try {
    recorder.setOutputFps && recorder.setOutputFps(outputFps);
  } catch (_) {}
  try {
    recorder.setDedupSettings && recorder.setDedupSettings(dedupSettings);
  } catch (_) {}
  // initialize savedCount from existing images (if any)
  function loadSavedCount() {
    try {
      const imagesDir = path.join(
        app.getPath("userData"),
        "segments",
        "images",
      );
      if (!fs.existsSync(imagesDir)) return 0;
      const files = fs
        .readdirSync(imagesDir)
        .filter((f) => /\.(jpe?g|png)$/i.test(f));
      return files.length;
    } catch (_) {
      return 0;
    }
  }
  try {
    savedCount = loadSavedCount();
    logger.info("Initial saved count", { savedCount });
  } catch (_) {
    savedCount = 0;
  }
  // apply loaded settings to recorder (mode, fps) if present
  try {
    const loaded = settingsCache || loadSettings() || {};
    if (loaded.mode && (recorder as any).setMode) {
      try {
        (recorder as any).setMode(loaded.mode);
        logger.info("Applied saved mode to recorder", { mode: loaded.mode });
      } catch (_) {}
    }
    if (typeof loaded.fps !== "undefined" && (recorder as any).setFps) {
      try {
        (recorder as any).setFps(Number(loaded.fps) || 1);
        logger.info("Applied saved fps to recorder", { fps: loaded.fps });
      } catch (_) {}
    }
  } catch (_) {}
  merger = new MergerService(logger);

  // ─── Sleep / Wake handling ───────────────────────────────────────────────
  // Windows freezes all processes on sleep — no close/kill signal is sent.
  // We listen to powerMonitor events to pause FFmpeg cleanly before sleep
  // and auto-resume after the system wakes up.
  try {
    powerMonitor.on("suspend", () => {
      logger.info("System suspending — auto-pausing recorder");
      if (recorder?.getState() === "recording") {
        sleepPausedRec = true;
        recorder.pause();
        logger.info("Recording auto-paused on system suspend");
        if (rendererReady && mainWindow)
          mainWindow.webContents.send("zrada:recorder-state", "paused");
      }
    });

    powerMonitor.on("lock-screen", () => {
      screenIsLocked = true;
      logger.info("Screen locked");
      // Pause recording immediately on screen lock.
      // In Windows Modern Standby (S0 sleep) the suspend event may arrive
      // much later or never, while the screen is already locked/off and
      // gdigrab keeps capturing the static lock screen — bypassing mpdecimate
      // because the lock screen has subtle animations (clock, etc.).
      if (recorder?.getState() === "recording") {
        sleepPausedRec = true;
        recorder.pause();
        logger.info("Recording auto-paused on screen lock");
        if (rendererReady && mainWindow)
          mainWindow.webContents.send("zrada:recorder-state", "paused");
      }
    });

    powerMonitor.on("unlock-screen", () => {
      screenIsLocked = false;
      logger.info("Screen unlocked");
      // If we were auto-paused by sleep and screen is now unlocked → best moment to resume.
      // gdigrab can access the desktop only after unlock.
      if (sleepPausedRec && recorder?.getState() === "paused") {
        sleepPausedRec = false;
        if (wakeResumeTimer) {
          clearTimeout(wakeResumeTimer);
          wakeResumeTimer = null;
        }
        // Small extra delay for the desktop compositor to finish rendering.
        wakeResumeTimer = setTimeout(() => {
          wakeResumeTimer = null;
          if (recorder?.getState() === "paused") {
            recorder.resume();
            logger.info("Recording auto-resumed after screen unlock");
          }
        }, 1500);
      }
    });

    powerMonitor.on("resume", () => {
      logger.info("System resumed from sleep", { screenIsLocked });
      if (!sleepPausedRec) return;

      if (screenIsLocked) {
        // Screen is locked — gdigrab will fail immediately.
        // Don't start now; wait for the unlock-screen event instead.
        logger.info("Deferring auto-resume until screen is unlocked");
        return;
      }

      // Screen is NOT locked: schedule resume with a delay so Windows
      // has time to fully restore the display before gdigrab tries to open it.
      sleepPausedRec = false;
      if (wakeResumeTimer) {
        clearTimeout(wakeResumeTimer);
        wakeResumeTimer = null;
      }
      wakeResumeTimer = setTimeout(() => {
        wakeResumeTimer = null;
        if (recorder?.getState() === "paused") {
          recorder.resume();
          logger.info("Recording auto-resumed after system wake (delayed)");
        }
      }, 4000);
    });
  } catch (e: any) {
    logger.warn("powerMonitor setup failed", { err: e?.message });
  }
  // ─────────────────────────────────────────────────────────────────────────

  recorder.on("started", () => {
    logger.info("Recorder state", { state: recorder?.getState() });
    if (rendererReady && mainWindow)
      mainWindow.webContents.send("zrada:recorder-state", recorder?.getState());
  });
  recorder.on("paused", () => {
    logger.info("Recorder state", { state: recorder?.getState() });
    if (rendererReady && mainWindow)
      mainWindow.webContents.send("zrada:recorder-state", recorder?.getState());
  });
  recorder.on("resumed", () => {
    logger.info("Recorder state", { state: recorder?.getState() });
    if (rendererReady && mainWindow)
      mainWindow.webContents.send("zrada:recorder-state", recorder?.getState());
  });
  recorder.on("stopped", () => {
    logger.info("Recorder state", { state: recorder?.getState() });
    if (rendererReady && mainWindow)
      mainWindow.webContents.send("zrada:recorder-state", recorder?.getState());
    // automatic merge on STOP
    try {
      const lastExitCode =
        typeof (recorder as any)?.getLastFfmpegExitCode === "function"
          ? (recorder as any).getLastFfmpegExitCode()
          : 0;
      if (lastExitCode !== 0 && lastExitCode !== null) {
        logger.warn("Auto-merge skipped after ffmpeg error", {
          code: lastExitCode,
          stderrTail:
            typeof (recorder as any)?.getLastFfmpegErrorTail === "function"
              ? (recorder as any).getLastFfmpegErrorTail()
              : "",
        });
        return;
      }
      const sessionSegs =
        typeof (recorder as any)?.getSessionSegments === "function"
          ? (recorder as any).getSessionSegments()
          : [];
      const segs = sessionSegs.length > 0 ? sessionSegs : [];
      logger.info("Recorder stopped segment scan", {
        sessionCount: sessionSegs.length,
        legacyAutoMergeFallbackUsed: false,
        summary: summarizeSegmentFiles(segs),
      });
      if (segs.length > 0 && merger) {
        const outDir = path.join(app.getPath("userData"), "output");
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, formatNowForFilename());
        // obtain recorder FPS
        let inputFpsRaw: any = 1;
        try {
          inputFpsRaw = recorder?.getFps?.();
        } catch (_) {
          inputFpsRaw = 1;
        }
        let resolvedInputFps = 1;
        if (typeof inputFpsRaw === "number") resolvedInputFps = inputFpsRaw;
        else if (
          inputFpsRaw &&
          typeof inputFpsRaw === "object" &&
          "fps" in inputFpsRaw
        )
          resolvedInputFps = Number((inputFpsRaw as any).fps) || 1;
        else resolvedInputFps = 1;

        // If recorder is in image mode, assemble images into a video
        try {
          const mode = (recorder as any).getMode
            ? (recorder as any).getMode()
            : "video";
          if (mode === "video") {
            const stats = getFilesStats(segs);
            logger.info("Auto-merge video segment diagnostics", {
              mode,
              inputFps: resolvedInputFps,
              outputFps,
              stats,
              summary: summarizeSegmentFiles(segs),
            });
            const tooLarge =
              stats.totalBytes > AUTO_MERGE_MAX_VIDEO_BYTES ||
              stats.existing > AUTO_MERGE_MAX_VIDEO_SEGMENTS;
            if (tooLarge) {
              const message =
                "Auto-merge skipped: too many or too large video segments. Use manual merge when the workstation is idle.";
              logger.warn(message, {
                count: segs.length,
                existing: stats.existing,
                totalBytes: stats.totalBytes,
                maxBytes: AUTO_MERGE_MAX_VIDEO_BYTES,
                maxSegments: AUTO_MERGE_MAX_VIDEO_SEGMENTS,
                missing: stats.missing.length,
                outPath,
              });
              if (rendererReady && mainWindow) {
                mainWindow.webContents.send("zrada:merge-error", message);
              }
              return;
            }
          }

          logger.info("Auto-merge triggered on stop", {
            count: segs.length,
            outPath,
            mode,
          });

          if (mode === "image") {
            // assume images are in segments/images/img_%06d.jpg
            const imagesPattern = path.join(
              app.getPath("userData"),
              "segments",
              "images",
              "img_%06d.jpg",
            );
            const args = [
              "-y",
              "-framerate",
              String(outputFps),
              "-i",
              imagesPattern,
              "-c:v",
              "libx264",
              "-pix_fmt",
              "yuv420p",
              outPath,
            ];
            logger.info("Assembling images to video", { args });
            const ff = spawn(FFMPEG_PATH, args, { windowsHide: true });
            ff.stderr.on("data", (c) =>
              logger.debug("ffmpeg", { stderr: c.toString() }),
            );
            ff.on("close", (code) => {
              if (code === 0) {
                logger.info("Image-assemble finished", { outPath });
                if (rendererReady && mainWindow)
                  mainWindow.webContents.send("zrada:merge-done", outPath);
                // cleanup images
                try {
                  const imgDir = path.join(
                    app.getPath("userData"),
                    "segments",
                    "images",
                  );
                  if (fs.existsSync(imgDir)) {
                    const files = fs.readdirSync(imgDir);
                    for (const f of files) {
                      try {
                        fs.unlinkSync(path.join(imgDir, f));
                      } catch (_) {}
                    }
                    logger.info("Images cleaned after assemble", {
                      cleaned: files.length,
                    });
                    if (rendererReady && mainWindow)
                      mainWindow.webContents.send("zrada:segments-cleaned");
                    // reset saved count since images were removed
                    try {
                      savedCount = 0;
                      if (mainWindow && mainWindow.webContents)
                        mainWindow.webContents.send("zrada:saved-count", {
                          count: savedCount,
                        });
                    } catch (_) {}
                  }
                } catch (e: any) {
                  logger.error("Images cleanup failed", { err: e?.message });
                }
              } else {
                logger.error("Image assemble failed", { code });
                if (rendererReady && mainWindow)
                  mainWindow.webContents.send(
                    "zrada:merge-error",
                    `ffmpeg exit ${code}`,
                  );
              }
            });
          } else {
            // default: use MergerService for video segments
            merger
              .mergeSegments(segs, outPath, {
                inputFps: resolvedInputFps,
                outputFps,
              })
              .then(() => {
                logger.info("Auto-merge finished", { outPath });
                if (rendererReady && mainWindow)
                  mainWindow.webContents.send("zrada:merge-done", outPath);
                // delete segments after successful merge
                try {
                  for (const s of segs) {
                    try {
                      fs.unlinkSync(s);
                    } catch (_) {}
                  }
                  logger.info("Segments cleaned after merge", {
                    cleaned: segs.length,
                  });
                  if (rendererReady && mainWindow)
                    mainWindow.webContents.send("zrada:segments-cleaned");
                } catch (e: any) {
                  logger.error("Segment cleanup failed", { err: e?.message });
                }
              })
              .catch((err) => {
                logger.error("Auto-merge failed", { err: err.message });
                if (rendererReady && mainWindow)
                  mainWindow.webContents.send("zrada:merge-error", err.message);
              });
          }
        } catch (e: any) {
          logger.error("Auto-merge handler failed", { err: e?.message });
        }
      }
    } catch (e: any) {
      logger.error("Auto-merge error", { err: e?.message });
    }
  });
  // forward dedup fallback notifications (recorder may have auto-disabled dedup to preserve output)
  recorder.on("dedup-fallback", (info: any) => {
    try {
      logger.warn("Recorder dedup fallback", info);
      if (rendererReady && mainWindow)
        mainWindow.webContents.send("zrada:dedup-fallback", info);
    } catch (_) {}
  });
  // forward image/segment events and provide simple used/skip heuristic
  let lastImageSize: number | null = null;
  const recentFrames: Array<{
    file: string;
    size: number;
    status: string;
    ts: string;
  }> = [];
  recorder.on("image", (filePath: string) => {
    try {
      let status = "used";
      let size = 0;
      try {
        const st = fs.statSync(filePath);
        size = st.size;
      } catch (_) {
        size = 0;
      }
      if (lastImageSize !== null && lastImageSize > 0 && size > 0) {
        const diff = Math.abs(size - lastImageSize);
        const ratio = diff / Math.max(size, lastImageSize);
        // if size very similar (within 2%) treat as skipped candidate
        if (ratio <= 0.02) status = "skipped";
      }
      lastImageSize = size || lastImageSize;
      logger.debug("Image event", { filePath, size, status });
      // increment saved counter when an image is actually promoted/written
      try {
        savedCount = (savedCount || 0) + 1;
      } catch (_) {
        savedCount = savedCount + 1;
      }
      try {
        if (mainWindow && mainWindow.webContents)
          mainWindow.webContents.send("zrada:saved-count", {
            count: savedCount,
          });
      } catch (_) {}
      // keep small in-memory buffer for renderer to query
      try {
        recentFrames.push({
          file: filePath,
          size: size || 0,
          status,
          ts: new Date().toISOString(),
        });
        if (recentFrames.length > 64) recentFrames.shift();
      } catch (_) {}
      logger.info("Forwarding frame to renderer", {
        file: filePath,
        size,
        status,
      });
      if (mainWindow && mainWindow.webContents)
        mainWindow.webContents.send("zrada:frame", {
          file: filePath,
          size,
          status,
        });
    } catch (e: any) {
      logger.error("Forward image event failed", { err: e?.message });
    }
  });
  // forward candidate events (immediate used/skipped decisions before promotion)
  recorder.on("candidate", (payload: any) => {
    try {
      if (mainWindow && mainWindow.webContents)
        mainWindow.webContents.send("zrada:frame-candidate", payload);
    } catch (e: any) {
      logger.error("Forward candidate event failed", { err: e?.message });
    }
  });
  recorder.on("segment", (filePath: string) => {
    try {
      if (mainWindow && mainWindow.webContents)
        mainWindow.webContents.send("zrada:segment", { file: filePath });
    } catch (e: any) {
      logger.error("Forward segment event failed", { err: e?.message });
    }
  });

  ipcMain.handle("zrada:get-recent-frames", () => {
    try {
      return { ok: true, frames: recentFrames.slice(-16) };
    } catch (e: any) {
      logger.error("Get recent frames failed", { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle("zrada:get-saved-count", () => {
    try {
      return { ok: true, count: savedCount };
    } catch (e: any) {
      logger.error("Get saved count failed", { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });
  // now emit startup info (after window created and forwarder registered)
  logger.info("App starting", { platform: os.platform() });
  // welcome + structured startup info
  logger.info("Welcome to ZradaLog", { message: "ZradaLog started" });

  const startupConfig = {
    fps: 1,
    segmentIntervalSec: 300,
    codec: "libx264",
    crf: 23,
    maxDurationSec: 8 * 3600,
    maxSizeBytes: 5 * 1024 * 1024 * 1024,
  };
  logger.info("Default configuration", startupConfig);

  const sysInfo = {
    platform: os.platform(),
    arch: os.arch(),
    cpuCount: os.cpus().length,
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    nodeVersion: process.version,
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    appVersion: app.getVersion(),
    userDataPath: app.getPath("userData"),
  };
  logger.info("System info", sysInfo);

  // listen for renderer readiness signal and flush pending logs
  ipcMain.on("zrada:renderer-ready", () => {
    rendererReady = true;
    if (mainWindow && mainWindow.webContents) {
      for (const e of pendingLogs) mainWindow.webContents.send("zrada:log", e);
      pendingLogs.length = 0;
      try {
        mainWindow.webContents.send("zrada:saved-count", { count: savedCount });
      } catch (_) {}
    }
  });

  ipcMain.on("zrada:log:fromRenderer", (_ev, payload) => {
    const { level, message, meta } = payload;
    // write to main logger
    (logger as LoggerService).log(level, message, meta);
  });

  // control messages from renderer (start/pause/resume/stop)
  ipcMain.on("zrada:control", (_ev, action: string) => {
    if (!recorder) return;
    switch (action) {
      case "start": {
        try {
          const active = checkActiveCaptureProcesses();
          if (active && active.length > 0) {
            logger.warn("Start blocked: active capture processes detected", {
              count: active.length,
            });
            if (mainWindow && mainWindow.webContents)
              mainWindow.webContents.send("zrada:start-blocked", {
                procs: active,
              });
            return;
          }
        } catch (e: any) {
          logger.error("Start pre-check failed", { err: e?.message });
        }
        try {
          recorder.setDedupSettings && recorder.setDedupSettings(dedupSettings);
        } catch (_) {}
        recorder.start();
        break;
      }
      case "pause":
        recorder.pause();
        break;
      case "resume":
        recorder.resume();
        break;
      case "stop":
        recorder.stop();
        break;
    }
  });

  ipcMain.handle("zrada:get-state", () => {
    return recorder ? recorder.getState() : "idle";
  });

  ipcMain.handle("zrada:set-fps", (_ev, fps: number) => {
    try {
      const v = Number(fps) || 1;
      recorder?.setFps(v);
      logger.info("FPS set via IPC", { fps: v });
      try {
        settingsCache = settingsCache || {};
        settingsCache.fps = v;
        saveSettings();
      } catch (_) {}
      return { ok: true, fps: v };
    } catch (e: any) {
      logger.error("Set FPS failed", { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle("zrada:get-fps", () => {
    try {
      const v = recorder ? recorder.getFps() : 1;
      return { ok: true, fps: v };
    } catch (e: any) {
      logger.error("Get FPS failed", { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle("zrada:open-output", async () => {
    try {
      const dir = path.join(app.getPath("userData"), "output");
      // ensure exists
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      await shell.openPath(dir);
      return { ok: true, dir };
    } catch (e: any) {
      logger.error("Open output folder failed", { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle("zrada:delete-all", async () => {
    try {
      const userData = app.getPath("userData");
      const dirsToClean = ["segments", "output", "logs"];
      let deleted = 0;

      for (const dirName of dirsToClean) {
        const dir = path.join(userData, dirName);
        if (fs.existsSync(dir)) {
          const items = fs.readdirSync(dir);
          for (const it of items) {
            const p = path.join(dir, it);
            try {
              await shell.trashItem(p);
              deleted++;
            } catch (_) {}
          }
        }
      }

      // update savedCount conservatively (don't go negative)
      try {
        savedCount = Math.max(0, (savedCount || 0) - deleted);
      } catch (_) {
        savedCount = 0;
      }
      try {
        if (mainWindow && mainWindow.webContents)
          mainWindow.webContents.send("zrada:saved-count", {
            count: savedCount,
          });
      } catch (_) {}
      logger.info("Moved application files to Recycle Bin", {
        moved: deleted,
        savedCount,
      });
      return { ok: true, deleted };
    } catch (e: any) {
      logger.error("Delete all failed", { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle("zrada:merge-all", async () => {
    try {
      if (!merger) throw new Error("Merger not initialized");

      const userData = app.getPath("userData");
      const segmentsDir = path.join(userData, "segments");

      logger.info("Manual merge requested", { segmentsDir });

      if (!fs.existsSync(segmentsDir)) {
        logger.warn("Segments directory not found", { segmentsDir });
        throw new Error("No segments directory found");
      }

      const allFiles = fs.readdirSync(segmentsDir);
      logger.info("Files in segments dir", {
        count: allFiles.length,
        files: allFiles,
      });

      const files = allFiles
        .filter((f) => f.endsWith(".mp4"))
        .map((f) => path.join(segmentsDir, f));
      logger.info("MP4 files found", {
        count: files.length,
        files: files.map((f) => path.basename(f)),
      });

      if (files.length === 0) {
        logger.warn("No MP4 segment files found");
        throw new Error("No segment files found");
      }

      const outputDir = path.join(userData, "output");

      // ensure output dir exists
      if (!fs.existsSync(outputDir))
        fs.mkdirSync(outputDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outPath = path.join(outputDir, `merged_${timestamp}.mp4`);

      logger.info("Starting manual merge", {
        outPath,
        segments: files.length,
        outputFps,
      });

      await merger.mergeSegments(files, outPath, {
        inputFps: 1,
        outputFps: outputFps,
      });

      logger.info("Manual merge completed successfully", { outPath });
      return { ok: true, outPath };
    } catch (e: any) {
      logger.error("Manual merge failed", { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle("zrada:check-segments", async () => {
    try {
      const userData = app.getPath("userData");
      const segmentsDir = path.join(userData, "segments");

      if (!fs.existsSync(segmentsDir)) {
        return { ok: true, hasSegments: false, count: 0 };
      }

      const files = fs
        .readdirSync(segmentsDir)
        .filter((f) => f.endsWith(".mp4"));
      return { ok: true, hasSegments: files.length > 0, count: files.length };
    } catch (e: any) {
      logger.error("Check segments failed", { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle("zrada:set-output-fps", (_ev, fps: number) => {
    try {
      const v = Number(fps) || 24;
      outputFps = v;
      logger.info("Output FPS set via IPC", { outputFps: v });
      try {
        settingsCache = settingsCache || {};
        settingsCache.outputFps = outputFps;
        saveSettings();
      } catch (_) {}
      try {
        recorder?.setOutputFps && recorder.setOutputFps(outputFps);
      } catch (_) {}
      return { ok: true, fps: v };
    } catch (e: any) {
      logger.error("Set output FPS failed", { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle("zrada:get-mpdecimate", () => {
    try {
      return { ok: true, mpdecimate: mpdecimateSettings };
    } catch (e: any) {
      logger.error("Get mpdecimate settings failed", { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle("zrada:set-mpdecimate", (_ev, s: any) => {
    try {
      mpdecimateSettings.enabled =
        typeof s?.enabled === "boolean"
          ? s.enabled
          : mpdecimateSettings.enabled;
      mpdecimateSettings.hi =
        typeof s?.hi === "number" ? s.hi : mpdecimateSettings.hi;
      mpdecimateSettings.lo =
        typeof s?.lo === "number" ? s.lo : mpdecimateSettings.lo;
      mpdecimateSettings.frac =
        typeof s?.frac === "number" ? s.frac : mpdecimateSettings.frac;
      logger.info("Mpdecimate settings updated", mpdecimateSettings);
      try {
        settingsCache = settingsCache || {};
        settingsCache.mpdecimateSettings = mpdecimateSettings;
        saveSettings();
      } catch (_) {}
      try {
        recorder?.setMpdecimateSettings &&
          recorder.setMpdecimateSettings(mpdecimateSettings);
      } catch (_) {}
      return { ok: true, mpdecimate: mpdecimateSettings };
    } catch (e: any) {
      logger.error("Set mpdecimate settings failed", { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle("zrada:get-output-fps", () => {
    try {
      return { ok: true, fps: outputFps };
    } catch (e: any) {
      logger.error("Get output FPS failed", { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle("zrada:set-mode", (_ev, mode: "video" | "image") => {
    try {
      recorder?.setMode(mode);
      logger.info("Recorder mode set via IPC", { mode });
      try {
        settingsCache = settingsCache || {};
        settingsCache.mode = mode;
        saveSettings();
      } catch (_) {}
      return { ok: true, mode };
    } catch (e: any) {
      logger.error("Set mode failed", { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });
  ipcMain.handle("zrada:get-dedup-settings", () => {
    return { ok: true, settings: dedupSettings };
  });
  ipcMain.handle("zrada:set-dedup-settings", (_ev, s: any) => {
    try {
      dedupSettings.algorithm = s?.algorithm ?? dedupSettings.algorithm;
      dedupSettings.threshold =
        typeof s?.threshold === "number"
          ? s.threshold
          : dedupSettings.threshold;
      dedupSettings.enabled =
        typeof s?.enabled === "boolean" ? s.enabled : dedupSettings.enabled;
      logger.info("Dedup settings updated", dedupSettings);
      try {
        settingsCache = settingsCache || {};
        settingsCache.dedupSettings = dedupSettings;
        saveSettings();
      } catch (_) {}
      try {
        recorder?.setDedupSettings && recorder.setDedupSettings(dedupSettings);
      } catch (_) {}
      return { ok: true, settings: dedupSettings };
    } catch (e: any) {
      logger.error("Set dedup settings failed", { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle("zrada:get-settings", () => {
    try {
      const s = loadSettings() || {};
      return { ok: true, settings: s };
    } catch (e: any) {
      logger.error("Get settings failed", { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle("zrada:preview-dedup-scan", async (_ev, opts: any) => {
    try {
      const sampleN = Number(opts?.sampleN) || 200;
      const alg = opts?.algorithm ?? dedupSettings.algorithm;
      const thr =
        Number(opts?.threshold ?? dedupSettings.threshold) ||
        dedupSettings.threshold;
      const imagesDir = path.join(
        app.getPath("userData"),
        "segments",
        "images",
      );
      if (!fs.existsSync(imagesDir))
        return { ok: true, total: 0, kept: 0, discarded: 0 };
      const files = fs
        .readdirSync(imagesDir)
        .filter((f) => /\.(jpe?g|png)$/i.test(f))
        .sort();
      const sample = files.slice(Math.max(0, files.length - sampleN));

      // Simple heuristic: group by file size to approximate duplicates
      const groups: Record<number, string[]> = {};
      for (const f of sample) {
        try {
          const st = fs.statSync(path.join(imagesDir, f));
          const k = Math.round(st.size / 100); // coarse bucket
          groups[k] = groups[k] || [];
          groups[k].push(f);
        } catch (_) {}
      }
      let kept = 0;
      let discarded = 0;
      for (const k of Object.keys(groups)) {
        const arr = groups[Number(k)];
        if (arr.length > 0) {
          kept += 1;
          discarded += arr.length - 1;
        }
      }
      const total = sample.length;
      logger.info("Preview dedup scan", {
        algorithm: alg,
        threshold: thr,
        total,
        kept,
        discarded,
      });
      return {
        ok: true,
        algorithm: alg,
        threshold: thr,
        total,
        kept,
        discarded,
        status: "done",
      };
    } catch (e: any) {
      logger.error("Preview dedup scan failed", { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle("zrada:check-active-capture-processes", () => {
    try {
      const procs = checkActiveCaptureProcesses();
      return { ok: true, procs };
    } catch (e: any) {
      logger.error("Check active capture processes failed", {
        err: e?.message,
      });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle("zrada:set-settings", (_ev, s: any) => {
    try {
      settingsCache = settingsCache || {};
      settingsCache = { ...settingsCache, ...(s || {}) };
      if (s?.dedupSettings) {
        dedupSettings = { ...dedupSettings, ...s.dedupSettings };
      }
      if (s?.outputFps) outputFps = Number(s.outputFps) || outputFps;
      saveSettings();
      return { ok: true, settings: settingsCache };
    } catch (e: any) {
      logger.error("Set settings failed", { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle("zrada:get-mode", () => {
    try {
      const m = recorder?.getMode ? recorder.getMode() : "video";
      return { ok: true, mode: m };
    } catch (e: any) {
      logger.error("Get mode failed", { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  ipcMain.handle("zrada:clear-logs", async () => {
    try {
      (logger as LoggerService).clear();
      return { ok: true };
    } catch (e: any) {
      logger.error("Clear logs failed", { err: e?.message });
      return { ok: false, err: e?.message };
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function pad(n: number, w = 2) {
  return n.toString().padStart(w, "0");
}
function formatNowForFilename() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const MM = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  return `zradalog_${yyyy}_${MM}_${dd}_${hh}_${mm}.mp4`;
}

app.on("window-all-closed", () => {
  logger && logger.close();
  if (process.platform !== "darwin") app.quit();
});

// ensure recorder is stopped cleanly before quitting to avoid orphaned ffmpeg/image writes
app.on("before-quit", (ev) => {
  try {
    if (recorder && typeof recorder.getState === "function") {
      const st = recorder.getState();
      if (st === "recording" || st === "paused" || st === "stopping") {
        // prevent immediate quit until we've attempted to stop recorder
        try {
          ev.preventDefault();
        } catch (_) {}
        try {
          recorder.stop();
        } catch (_) {}
        // wait a short time for cleanup, then force kill if still running
        setTimeout(() => {
          try {
            const st2 = recorder?.getState?.();
            if (st2 === "recording" || st2 === "stopping" || st2 === "paused") {
              try {
                (recorder as any).forceKill && (recorder as any).forceKill();
              } catch (_) {}
            }
          } catch (_) {}
          // allow quit to continue
          try {
            app.exit(0);
          } catch (_) {
            process.exit(0);
          }
        }, 3500);
      }
    }
  } catch (_) {}
});
