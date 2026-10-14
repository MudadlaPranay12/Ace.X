'use strict';

/**
 * stage-robot-webview.js — stages the canonical Eve Webview runtime.
 *
 * The VS Code Webview can only load resources from inside the installed
 * extension, so the Eve GLB, the pinned Three.js runtime and the proven
 * robot-body behaviour modules are copied into robot-brain/media/robot at
 * build/dev time. Nothing is reimplemented here: the Webview reuses the same
 * GLB, the same Three.js build and the same behaviour pipeline the external
 * body used. robot.js (the view-owned bootstrap) is committed source and is
 * never overwritten by this script.
 */

const fs = require('fs');
const path = require('path');

const brainDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(brainDir, '..');
const bodyDir = path.join(repoRoot, 'robot-body');
const robotDir = path.join(brainDir, 'media', 'robot');

function copyFile(relativeSource, relativeDestination) {
    const from = path.join(bodyDir, relativeSource);
    const to = path.join(robotDir, relativeDestination);
    if (!fs.existsSync(from)) {
        console.error(`[ROBOT-WEBVIEW] missing source: ${path.relative(repoRoot, from)}`);
        process.exit(1);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return to;
}

const staged = [
    copyFile('assets/eve.glb', 'eve.glb'),
    copyFile('vendor/three/build/three.module.min.js', 'vendor/three/build/three.module.min.js'),
    copyFile('vendor/three/examples/jsm/loaders/GLTFLoader.js', 'vendor/three/examples/jsm/loaders/GLTFLoader.js'),
    copyFile('vendor/three/examples/jsm/utils/BufferGeometryUtils.js', 'vendor/three/examples/jsm/utils/BufferGeometryUtils.js'),
];

const behaviourDir = path.join(bodyDir, 'behaviour');
for (const entry of fs.readdirSync(behaviourDir)) {
    if (entry.endsWith('.js')) {
        staged.push(copyFile(path.join('behaviour', entry), path.join('body', 'behaviour', entry)));
    }
}

let bytes = 0;
for (const file of staged) {
    bytes += fs.statSync(file).size;
}
console.log(`[ROBOT-WEBVIEW] staged ${staged.length} files in ${path.relative(repoRoot, robotDir)} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
