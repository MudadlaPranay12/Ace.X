'use strict';

/**
 * package-vsix.js — builds botx.robot-brain-<version>.vsix
 *
 * Why a staging directory?
 * -----------------------
 * This repo is an npm workspace. When vsce runs inside robot-brain/, it asks
 * npm for the production dependency tree and npm reports BOTH
 *   D:\DigitalCompanion\node_modules\robot-brain  (a junction back to the
 *                                                  extension folder)
 *   D:\DigitalCompanion\robot-brain\node_modules\ws (the real copy)
 * vsce then collects node_modules/ws twice, and aborts with
 * "The following files have the same case insensitive path, which isn't
 *  supported by the VSIX format".
 *
 * Packaging from a staging directory outside the workspace removes the
 * junction from npm's view entirely. Only files the extension actually needs
 * at runtime are copied in.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const brainDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(brainDir, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(brainDir, 'package.json'), 'utf8'));

const stageDir = path.join(os.tmpdir(), 'botx-vsix-stage');
const outFile = path.join(brainDir, `botx.robot-brain-${pkg.version}.vsix`);

function fail(message) {
  console.error(`[VSIX] ${message}`);
  process.exit(1);
}

// Node 24 refuses to spawn *.cmd shims directly, and npm/npx are always
// installed next to the running node binary. Resolve their CLI entry points
// explicitly so this works with plain `node scripts/package-vsix.js`.
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');

console.log('[VSIX] compiling the extension');
execFileSync(process.execPath, [npmCli, 'run', 'compile'], { cwd: brainDir, stdio: 'inherit' });

console.log('[VSIX] staging the canonical Electron Body');
execFileSync(process.execPath, [path.join(brainDir, 'scripts', 'stage-companion.js')], { cwd: brainDir, stdio: 'inherit' });

const compiledMain = path.join(brainDir, 'out', 'extension.js');
if (!fs.existsSync(compiledMain)) {
  fail('out/extension.js is missing after compile.');
}

// The packaged Electron Body is required for an installed extension. The
// development fallback in ProcessManager is used only under F5.
const companionExe = path.join(brainDir, 'companion', 'win-x64', 'BotX Companion.exe');
const hasLegacyBody = fs.existsSync(companionExe);
if (!hasLegacyBody) {
  fail('The packaged Electron Body is missing. Build robot-body before packaging the VSIX.');
}

// Clean rebuild of the staging directory.
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

function copyInto(relativeSource, relativeDestination = relativeSource) {
  const from = path.join(brainDir, relativeSource);
  const to = path.join(stageDir, relativeDestination);
  if (!fs.existsSync(from)) {
    fail(`required input missing: ${relativeSource}`);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

// Manifest + docs
copyInto('package.json');
copyInto('README.md');

// Activity bar icon for the BotX view container
copyInto('media', 'media');

// Compiled extension code (tests are compiled into out/test but never shipped)
copyInto('out');
fs.rmSync(path.join(stageDir, 'out', 'test'), { recursive: true, force: true });

// Source maps are stripped by `**/*.map`; drop stale ones for deleted modules too.
const outDir = path.join(stageDir, 'out');
for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.js.map')) {
    fs.rmSync(path.join(outDir, entry.name), { force: true });
  }
}

// Only non-node_modules files are listed by hand; vsce resolves ws itself from
// the staged manifest (safe here because the stage dir is outside the
// workspace, so npm reports exactly one dependency path).
fs.writeFileSync(
  path.join(stageDir, '.vscodeignore'),
  ['**/*.map', 'out/test/**', '**/*.ts', ''].join('\n'),
  'utf8'
);

// Runtime dependency (the only one)
copyInto('node_modules/ws', 'node_modules/ws');

// Packaged legacy Robot Body (only when staged; see above).
if (hasLegacyBody) {
  copyInto('companion', 'companion');
}

console.log(`[VSIX] staged ${countFiles(stageDir)} files in ${stageDir}`);

const args = [
  '--yes',
  '@vscode/vsce@latest',
  'package',
  '--allow-missing-repository',
  '--out',
  outFile,
];

// vscode:prepublish is intentionally absent from the staged manifest: the
// compile step already ran above, and the staging directory has no toolchain.
execFileSync(process.execPath, [npxCli, ...args], {
  cwd: stageDir,
  stdio: 'inherit',
});

if (fs.existsSync(outFile)) {
  const mb = fs.statSync(outFile).size / 1024 / 1024;
  console.log(`[VSIX] wrote ${path.relative(repoRoot, outFile)} (${mb.toFixed(1)} MB)`);
  if (mb > 100) {
    console.log(
      '[VSIX] WARNING: over 100 MB. This build is for local installation and\n' +
      '[VSIX]        sideloading only — Marketplace distribution needs this\n' +
      '[VSIX]        under the practical size budget. See the Robot Body\n' +
      '[VSIX]        README, "Packaging size".'
    );
  }
} else {
  fail('vsce did not produce the expected file.');
}

fs.rmSync(stageDir, { recursive: true, force: true });

function countFiles(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return total;
}
