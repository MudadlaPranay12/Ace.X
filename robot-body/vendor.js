'use strict';

/**
 * vendor.js — copies the Three.js runtime out of node_modules into
 * `vendor/three/` so the packaged companion never fetches anything from a CDN.
 *
 * Electron loads index.html over file://; import maps cannot resolve bare
 * specifiers to node_modules, so the modules have to exist as real files next
 * to index.html. Run via `npm run vendor` (automatically part of `npm run
 * package:body`).
 */

const fs = require('fs');
const path = require('path');

// npm workspaces hoist dependencies to the repo root, so resolve `three`
// through Node's own resolution rather than assuming a local node_modules.
// (`three` has no "exports" entry for package.json, so resolve an exported
// subpath and walk up to its package root instead.)
// "require" resolves to three/build/three.cjs, so the package root is one
// level above the resolved file's directory.
const threeRoot = path.resolve(path.dirname(require.resolve('three')), '..');

const FILES = [
  ['build/three.module.min.js', 'vendor/three/build/three.module.min.js'],
  ['examples/jsm/loaders/GLTFLoader.js', 'vendor/three/examples/jsm/loaders/GLTFLoader.js'],
  ['examples/jsm/utils/BufferGeometryUtils.js', 'vendor/three/examples/jsm/utils/BufferGeometryUtils.js'],
];

const root = __dirname;

for (const [from, to] of FILES) {
  const src = path.join(threeRoot, from);
  const dest = path.join(root, to);
  if (!fs.existsSync(src)) {
    console.error(`[VENDOR] missing source: ${src} — run "npm install" first`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[VENDOR] ${to}`);
}