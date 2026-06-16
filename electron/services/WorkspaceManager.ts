import { app, dialog, shell } from "electron";
import fs from "fs";
import path from "path";
import type { LoggerService } from "./LoggerService";

// ─── Workspace (working directory) management ────────────────────────────────
//
// The "workspace root" is the directory that holds all ZradaLog data:
//   settings.json, logs/, segments/ (+ segments/images/), output/.
//
// By default this is Electron's userData dir (…\AppData\Roaming\zradalog).
// The user may relocate it to any folder. To avoid a chicken-and-egg problem
// (we can't store the pointer inside the relocatable folder) the pointer file
// `workspace.json` ALWAYS lives in the *default* userData dir, captured once at
// startup before any app.setPath("userData", …) override.
//
// We implement relocation by overriding app.setPath("userData", root), so the
// rest of the codebase keeps using app.getPath("userData") unchanged.

// Data items that belong to the workspace and are migrated on relocation.
// NOTE: the `workspace.json` pointer is intentionally NOT in this list — it
// stays in the default userData dir. Electron's own caches (Cache/, GPUCache/,
// Local Storage/, …) are not migrated; they regenerate in the new location
// after the app restarts.
const WORKSPACE_ITEMS = ["settings.json", "logs", "segments", "output"];

let defaultUserData = "";
let pointerPath = "";

export interface WorkspaceState {
  root: string;
  isDefault: boolean;
}

export function getDefaultUserData(): string {
  return defaultUserData;
}

function captureDefaults(): void {
  if (defaultUserData) return;
  defaultUserData = app.getPath("userData");
  pointerPath = path.join(defaultUserData, "workspace.json");
}

interface PendingMove {
  from: string;
  to: string;
}

interface Pointer {
  root?: string;
  // A relocation requested in the previous session but deferred to the next
  // startup — the move runs before any file handle is opened, avoiding the
  // Windows file locks (EPERM) you hit when moving a live workspace.
  pendingMove?: PendingMove;
}

function readPointer(): Pointer {
  try {
    if (fs.existsSync(pointerPath)) {
      return JSON.parse(fs.readFileSync(pointerPath, "utf8") || "{}");
    }
  } catch (_) {}
  return {};
}

function writePointerRaw(ptr: Pointer): void {
  fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
  fs.writeFileSync(pointerPath, JSON.stringify(ptr, null, 2), "utf8");
}

// Persist the resolved root and clear any pending move.
export function writePointer(root: string): void {
  writePointerRaw({ root });
}

// Record a relocation to be performed on the next startup. The root stays at
// `from` until the move actually succeeds.
export function requestMove(from: string, to: string): void {
  writePointerRaw({ root: from, pendingMove: { from, to } });
}

export function ensureSubdirs(root: string): void {
  for (const d of ["logs", path.join("segments", "images"), "output"]) {
    const p = path.join(root, d);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
}

function applyRoot(root: string): void {
  writePointer(root);
  app.setPath("userData", root);
  ensureSubdirs(root);
}

// Called at module load (before app.whenReady). For a known/valid pointer it
// applies the override immediately (earliest possible). For first run it does
// NOT override yet — promptFirstRun() runs once the app is ready and a dialog
// can be shown.
export function resolveAtStartup(): {
  state: WorkspaceState;
  isFirstRun: boolean;
  pendingMove: PendingMove | null;
} {
  captureDefaults();
  const ptr = readPointer();

  const pendingMove =
    ptr.pendingMove &&
    typeof ptr.pendingMove.from === "string" &&
    typeof ptr.pendingMove.to === "string"
      ? ptr.pendingMove
      : null;

  // A pending move is applied later (performPendingMove, run at the very top of
  // whenReady before any handle is opened). Do NOT setPath here so caches don't
  // land in the about-to-be-vacated `from` folder.
  if (pendingMove) {
    return {
      state: {
        root: pendingMove.from,
        isDefault:
          path.resolve(pendingMove.from) === path.resolve(defaultUserData),
      },
      isFirstRun: false,
      pendingMove,
    };
  }

  if (ptr.root && typeof ptr.root === "string") {
    try {
      app.setPath("userData", ptr.root);
      ensureSubdirs(ptr.root);
      return {
        state: {
          root: ptr.root,
          isDefault: path.resolve(ptr.root) === path.resolve(defaultUserData),
        },
        isFirstRun: false,
        pendingMove: null,
      };
    } catch (_) {
      // Fall through to default if the stored root is unusable.
    }
  }
  return {
    state: { root: defaultUserData, isDefault: true },
    isFirstRun: true,
    pendingMove: null,
  };
}

// Perform a deferred relocation at startup, before logger/recorder open any
// files. On success the new root is applied and the pointer cleared; on failure
// the workspace stays at `from`. Either way the pending move is cleared.
export async function performPendingMove(
  from: string,
  to: string,
): Promise<MoveResult & { root: string }> {
  const res = await moveWorkspace(from, to);
  if (res.ok) {
    writePointer(to);
    app.setPath("userData", to);
    ensureSubdirs(to);
    return { ...res, root: to };
  }
  // Revert: keep using the old root, clear the pending move so we don't loop.
  writePointer(from);
  app.setPath("userData", from);
  ensureSubdirs(from);
  return { ...res, root: from };
}

// First-run prompt: ask where to place the workspace. Must run after the app is
// ready (dialog requirement) and before the logger/recorder are constructed.
export function promptFirstRun(): WorkspaceState {
  const choice = dialog.showMessageBoxSync({
    type: "question",
    title: "ZradaLog — рабочая директория",
    message: "Где хранить данные ZradaLog?",
    detail:
      "Рабочая директория хранит настройки, логи, сегменты записи и готовые видео.\n\n" +
      `По умолчанию: ${defaultUserData}`,
    buttons: ["Использовать по умолчанию", "Выбрать папку…"],
    defaultId: 0,
    cancelId: 0,
  });

  let root = defaultUserData;
  if (choice === 1) {
    const picked = dialog.showOpenDialogSync({
      title: "Выберите рабочую директорию ZradaLog",
      properties: ["openDirectory", "createDirectory"],
    });
    if (picked && picked[0]) root = picked[0];
  }

  applyRoot(root);
  return {
    root,
    isDefault: path.resolve(root) === path.resolve(defaultUserData),
  };
}

export function currentState(): WorkspaceState {
  const root = app.getPath("userData");
  return {
    root,
    isDefault: path.resolve(root) === path.resolve(defaultUserData),
  };
}

function isSubPath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface MoveResult {
  ok: boolean;
  err?: string;
  cancelled?: boolean;
}

// Validate a candidate new root against the current one.
export function validateNewRoot(
  oldRoot: string,
  newRoot: string,
): string | null {
  if (path.resolve(newRoot) === path.resolve(oldRoot)) {
    return "Выбрана та же папка.";
  }
  if (isSubPath(oldRoot, newRoot) || isSubPath(newRoot, oldRoot)) {
    return "Папки не должны быть вложены друг в друга.";
  }
  // Refuse if the target already holds ZradaLog data (avoid clobbering).
  for (const item of WORKSPACE_ITEMS) {
    const dest = path.join(newRoot, item);
    if (fs.existsSync(dest)) {
      return `Целевая папка уже содержит данные ZradaLog (${item}). Выберите пустую папку.`;
    }
  }
  return null;
}

// Move the workspace data from oldRoot to newRoot. Same-volume moves use
// rename; cross-volume moves copy recursively and send the source to the
// Recycle Bin. The caller is responsible for releasing file handles (logger,
// recorder) beforehand and for relaunching the app afterwards.
export async function moveWorkspace(
  oldRoot: string,
  newRoot: string,
  logger?: LoggerService,
): Promise<MoveResult> {
  const validationErr = validateNewRoot(oldRoot, newRoot);
  if (validationErr) return { ok: false, err: validationErr };

  fs.mkdirSync(newRoot, { recursive: true });

  // Source paths that were successfully copied cross-volume and now need to be
  // trashed (rename already removes the source).
  const toTrash: string[] = [];

  for (const item of WORKSPACE_ITEMS) {
    const src = path.join(oldRoot, item);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(newRoot, item);
    try {
      fs.renameSync(src, dest);
    } catch (e: any) {
      if (e?.code === "EXDEV") {
        // Cross-device: copy then trash the source.
        fs.cpSync(src, dest, { recursive: true });
        toTrash.push(src);
      } else {
        logger?.error?.("Workspace move failed", { item, err: e?.message });
        return {
          ok: false,
          err: `Не удалось перенести «${item}»: ${e?.message || e}`,
        };
      }
    }
  }

  for (const src of toTrash) {
    try {
      await shell.trashItem(src);
    } catch (e: any) {
      logger?.warn?.("Failed to trash old workspace item", {
        src,
        err: e?.message,
      });
    }
  }

  logger?.info?.("Workspace moved", {
    oldRoot,
    newRoot,
    trashed: toTrash.length,
  });
  return { ok: true };
}
