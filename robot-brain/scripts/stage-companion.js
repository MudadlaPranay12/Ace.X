'use strict';

/**
 * stage-companion.js — copies the packaged Robot Body from robot-body/dist into
 * robot-brain/companion/win-x64 so that it ships INSIDE the VSIX.
 *
 * The extension resolves the companion exclusively relative to
 * context.extensionUri, so `companion/win-x64/BotX Companion.exe` is the only
 * path that works in an installed extension.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const source = path.join(repoRoot, 'robot-body', 'dist', 'win-unpacked');
const destination = path.join(repoRoot, 'robot-brain', 'companion', 'win-x64');

if (!fs.existsSync(path.join(source, 'BotX Companion.exe'))) {
  console.error(
    '[STAGE] Packaged companion not found at robot-body/dist/win-unpacked.\n' +
    '[STAGE] Run "npm run package:body --workspace=robot-body" first.'
  );
  process.exit(1);
}

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
fs.cpSync(source, destination, { recursive: true });

const exe = path.join(destination, 'BotX Companion.exe');
const bytes = fs.statSync(exe).size;
console.log(`[STAGE] companion staged at ${path.relative(repoRoot, destination)}`);
console.log(`[STAGE] executable: BotX Companion.exe (${Math.round(bytes / 1024 / 1024)} MB)`);