'use strict';

/**
 * geometry.js — pure window-rectangle helpers shared by main.js and tests.
 *
 * No Electron dependency: everything is plain arithmetic over
 * { x, y, width, height } rects, so this module loads in plain Node and the
 * packaged app alike. (It ships inside the asar; see the `files` list in
 * robot-body/package.json. The test/ directory is intentionally NOT listed,
 * so tests never ship.)
 */

function clampRectToArea(rect, area) {
    const w = Math.max(1, Math.min(rect.width, area.width));
    const h = Math.max(1, Math.min(rect.height, area.height));
    return {
        x: Math.max(area.x, Math.min(rect.x, area.x + area.width - w)),
        y: Math.max(area.y, Math.min(rect.y, area.y + area.height - h)),
        width: w,
        height: h,
    };
}

module.exports = { clampRectToArea };
