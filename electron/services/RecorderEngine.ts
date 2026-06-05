import { EventEmitter } from "events";
import { LoggerService } from "./LoggerService";
import {
  spawn,
  spawnSync,
  ChildProcessWithoutNullStreams,
} from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { app, dialog } from "electron";
import { getFFmpegPath } from "../utils/ffmpegUtils";

const FFMPEG_PATH = getFFmpegPath();
// Quick-config: batch size for promotions (change this macro to tune behavior)
const BATCH_SIZE = 10;
const MAX_PENDING = 100;
const RETRY_POLICY_MS = [100, 300, 900];
const FFMPEG_PROGRESS_DIAG_INTERVAL_MS = 30000;
const FFMPEG_SESSION_PROGRESS_LOG_INTERVAL_MS = 10000;

export type RecorderState =
  | "idle"
  | "recording"
  | "paused"
  | "stopping"
  | "stopped";

export class RecorderEngine extends EventEmitter {
  private logger: LoggerService;
  private state: RecorderState = "idle";
  private segmentIntervalSec: number = 300; // default 5 minutes
  private fps: number = 1; // capture FPS (capture rate)
  private ff?: ChildProcessWithoutNullStreams;
  private segmentsDir: string;
  private segments: string[] = [];
  private sessionSegments: string[] = [];
  private imageWatcher?: fs.FSWatcher;
  private emittedImages: Set<string> = new Set();
  private emittedTmp: Set<string> = new Set();
  private finalImageIndex = 0;
  private lastAcceptedSize: number | null = null;
  private pendingPromotions: Array<{ tmp: string; dest: string }> = [];
  private batchInProgress = false;
  private promotionInterval?: NodeJS.Timeout;
  private codec = "libx264";
  private crf = 23;
  private mode: "video" | "image" = "video";
  private dedupSettings: {
    algorithm: string;
    enabled: boolean;
    threshold: number;
  } = { algorithm: "scene", enabled: false, threshold: 12 };
  private outputFps: number = 30;
  private mpdecimateSettings: {
    enabled: boolean;
    hi: number;
    lo: number;
    frac: number;
    drawtext?: string;
  } = {
    enabled: true,
    hi: 20000,
    lo: 1500,
    frac: 0.3,
    drawtext:
      "font='Arial':text='Frame\\: %{n} | Time\\: %{pts\\:hms}':x=(w-text_w)/2:y=h-text_h-20:fontcolor=red:fontsize=36:box=1:boxcolor=black@1",
  };

  // ffmpeg stderr buffering / debug
  private ffmpegLogLines: string[] = [];
  private ffmpegLogBytes: number = 0;
  private ffmpegLogMaxBytes = 10 * 1024 * 1024; // 10 MB
  private ffmpegLogMaxLines = 2000;
  private ffmpegDebug = true; // default on during development
  // Rolling buffer of last stderr lines — flushed to main log on non-zero exit
  private ffmpegLastStderr: string[] = [];
  private readonly STDERR_TAIL_LINES = 30;
  private lastFfmpegExitCode: number | null = null;
  private lastFfmpegErrorTail = "";

  private sessionLogPath: string | null = null;
  private lastSessionLogPath: string | null = null;
  private sessionLogStream: fs.WriteStream | null = null;
  private sessionLogMaxFiles = 10;
  private ffmpegSpawnedAtMs = 0;
  private lastSegmentSeenAtMs: number | null = null;
  private lastSegmentIndex: number | null = null;
  private progressDiagLastAtMs = 0;
  private sessionProgressLogLastAtMs = 0;
  private currentSessionStartIndex = 0;
  private currentPreviousCompressedSec = 0;
  private currentSessionStartStr = "";

  constructor(logger: LoggerService) {
    super();
    this.logger = logger;
    const userData = app.getPath("userData");
    this.segmentsDir = path.join(userData, "segments");
    if (!fs.existsSync(this.segmentsDir))
      fs.mkdirSync(this.segmentsDir, { recursive: true });
    // ensure image subdir exists for image-sequence mode
    const imgDir = path.join(this.segmentsDir, "images");
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
    this.logger.info("RecorderEngine initialized", {
      segmentsDir: this.segmentsDir,
    });
  }

  public setMode(mode: "video" | "image") {
    this.mode = mode;
    this.logger.info("Recorder mode set", { mode });
  }

  public getMode() {
    return this.mode;
  }

  public setSegmentInterval(seconds: number) {
    this.segmentIntervalSec = seconds;
    this.logger.debug("Segment interval set", { seconds });
  }

  // capture FPS (used for -framerate)
  public setFps(fps: number) {
    this.fps = fps;
    this.logger.debug("FPS set", { fps });
  }

  public getFps() {
    return this.fps;
  }

  public setDedupSettings(
    s: Partial<{ algorithm: string; enabled: boolean; threshold: number }>,
  ) {
    try {
      this.dedupSettings = { ...this.dedupSettings, ...(s || {}) };
      this.logger.info("Recorder dedup settings updated", {
        dedup: this.dedupSettings,
      });
    } catch (_) {}
  }

  public setMpdecimateSettings(
    s: Partial<{
      enabled: boolean;
      hi: number;
      lo: number;
      frac: number;
      drawtext?: string;
    }>,
  ) {
    try {
      this.mpdecimateSettings = { ...this.mpdecimateSettings, ...(s || {}) };
      this.logger.info("Recorder mpdecimate settings updated", {
        mpdecimate: this.mpdecimateSettings,
      });
    } catch (_) {}
  }

  public setOutputFps(fps: number) {
    try {
      this.outputFps = Number(fps) || this.outputFps;
      this.logger.info("Recorder outputFps set", { outputFps: this.outputFps });
    } catch (_) {}
  }

  public getSegments() {
    // NOTE: the outer try only guards readdirSync; each stat is wrapped
    // individually so that a locked/inaccessible file (e.g. the open session
    // log on Windows returning EPERM) does NOT abort the entire scan and
    // cause us to miss real segment files.
    try {
      const files: string[] = [];
      const top = fs
        .readdirSync(this.segmentsDir)
        .map((f) => path.join(this.segmentsDir, f));
      for (const p of top) {
        try {
          const stat = fs.statSync(p);
          if (stat.isFile()) {
            files.push(p);
          } else if (stat.isDirectory()) {
            try {
              const inner = fs.readdirSync(p).map((f) => path.join(p, f));
              for (const ip of inner) files.push(ip);
            } catch (_) {}
          }
        } catch (_) {
          // Skip files that cannot be stat'd (locked open handles on Windows, etc.)
        }
      }
      return files.sort();
    } catch {
      return [];
    }
  }

  public getSessionSegments() {
    return this.sessionSegments.slice().sort();
  }

  public getLastSessionLogPath() {
    return this.lastSessionLogPath;
  }

  public getLastFfmpegExitCode() {
    return this.lastFfmpegExitCode;
  }

  public getLastFfmpegErrorTail() {
    return this.lastFfmpegErrorTail;
  }

  private buildFfmpegArgs(
    outPattern: string,
    startNumber = 0,
    skipDedup = false,
    outputFps = 30,
    previousCompressedSec = 0,
    previousActiveSec = 0,
    sessionStartStr = "",
  ) {
    const args: string[] = [
      "-y",
      "-f",
      "gdigrab",
      "-framerate",
      String(this.fps),
      "-i",
      "desktop",
      "-filter_threads",
      "1",
      "-c:v",
      this.codec,
      "-preset",
      "veryfast",
      "-crf",
      String(this.crf),
      "-g",
      String(Math.max(2, Math.ceil(this.fps * 2))),
      "-threads",
      "2",
      "-f",
      "segment",
      "-reset_timestamps",
      "1",
      "-segment_time",
      String(this.segmentIntervalSec),
      "-segment_start_number",
      String(startNumber),
      outPattern,
    ];

    // Optional: insert dedup filter only if explicitly enabled and not skipped.
    // We keep filter insertion but DO NOT perform automatic restart if filter removes frames.
    try {
      // Prefer mpdecimate-based dedup in video mode when enabled
      if (
        this.mode === "video" &&
        !skipDedup &&
        this.mpdecimateSettings &&
        this.mpdecimateSettings.enabled
      ) {
        const hi = Number(this.mpdecimateSettings.hi) || 20000;
        const lo = Number(this.mpdecimateSettings.lo) || 1500;
        const frac = Number(this.mpdecimateSettings.frac) || 0.3;
        // Overlay is drawn after mpdecimate and before setpts. Both Total and
        // Compressed are derived from accepted frame count to avoid jumps from
        // long unchanged periods in the source timestamp.
        const inputFps = this.fps > 0 ? this.fps : 1;
        const prevCompSec = Math.max(0, previousCompressedSec);
        const prevActiveSec = Math.max(0, previousActiveSec);

        const totalSecV = `(n/${inputFps})+${prevActiveSec}`;
        const compressedSecV = `(n/${outputFps})+${prevCompSec}`;
        const totalH = `%{eif\\:(${totalSecV})/3600\\:d}`;
        const totalM = `%{eif\\:mod((${totalSecV})/60,60)\\:d\\:2}`;
        const compressedSec = `%{eif\\:${compressedSecV}\\:d}`;

        // Current date-time via separate localtime calls (avoids colon-in-format issues).
        const startLabel = sessionStartStr || "????-??-?? ??\\:??";
        const curDate = `%{localtime\\:%Y-%m-%d}`;
        const curHM = `%{localtime\\:%H}\\:%{localtime\\:%M}`;

        const overlayText =
          `Work From ${startLabel} To ${curDate} ${curHM}` +
          ` | Total ${totalH}h ${totalM}m` +
          ` | Compressed ${compressedSec} sec`;

        const dt =
          `drawtext=font='Arial'` +
          `:text='${overlayText}'` +
          `:x=(w-text_w)/2:y=h-50:fontcolor=yellow:fontsize=22:box=1:boxcolor=black@0.8`;

        const vf = [
          `mpdecimate=hi=${hi}:lo=${lo}:frac=${frac}`,
          dt,
          `settb=AVTB`,
          `setpts=N/(${outputFps}*TB)`,
          `fps=${outputFps}`,
          `format=yuv420p`,
        ].join(",");

        // Insert before the segment muxer (-f segment)
        const segIndex = args.findIndex(
          (a, i) => a === "-f" && args[i + 1] === "segment",
        );
        let insertAt = -1;
        if (segIndex !== -1) insertAt = segIndex;
        if (insertAt === -1) insertAt = args.length - 1;
        args.splice(
          insertAt,
          0,
          "-vf",
          vf,
          "-vsync",
          "cfr",
          "-r",
          String(outputFps),
        );
        this.logger.info("Applied overlay filter", {
          mpdecimate: { hi, lo, frac },
          prevCompSec,
          prevActiveSec,
          inputFps,
          sessionStartStr,
          outputFps,
        });
      }
      // No dedup fallback for video mode - mpdecimate only
    } catch (err) {
      this.logger.warn("Applying video dedup filter failed", {
        err: (err as any)?.message,
      });
    }

    return args;
  }

  private buildImageArgs(outPattern: string) {
    const args: string[] = [
      "-y",
      "-f",
      "gdigrab",
      "-framerate",
      String(this.fps),
      "-i",
      "desktop",
      "-vf",
      `fps=${this.fps}`,
      outPattern,
    ];
    return args;
  }

  private computeNextIndex(fileNames: string[]) {
    let max = -1;
    for (const name of fileNames) {
      const m = name.match(/segment_(\d+)\.mp4$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!isNaN(n) && n > max) max = n;
      }
    }
    return max + 1;
  }

  private extractSegmentIndex(file: string) {
    const m = path.basename(file).match(/^segment_(\d+)\.mp4$/i);
    if (!m) return null;
    const index = parseInt(m[1], 10);
    return Number.isFinite(index) ? index : null;
  }

  private parseFfmpegProgress(text: string) {
    const frameMatches = [...text.matchAll(/frame=\s*(\d+)/g)];
    const fpsMatches = [...text.matchAll(/fps=\s*([0-9.]+)/g)];
    const timeMatches = [...text.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
    const speedMatches = [...text.matchAll(/speed=\s*([0-9.]+)x/g)];
    const frameMatch = frameMatches[frameMatches.length - 1];
    const fpsMatch = fpsMatches[fpsMatches.length - 1];
    const timeMatch = timeMatches[timeMatches.length - 1];
    const speedMatch = speedMatches[speedMatches.length - 1];
    let outTimeSec: number | null = null;
    if (timeMatch) {
      const hours = Number(timeMatch[1]);
      const minutes = Number(timeMatch[2]);
      const seconds = Number(timeMatch[3]);
      if (
        Number.isFinite(hours) &&
        Number.isFinite(minutes) &&
        Number.isFinite(seconds)
      ) {
        outTimeSec = hours * 3600 + minutes * 60 + seconds;
      }
    }
    return {
      frame: frameMatch ? Number(frameMatch[1]) : null,
      fps: fpsMatch ? Number(fpsMatch[1]) : null,
      outTimeSec,
      speed: speedMatch ? Number(speedMatch[1]) : null,
    };
  }

  private getFileDiag(file: string) {
    try {
      const st = fs.statSync(file);
      return {
        exists: true,
        size: st.size,
        birthtime: st.birthtime.toISOString(),
        mtime: st.mtime.toISOString(),
      };
    } catch (e: any) {
      return {
        exists: false,
        err: e?.message,
      };
    }
  }

  private collectMemoryDiagnostics() {
    const basic = {
      osTotalMemBytes: os.totalmem(),
      osFreeMemBytes: os.freemem(),
      processMemory: process.memoryUsage(),
      processPid: process.pid,
    };

    if (process.platform !== "win32") return { basic };

    try {
      const ps = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$c = Get-Counter '\\Memory\\Committed Bytes','\\Memory\\Commit Limit','\\Memory\\Available MBytes','\\Paging File(_Total)\\% Usage'",
        "$map = @{}",
        "foreach ($s in $c.CounterSamples) { $map[$s.Path] = [double]$s.CookedValue }",
        "$commitUsed = ($map.Keys | Where-Object { $_ -like '*\\memory\\committed bytes' } | Select-Object -First 1)",
        "$commitLimit = ($map.Keys | Where-Object { $_ -like '*\\memory\\commit limit' } | Select-Object -First 1)",
        "$avail = ($map.Keys | Where-Object { $_ -like '*\\memory\\available mbytes' } | Select-Object -First 1)",
        "$page = ($map.Keys | Where-Object { $_ -like '*\\paging file(_total)\\% usage' } | Select-Object -First 1)",
        "$committedBytes = $(if ($commitUsed) { $map[$commitUsed] } else { $null })",
        "$commitLimitBytes = $(if ($commitLimit) { $map[$commitLimit] } else { $null })",
        "$commitUsagePercent = $(if ($committedBytes -and $commitLimitBytes) { [math]::Round(($committedBytes / $commitLimitBytes) * 100, 2) } else { $null })",
        "$top = Get-Process | Sort-Object PM -Descending | Select-Object -First 10 @{n='name';e={$_.ProcessName}},Id,@{n='privateBytes';e={$_.PM}},@{n='workingSetBytes';e={$_.WS}},@{n='pagedMemoryBytes';e={$_.PagedMemorySize64}},@{n='virtualMemoryBytes';e={$_.VirtualMemorySize64}}",
        "$named = Get-Process | Where-Object { $_.ProcessName -match '^(ffmpeg|electron|ZradaLog|firefox|chrome|msedge|X2)$' } | Sort-Object PM -Descending | Select-Object @{n='name';e={$_.ProcessName}},Id,@{n='privateBytes';e={$_.PM}},@{n='workingSetBytes';e={$_.WS}},@{n='pagedMemoryBytes';e={$_.PagedMemorySize64}},@{n='virtualMemoryBytes';e={$_.VirtualMemorySize64}}",
        "[pscustomobject]@{ counters = [pscustomobject]@{ committedBytes = $committedBytes; commitLimitBytes = $commitLimitBytes; commitUsagePercent = $commitUsagePercent; availableMBytes = $(if ($avail) { $map[$avail] } else { $null }); pagingFileUsagePercent = $(if ($page) { $map[$page] } else { $null }) }; topPrivateBytes = $top; namedProcesses = $named } | ConvertTo-Json -Compress -Depth 5",
      ].join("; ");

      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
        { encoding: "utf8", windowsHide: true, timeout: 8000 },
      );

      if (result.status !== 0 || !result.stdout?.trim()) {
        return {
          basic,
          windows: null,
          err: result.stderr || result.stdout || `status=${result.status}`,
        };
      }

      return {
        basic,
        windows: JSON.parse(result.stdout),
      };
    } catch (e: any) {
      return { basic, windows: null, err: e?.message };
    }
  }

  private getCompletedSegmentDurationSec(nextIndex: number) {
    let total = 0;
    try {
      if (!fs.existsSync(this.segmentsDir)) return 0;
      const files = fs
        .readdirSync(this.segmentsDir)
        .filter((name) => {
          const m = name.match(/^segment_(\d+)\.mp4$/);
          return m && parseInt(m[1], 10) < nextIndex;
        })
        .sort()
        .map((name) => path.join(this.segmentsDir, name));

      for (const file of files) {
        const seconds = this.probeDurationSec(file);
        if (Number.isFinite(seconds) && seconds > 0) total += seconds;
      }
    } catch (e: any) {
      this.logger.warn("Failed to compute prior compressed duration", {
        err: e?.message,
      });
    }
    return total;
  }

  private getSegmentDurationTotalSec(files: string[]) {
    let total = 0;
    for (const file of files) {
      const seconds = this.probeDurationSec(file);
      if (Number.isFinite(seconds) && seconds > 0) total += seconds;
    }
    return total;
  }

  private compressedToActiveSec(compressedSec: number) {
    const inputFps = this.fps > 0 ? this.fps : 1;
    return Math.max(0, compressedSec) * (this.outputFps / inputFps);
  }

  private getFirstCompletedSegmentStart(nextIndex: number) {
    try {
      if (!fs.existsSync(this.segmentsDir)) return null;
      const first = fs
        .readdirSync(this.segmentsDir)
        .map((name) => {
          const m = name.match(/^segment_(\d+)\.mp4$/);
          if (!m) return null;
          const index = parseInt(m[1], 10);
          if (!Number.isFinite(index) || index >= nextIndex) return null;
          return { index, file: path.join(this.segmentsDir, name) };
        })
        .filter(
          (item): item is { index: number; file: string } => item !== null,
        )
        .sort((a, b) => a.index - b.index)[0];
      if (!first) return null;

      const stat = fs.statSync(first.file);
      const durationMs = this.probeDurationSec(first.file) * 1000;
      const startMs = stat.mtime.getTime() - Math.max(0, durationMs);
      return new Date(startMs);
    } catch (e: any) {
      this.logger.warn("Failed to compute first segment start", {
        err: e?.message,
      });
      return null;
    }
  }

  private getFirstSegmentStartFromFiles(files: string[]) {
    try {
      const first = files
        .filter((file) => /^segment_\d+\.mp4$/i.test(path.basename(file)))
        .sort((a, b) => {
          const ai = this.extractSegmentIndex(a) ?? Number.POSITIVE_INFINITY;
          const bi = this.extractSegmentIndex(b) ?? Number.POSITIVE_INFINITY;
          return ai - bi;
        })[0];
      if (!first) return null;

      const stat = fs.statSync(first);
      const durationMs = this.probeDurationSec(first) * 1000;
      const startMs = stat.mtime.getTime() - Math.max(0, durationMs);
      return new Date(startMs);
    } catch (e: any) {
      this.logger.warn("Failed to compute first session segment start", {
        err: e?.message,
      });
      return null;
    }
  }

  private formatOverlayDateTime(date: Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}\\:${pad(date.getMinutes())}`
    );
  }

  private probeDurationSec(file: string) {
    const ffprobe = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nokey=1:noprint_wrappers=1",
        file,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (ffprobe.status === 0) {
      const seconds = parseFloat(String(ffprobe.stdout || "").trim());
      if (Number.isFinite(seconds)) return seconds;
    }

    const ffmpeg = spawnSync(FFMPEG_PATH, ["-i", file], {
      encoding: "utf8",
      windowsHide: true,
    });
    const output = `${ffmpeg.stderr || ""}\n${ffmpeg.stdout || ""}`;
    const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) return 0;
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const seconds = parseFloat(match[3]);
    if (
      !Number.isFinite(hours) ||
      !Number.isFinite(minutes) ||
      !Number.isFinite(seconds)
    ) {
      return 0;
    }
    return hours * 3600 + minutes * 60 + seconds;
  }

  private lowerProcessPriority(pid?: number) {
    if (process.platform !== "win32" || !pid) return;
    try {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.PriorityClass = 'BelowNormal' }`,
        ],
        { encoding: "utf8", windowsHide: true },
      );
      if (result.status === 0) {
        this.logger.info("Lowered ffmpeg process priority", {
          pid,
          priority: "BelowNormal",
        });
      } else {
        this.logger.warn("Failed to lower ffmpeg process priority", {
          pid,
          err: result.stderr || result.stdout,
        });
      }
    } catch (e: any) {
      this.logger.warn("Failed to lower ffmpeg process priority", {
        pid,
        err: e?.message,
      });
    }
  }

  private rotateSessionLogs() {
    try {
      if (!fs.existsSync(this.segmentsDir)) return;
      const files = fs
        .readdirSync(this.segmentsDir)
        .filter((f) => /^ffmpeg-session-.*\.log$/i.test(f))
        .map((f) => ({
          name: f,
          mtime: fs.statSync(path.join(this.segmentsDir, f)).mtime.getTime(),
        }))
        .sort((a, b) => a.mtime - b.mtime);
      if (files.length <= this.sessionLogMaxFiles) return;
      const toDelete = files.slice(
        0,
        Math.max(0, files.length - this.sessionLogMaxFiles),
      );
      for (const file of toDelete) {
        try {
          fs.unlinkSync(path.join(this.segmentsDir, file.name));
        } catch (_) {}
      }
    } catch (e) {
      this.logger.warn("rotateSessionLogs failed", {
        err: (e as any)?.message,
      });
    }
  }

  private openSessionLog() {
    try {
      if (!fs.existsSync(this.segmentsDir))
        fs.mkdirSync(this.segmentsDir, { recursive: true });
      this.rotateSessionLogs();
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const pid = process.pid;
      this.sessionLogPath = path.join(
        this.segmentsDir,
        `ffmpeg-session-${ts}-${pid}.log`,
      );
      this.lastSessionLogPath = this.sessionLogPath;
      this.sessionLogStream = fs.createWriteStream(this.sessionLogPath, {
        flags: "a",
        encoding: "utf8",
      });
      this.writeSessionLog(`[SESSION START] ${new Date().toISOString()}\n`);
    } catch (e) {
      this.logger.warn("openSessionLog failed", { err: (e as any)?.message });
      this.sessionLogStream = null;
      this.sessionLogPath = null;
    }
  }

  private closeSessionLog(reason: string) {
    try {
      if (this.sessionLogStream) {
        this.writeSessionLog(
          `[SESSION ${reason.toUpperCase()}] ${new Date().toISOString()}\n`,
        );
        this.sessionLogStream.end();
      }
    } catch (e) {
      this.logger.warn("closeSessionLog failed", { err: (e as any)?.message });
    } finally {
      this.sessionLogStream = null;
      this.sessionLogPath = null;
    }
  }

  private writeSessionLog(line: string) {
    try {
      if (this.sessionLogStream) {
        this.sessionLogStream.write(line);
      }
    } catch (e) {
      this.logger.warn("writeSessionLog failed", { err: (e as any)?.message });
    }
  }

  private shouldWriteSessionStderrChunk(chunk: string, now: number) {
    const lines = chunk
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return false;

    const isProgressOnly = lines.every((line) => /^frame=\s*\d+/.test(line));
    if (!isProgressOnly) return true;

    if (
      now - this.sessionProgressLogLastAtMs >=
      FFMPEG_SESSION_PROGRESS_LOG_INTERVAL_MS
    ) {
      this.sessionProgressLogLastAtMs = now;
      return true;
    }
    return false;
  }

  private async flushFfmpegLog(reason = "flush") {
    try {
      if (!this.ffmpegDebug) {
        this.ffmpegLogLines.length = 0;
        this.ffmpegLogBytes = 0;
        return;
      }
      if (this.sessionLogStream) {
        this.writeSessionLog(
          `[FLUSH ${reason.toUpperCase()}] ${new Date().toISOString()}\n`,
        );
      }
      this.ffmpegLogLines.length = 0;
      this.ffmpegLogBytes = 0;
    } catch (e: any) {
      this.logger.warn("Failed to flush ffmpeg log", { err: e?.message });
    }
  }

  public start() {
    if (this.state === "recording") return;
    if (!fs.existsSync(this.segmentsDir))
      fs.mkdirSync(this.segmentsDir, { recursive: true });
    const outPattern = path.join(this.segmentsDir, "segment_%04d.mp4");
    const outImagePattern = path.join(
      this.segmentsDir,
      "images",
      "tmp_%06d.tmp.jpg",
    );

    // check ffmpeg available
    try {
      const check = spawnSync(FFMPEG_PATH, ["-version"], { windowsHide: true });
      if (check.error || check.status !== 0) {
        const msg =
          "FFmpeg not found in PATH. Please install FFmpeg and ensure ffmpeg.exe is available in your PATH.";
        this.logger.error("ffmpeg missing", {
          err: check.error ? check.error.message : `status=${check.status}`,
        });
        try {
          dialog.showMessageBoxSync({
            type: "error",
            title: "FFmpeg not found",
            message: "FFmpeg executable not found",
            detail:
              msg +
              "\n\nRecommended: download from https://ffmpeg.org/download.html or install via Chocolatey: `choco install ffmpeg`",
          });
        } catch (_) {}
        this.emit("error", new Error("ffmpeg not found"));
        return;
      }
    } catch (err: any) {
      this.logger.error("ffmpeg detection failed", { err: err?.message });
      this.emit("error", err);
      return;
    }

    this.logger.info("Memory diagnostics before recorder start", {
      memory: this.collectMemoryDiagnostics(),
    });

    const isResuming = this.state === "paused";
    if (!isResuming) {
      this.sessionSegments = [];
      this.openSessionLog();
    } else {
      this.writeSessionLog(`[SESSION RESUME] ${new Date().toISOString()}\n`);
    }

    const existing = this.getSegments();
    const existingFiles = existing.map((f) => path.basename(f));
    this.logger.debug("Existing segments before start", {
      count: existing.length,
      files: existingFiles,
    });

    // Safety fallback: if we are resuming a paused session but the filesystem
    // scan returned nothing (can happen when the session log file is still
    // locked and a previous EPERM caused the scan to skip real segments),
    // use the in-memory segments list accumulated during this session so we
    // don't reset startIndex to 0 and overwrite existing footage.
    let filesForIndex = existingFiles;
    if (
      isResuming &&
      filesForIndex.filter((f) => /\.mp4$/i.test(f)).length === 0 &&
      this.segments.length > 0
    ) {
      const memFiles = this.segments.map((f) => path.basename(f));
      this.logger.warn(
        "getSegments() returned no mp4s while resuming — falling back to in-memory segment list",
        {
          count: memFiles.length,
          files: memFiles,
        },
      );
      filesForIndex = memFiles;
    }

    const nextIndex = this.computeNextIndex(filesForIndex);
    this.currentSessionStartIndex = nextIndex;
    this.currentPreviousCompressedSec = 0;
    this.currentSessionStartStr = "";
    this.lastSegmentSeenAtMs = null;
    this.lastSegmentIndex = null;
    this.progressDiagLastAtMs = 0;
    this.sessionProgressLogLastAtMs = 0;

    let args: string[];
    if (this.mode === "image") {
      try {
        const imgDir = path.join(this.segmentsDir, "images");
        if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
        try {
          const existingImgs = fs
            .readdirSync(imgDir)
            .filter((f) => /img_\d+\.jpg$/i.test(f))
            .sort();
          let max = -1;
          for (const f of existingImgs) {
            const m = f.match(/img_(\d+)\.jpg$/i);
            if (m) {
              const n = parseInt(m[1], 10);
              if (!isNaN(n) && n > max) max = n;
            }
          }
          this.finalImageIndex = max + 1;
          if (existingImgs.length > 0) {
            try {
              const last = existingImgs[existingImgs.length - 1];
              const st = fs.statSync(path.join(imgDir, last));
              this.lastAcceptedSize = st.size || null;
            } catch (_) {
              this.lastAcceptedSize = null;
            }
          } else {
            this.lastAcceptedSize = null;
          }
        } catch (_) {
          this.finalImageIndex = 0;
          this.lastAcceptedSize = null;
        }
        this.emittedImages.clear();
        this.emittedTmp.clear();
        if (this.imageWatcher)
          try {
            this.imageWatcher.close();
          } catch (_) {}
        this.imageWatcher = fs.watch(imgDir, (eventType, filename) => {
          if (!filename) return;
          if (!/tmp_\d+\.tmp\.jpg$/i.test(filename)) return;
          const tmpFull = path.join(imgDir, filename);
          (async () => {
            try {
              let st: fs.Stats;
              try {
                st = await fs.promises.stat(tmpFull);
              } catch (_) {
                return;
              }
              if (this.emittedTmp.has(tmpFull)) return;
              const size = st.size || 0;
              let accept = true;
              try {
                if (
                  this.lastAcceptedSize !== null &&
                  this.lastAcceptedSize > 0 &&
                  size > 0
                ) {
                  const diff = Math.abs(size - this.lastAcceptedSize);
                  const ratio = diff / Math.max(size, this.lastAcceptedSize);
                  if (ratio <= 0.02) accept = false;
                }
              } catch (_) {
                accept = true;
              }
              this.emittedTmp.add(tmpFull);
              if (!accept) {
                try {
                  this.emit("candidate", {
                    status: "skipped",
                    tmp: tmpFull,
                    ts: new Date().toISOString(),
                  });
                } catch (_) {}
                try {
                  await fs.promises.unlink(tmpFull);
                  this.logger.info("Rejected tmp image deleted", {
                    file: tmpFull,
                  });
                } catch (e) {
                  this.logger.warn("Failed delete tmp image", {
                    file: tmpFull,
                    err: (e as any)?.message,
                  });
                }
                return;
              }
              const dest = path.join(
                imgDir,
                `img_${String(this.finalImageIndex).padStart(6, "0")}.jpg`,
              );
              this.finalImageIndex++;
              this.pendingPromotions.push({ tmp: tmpFull, dest });
              try {
                this.emit("candidate", {
                  status: "used",
                  tmp: tmpFull,
                  dest,
                  ts: new Date().toISOString(),
                });
              } catch (_) {}
              this.logger.debug("tmp-queued-for-promotion", {
                tmp: tmpFull,
                dest,
                queued: this.pendingPromotions.length,
              });
              this.lastAcceptedSize = size || this.lastAcceptedSize;
              if (this.pendingPromotions.length > MAX_PENDING) {
                this.logger.warn(
                  "pendingPromotions exceeded MAX_PENDING, dropping oldest",
                  { pending: this.pendingPromotions.length },
                );
                this.pendingPromotions.splice(
                  0,
                  this.pendingPromotions.length - MAX_PENDING,
                );
              }
              if (this.pendingPromotions.length >= BATCH_SIZE) {
                this.processPendingPromotions().catch((e) =>
                  this.logger.error("processPendingPromotions failed", {
                    err: (e as any)?.message,
                  }),
                );
              }
            } catch (e) {
              this.logger.error("tmp-file-handler failed", {
                err: (e as any)?.message,
              });
            }
          })();
        });
      } catch (e: any) {
        this.logger.error("Image watcher failed", { err: e?.message });
      }
      args = this.buildImageArgs(outImagePattern);
      this.logger.info("Spawning ffmpeg (image-sequence)", { args });
    } else {
      // video mode: do not do automatic skip/restart; skipDedup currently unused in new flow
      const previousCompressedSec = isResuming
        ? this.getSegmentDurationTotalSec(this.sessionSegments)
        : 0;
      const previousActiveSec = isResuming
        ? this.compressedToActiveSec(previousCompressedSec)
        : 0;
      // Session start time embedded into the Clock overlay ("YYYY-MM-DD HH:MM").
      // The colon in HH:MM is pre-escaped as \: so drawtext renders it as ':'
      // without misinterpreting it as a filter-option separator.
      const sessionStart = isResuming
        ? this.getFirstSegmentStartFromFiles(this.sessionSegments) || new Date()
        : new Date();
      const sessionStartStr = this.formatOverlayDateTime(sessionStart);
      this.currentPreviousCompressedSec = previousCompressedSec;
      this.currentSessionStartStr = sessionStartStr;
      args = this.buildFfmpegArgs(
        outPattern,
        nextIndex,
        false,
        this.outputFps,
        previousCompressedSec,
        previousActiveSec,
        sessionStartStr,
      );
      this.logger.info("Spawning ffmpeg (video)", {
        args,
        startIndex: nextIndex,
        previousCompressedSec,
        previousActiveSec,
        sessionSegmentCount: this.sessionSegments.length,
        segmentIntervalSec: this.segmentIntervalSec,
        captureFps: this.fps,
        outputFps: this.outputFps,
        expectedInputFramesPerSegment: this.segmentIntervalSec * this.outputFps,
        expectedWallSecPerSegmentAtCaptureFps:
          this.fps > 0
            ? (this.segmentIntervalSec * this.outputFps) / this.fps
            : null,
        sessionStartStr,
      });
    }

    // reset ffmpeg log buffer for this session
    this.ffmpegLogLines.length = 0;
    this.ffmpegLogBytes = 0;
    this.lastFfmpegExitCode = null;
    this.lastFfmpegErrorTail = "";

    this.ff = spawn(FFMPEG_PATH, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.ffmpegSpawnedAtMs = Date.now();
    this.lowerProcessPriority(this.ff.pid);
    this.logger.info("Memory diagnostics after ffmpeg spawn", {
      ffmpegPid: this.ff.pid,
      memory: this.collectMemoryDiagnostics(),
    });

    this.state = "recording";
    this.logger.info("Recording started", {
      pid: this.ff.pid,
      mode: this.mode,
      startIndex: nextIndex,
      segmentIntervalSec: this.segmentIntervalSec,
      captureFps: this.fps,
      outputFps: this.outputFps,
      sessionLogPath: this.sessionLogPath,
    });
    this.emit("started");

    try {
      if (this.promotionInterval) clearInterval(this.promotionInterval);
      this.promotionInterval = setInterval(() => {
        if (this.pendingPromotions.length > 0 && !this.batchInProgress) {
          this.processPendingPromotions().catch((e) =>
            this.logger.warn("periodic processPendingPromotions failed", {
              err: (e as any)?.message,
            }),
          );
        }
      }, 300);
    } catch (_) {}

    this.ff.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      const now = Date.now();
      if (this.shouldWriteSessionStderrChunk(s, now)) {
        this.writeSessionLog(s);
      }
      // Keep a rolling tail of stderr for error diagnostics on non-zero exit.
      const lines = s.split(/\r?\n/).filter((l: string) => l.trim());
      this.ffmpegLastStderr.push(...lines);
      if (this.ffmpegLastStderr.length > this.STDERR_TAIL_LINES)
        this.ffmpegLastStderr.splice(
          0,
          this.ffmpegLastStderr.length - this.STDERR_TAIL_LINES,
        );

      // Use global regex to catch ALL segment/image openings in a single stderr chunk.
      // On Windows, pipe buffering can deliver multiple "Opening" lines in one data event,
      // and a non-global exec() would silently drop all but the first match.
      const videoRe = /Opening '(.+segment_\d+\.mp4)(?:' for writing)?/g;
      const imageRe =
        /Opening '(.+img_\d+\.(?:jpg|jpeg|png))(?:' for writing)?/g;
      const progress = this.parseFfmpegProgress(s);
      if (
        progress.frame !== null &&
        now - this.progressDiagLastAtMs >= FFMPEG_PROGRESS_DIAG_INTERVAL_MS
      ) {
        this.progressDiagLastAtMs = now;
        this.logger.debug("ffmpeg progress diagnostic", {
          pid: this.ff?.pid,
          elapsedSec:
            this.ffmpegSpawnedAtMs > 0
              ? Math.round((now - this.ffmpegSpawnedAtMs) / 1000)
              : null,
          frame: progress.frame,
          fps: progress.fps,
          outTimeSec: progress.outTimeSec,
          speed: progress.speed,
          mode: this.mode,
          startIndex: this.currentSessionStartIndex,
          segmentIntervalSec: this.segmentIntervalSec,
          captureFps: this.fps,
          outputFps: this.outputFps,
        });
      }
      let mVideo: RegExpExecArray | null;
      let mImage: RegExpExecArray | null;
      while ((mVideo = videoRe.exec(s)) !== null) {
        const file = mVideo[1];
        const abs = path.isAbsolute(file)
          ? file
          : path.join(this.segmentsDir, path.basename(file));
        const segmentIndex = this.extractSegmentIndex(abs);
        const previousSeenAt = this.lastSegmentSeenAtMs;
        const previousIndex = this.lastSegmentIndex;
        const alreadyKnown = this.segments.includes(abs);
        const alreadyKnownInSession = this.sessionSegments.includes(abs);
        this.segments.push(abs);
        if (!alreadyKnownInSession) this.sessionSegments.push(abs);
        this.lastSegmentSeenAtMs = now;
        this.lastSegmentIndex = segmentIndex;
        this.logger.info("Segment created", {
          file: abs,
          segmentIndex,
          previousIndex,
          duplicateInMemory: alreadyKnown,
          duplicateInSession: alreadyKnownInSession,
          segmentsInMemory: this.segments.length,
          sessionSegmentsInMemory: this.sessionSegments.length,
          elapsedSec:
            this.ffmpegSpawnedAtMs > 0
              ? Math.round((now - this.ffmpegSpawnedAtMs) / 1000)
              : null,
          deltaFromPreviousSegmentSec:
            previousSeenAt !== null
              ? Math.round((now - previousSeenAt) / 1000)
              : null,
          progressFrame: progress.frame,
          progressFps: progress.fps,
          progressOutTimeSec: progress.outTimeSec,
          progressSpeed: progress.speed,
          segmentIntervalSec: this.segmentIntervalSec,
          captureFps: this.fps,
          outputFps: this.outputFps,
          startIndex: this.currentSessionStartIndex,
          previousCompressedSec: this.currentPreviousCompressedSec,
          sessionStartStr: this.currentSessionStartStr,
          fileDiag: this.getFileDiag(abs),
        });
        this.emit("segment", abs);
      }
      while ((mImage = imageRe.exec(s)) !== null) {
        const file = mImage[1];
        const abs = path.isAbsolute(file)
          ? file
          : path.join(this.segmentsDir, "images", path.basename(file));
        if (!this.emittedImages.has(abs)) {
          this.emittedImages.add(abs);
          this.segments.push(abs);
          if (!this.sessionSegments.includes(abs)) this.sessionSegments.push(abs);
          this.logger.info("Image written (stderr)", { file: abs });
          this.emit("image", abs);
        }
      }

      // If ffmpeg reports "No filtered frames", just notify renderer and log (no automatic restart)
      try {
        if (
          s.includes("No filtered frames") ||
          s.includes("No filtered frames for output stream")
        ) {
          if (this.dedupSettings && this.dedupSettings.enabled) {
            this.logger.warn(
              "Dedup filter reported no filtered frames; emitting dedup-fallback (no restart)",
              {},
            );
            try {
              this.emit("dedup-fallback", {
                reason: "stderr-no-filtered-frames",
              });
            } catch (_) {}
          }
        }
      } catch (_) {}
    });

    this.ff.on("close", (code) => {
      const closeAt = Date.now();
      this.lastFfmpegExitCode = code;
      if (code !== 0 && code !== null) {
        this.lastFfmpegErrorTail = this.ffmpegLastStderr.slice(-15).join(" | ");
        // Log the last stderr lines to the main app log so errors are visible
        // without having to dig into the session log file.
        this.logger.warn("ffmpeg exited with error", {
          code,
          stderrTail: this.lastFfmpegErrorTail,
          memory: this.collectMemoryDiagnostics(),
        });
      } else {
        this.logger.info("ffmpeg exited", {
          code,
          pid: this.ff?.pid,
          elapsedSec:
            this.ffmpegSpawnedAtMs > 0
              ? Math.round((closeAt - this.ffmpegSpawnedAtMs) / 1000)
              : null,
          segmentsInMemory: this.segments.length,
          sessionSegmentsInMemory: this.sessionSegments.length,
          lastSegmentIndex: this.lastSegmentIndex,
        });
      }
      this.ffmpegLastStderr = [];
      this.writeSessionLog(
        `[SESSION PROCESS CLOSE] ${new Date().toISOString()} (code=${code})\n`,
      );
      if (this.state !== "paused") {
        this.closeSessionLog("process-close");
      }
      if (this.imageWatcher) {
        try {
          this.imageWatcher.close();
          this.imageWatcher = undefined;
        } catch (_) {}
      }
      try {
        this.processPendingPromotions().catch((e) =>
          this.logger.warn("flush promotions failed", {
            err: (e as any)?.message,
          }),
        );
      } catch (_) {}
      try {
        if (this.promotionInterval) {
          clearInterval(this.promotionInterval);
          this.promotionInterval = undefined;
        }
      } catch (_) {}
      this.ff = undefined;

      if (this.state === "recording" || this.state === "stopping") {
        this.state = "stopped";
        this.emit("stopped");
      }
    });

    this.ff.on("error", (err) => {
      this.logger.error("ffmpeg error", { err: (err as any).message });
      this.emit("error", err);
    });
  }

  public pause() {
    if (this.state !== "recording") return;
    if (this.ff && this.ff.stdin.writable) {
      try {
        this.ff.stdin.write("q");
      } catch (_) {}
    }
    this.state = "paused";
    this.writeSessionLog(`[SESSION PAUSE] ${new Date().toISOString()}\n`);
    this.logger.info("Recording paused");
    this.emit("paused");
  }

  public resume() {
    if (this.state !== "paused") return;
    this.start();
    this.logger.info("Recording resumed");
    this.emit("resumed");
  }

  public stop() {
    const stopRequestedAt = Date.now();
    if (
      this.state === "idle" ||
      this.state === "stopped" ||
      this.state === "stopping"
    ) {
      this.logger.info("Stop ignored", {
        state: this.state,
        hasFfmpeg: Boolean(this.ff),
        pid: this.ff?.pid,
      });
      return;
    }

    this.writeSessionLog(`[SESSION STOP] ${new Date().toISOString()}\n`);
    this.logger.info("Stop requested", {
      state: this.state,
      hasFfmpeg: Boolean(this.ff),
      pid: this.ff?.pid,
      ffmpegStdinWritable: Boolean(this.ff?.stdin?.writable),
      elapsedSec:
        this.ffmpegSpawnedAtMs > 0
          ? Math.round((stopRequestedAt - this.ffmpegSpawnedAtMs) / 1000)
          : null,
      segmentsInMemory: this.segments.length,
      sessionSegmentsInMemory: this.sessionSegments.length,
      lastSegmentIndex: this.lastSegmentIndex,
      pendingPromotions: this.pendingPromotions.length,
    });

    if (this.state === "paused" && !this.ff) {
      this.logger.info(
        "Stop called while paused and ffmpeg not running — finalizing",
      );
      // Close the session log here — the normal ffmpeg 'close' handler won't
      // run (no ffmpeg process), so without this the stream stays open and
      // causes EPERM errors in getSegments() on the next start().
      this.closeSessionLog("stop");
      this.state = "stopping";
      this.emit("stopping");
      (async () => {
        try {
          await this.processPendingPromotions();
        } catch (e) {
          this.logger.warn("processPendingPromotions on stop failed", {
            err: (e as any)?.message,
          });
        }
        try {
          this.state = "stopped";
          this.emit("stopped");
        } catch (_) {}
      })();
      return;
    }

    if (this.ff && this.ff.stdin.writable) {
      try {
        this.ff.stdin.write("q");
        this.logger.info("Stop signal sent to ffmpeg stdin", {
          pid: this.ff.pid,
          signal: "q",
        });
      } catch (_) {}
    }
    this.state = "stopping";
    this.logger.info("Recording stopping");
    this.emit("stopping");
    try {
      if (this.promotionInterval) {
        clearInterval(this.promotionInterval);
        this.promotionInterval = undefined;
      }
    } catch (_) {}

    setTimeout(() => {
      try {
        if (this.ff) {
          try {
            this.logger.warn("ffmpeg did not exit in time, force killing", {
              pid: this.ff.pid,
              elapsedSinceStopSec: Math.round(
                (Date.now() - stopRequestedAt) / 1000,
              ),
              segmentsInMemory: this.segments.length,
              sessionSegmentsInMemory: this.sessionSegments.length,
              lastSegmentIndex: this.lastSegmentIndex,
            });
          } catch (_) {}
          try {
            this.ff.kill();
          } catch (_) {}
          try {
            if (
              process.platform === "win32" &&
              this.ff &&
              (this.ff as any).pid
            ) {
              try {
                spawnSync("taskkill", [
                  "/PID",
                  String((this.ff as any).pid),
                  "/F",
                ]);
              } catch (_) {}
            }
          } catch (_) {}
        }
      } catch (_) {}
    }, 3000);

    try {
      this.processPendingPromotions().catch((e) =>
        this.logger.warn("processPendingPromotions on stop failed", {
          err: (e as any)?.message,
        }),
      );
    } catch (_) {}

    // ensure session log is closed on stop
    this.closeSessionLog("stop");
  }

  public forceKill() {
    try {
      if (this.ff) {
        try {
          this.ff.kill();
        } catch (_) {}
        this.ff = undefined;
      }
    } catch (_) {}
    try {
      if (this.imageWatcher) {
        try {
          this.imageWatcher.close();
        } catch (_) {}
        this.imageWatcher = undefined;
      }
    } catch (_) {}
    try {
      this.state = "stopped";
      this.emit("stopped");
    } catch (_) {}
    try {
      if (this.pendingPromotions && this.pendingPromotions.length > 0) {
        const unsaved = this.pendingPromotions.map((p) => p.tmp);
        this.logger.warn("forceKill: pending promotions dropped", {
          count: this.pendingPromotions.length,
          unsaved,
        });
        for (const p of this.pendingPromotions) {
          try {
            fs.promises.unlink(p.tmp).catch(() => {});
          } catch (_) {}
        }
        this.pendingPromotions.length = 0;
      }
    } catch (_) {}
    // flush any session logs
    this.closeSessionLog("forceKill");
  }

  private async processPendingPromotions(): Promise<void> {
    if (this.batchInProgress) return;
    if (!this.pendingPromotions || this.pendingPromotions.length === 0) return;
    this.batchInProgress = true;
    const batch = this.pendingPromotions.splice(0, BATCH_SIZE);
    this.logger.info("batch-promotion-start", { count: batch.length });
    for (const item of batch) {
      let attempts = 0;
      let success = false;
      while (attempts <= RETRY_POLICY_MS.length && !success) {
        try {
          await fs.promises.rename(item.tmp, item.dest);
          success = true;
        } catch (e: any) {
          attempts++;
          if (attempts > RETRY_POLICY_MS.length) {
            this.logger.error("batch-promotion-failed", {
              tmp: item.tmp,
              dest: item.dest,
              err: e?.message,
            });
            try {
              await fs.promises.unlink(item.tmp).catch(() => {});
            } catch (_) {}
            break;
          }
          const delay = RETRY_POLICY_MS[attempts - 1] || 500;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      if (success) {
        try {
          this.emittedImages.add(item.dest);
          this.segments.push(item.dest);
          if (!this.sessionSegments.includes(item.dest))
            this.sessionSegments.push(item.dest);
          this.logger.info("batch-promotion-done", { file: item.dest });
          try {
            this.emit("image", item.dest);
          } catch (_) {}
        } catch (e) {
          this.logger.warn("post-promotion update failed", {
            err: (e as any)?.message,
          });
        }
      }
    }
    this.batchInProgress = false;
    this.logger.info("batch-promotion-complete", {
      remaining: this.pendingPromotions.length,
    });
    if (this.pendingPromotions.length >= BATCH_SIZE) {
      this.processPendingPromotions().catch((e) =>
        this.logger.error("processPendingPromotions recursive failed", {
          err: (e as any)?.message,
        }),
      );
    }
  }

  public getState() {
    return this.state;
  }
}

export default RecorderEngine;
