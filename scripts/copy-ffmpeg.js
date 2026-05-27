const fs = require('fs');
const path = require('path');

module.exports = async function(context) {
  const { appOutDir, packager } = context;

  // Find FFmpeg in asar unpacked location
  const ffmpegSource = path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');

  // Target location
  const ffmpegTargetDir = path.join(appOutDir, 'resources', 'ffmpeg');
  const ffmpegTarget = path.join(ffmpegTargetDir, 'ffmpeg.exe');

  try {
    if (fs.existsSync(ffmpegSource)) {
      // Create target directory
      fs.mkdirSync(ffmpegTargetDir, { recursive: true });

      // Copy FFmpeg
      fs.copyFileSync(ffmpegSource, ffmpegTarget);

      console.log('FFmpeg copied to guaranteed location:', ffmpegTarget);
    } else {
      console.warn('FFmpeg source not found:', ffmpegSource);
    }
  } catch (error) {
    console.error('Failed to copy FFmpeg:', error);
  }
};