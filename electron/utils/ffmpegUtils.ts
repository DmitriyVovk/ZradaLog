import path from 'path';
import fs from 'fs';
import ffmpegStatic from '@ffmpeg-installer/ffmpeg';

export function getFFmpegPath(): string {
  const tryPaths: string[] = [];

  // 1) Try our guaranteed copy in resources/ffmpeg/ffmpeg.exe
  const guaranteedPath = path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe');
  tryPaths.push(guaranteedPath);

  // 2) Path from @ffmpeg-installer package
  try {
    const bundledPath = ffmpegStatic?.path;
    if (bundledPath) {
      tryPaths.push(bundledPath);
    }
  } catch (_) {}

  // 3) In production with asar unpacked path
  if (process.platform === 'win32') {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
    tryPaths.push(unpacked);
    // Might be in asar path for development and some packaging edge cases
    const asarPacked = path.join(process.resourcesPath, 'app.asar', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
    tryPaths.push(asarPacked);
  }

  // 4) fallback to ffmpeg in PATH
  tryPaths.push('ffmpeg');

  for (const p of tryPaths) {
    if (!p) continue;
    try {
      if (p === 'ffmpeg' || fs.existsSync(p)) {
        return p;
      }
    } catch (_) {}
  }

  return 'ffmpeg';
}