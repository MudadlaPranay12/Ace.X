'use strict';

// Regression tests for the pure window-geometry helpers used by Eve Mini /
// Expanded mode transitions. Plain Node only: `node --test test/` from
// robot-body/ (also wired as `npm test --workspace=robot-body`).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clampRectToArea } = require('../geometry');

const AREA = { x: 0, y: 0, width: 1920, height: 1040 };

test('rect fully inside stays exactly where it is', () => {
    assert.deepEqual(clampRectToArea({ x: 67, y: 246, width: 240, height: 270 }, AREA),
        { x: 67, y: 246, width: 240, height: 270 });
});

test('rect hanging off the right/bottom is pulled on-screen', () => {
    assert.deepEqual(clampRectToArea({ x: 1900, y: 1000, width: 240, height: 270 }, AREA),
        { x: 1680, y: 770, width: 240, height: 270 });
});

test('negative origins clamp to the area origin', () => {
    assert.deepEqual(clampRectToArea({ x: -50, y: -20, width: 240, height: 270 }, AREA),
        { x: 0, y: 0, width: 240, height: 270 });
});

test('mini face box (72x72) at a top-left anchor is preserved', () => {
    assert.deepEqual(clampRectToArea({ x: 67, y: 246, width: 72, height: 72 }, AREA),
        { x: 67, y: 246, width: 72, height: 72 });
});

test('oversized rect shrinks to the area instead of escaping it', () => {
    assert.deepEqual(clampRectToArea({ x: -100, y: -100, width: 4000, height: 3000 }, AREA),
        { x: 0, y: 0, width: 1920, height: 1040 });
});

test('degenerate sizes resolve to a 1px minimum, never zero/negative', () => {
    assert.deepEqual(clampRectToArea({ x: 10, y: 10, width: 0, height: -5 }, AREA),
        { x: 10, y: 10, width: 1, height: 1 });
});

test('offset work areas (taskbar, second monitor) are honoured', () => {
    const area = { x: 1920, y: 0, width: 1920, height: 1040 };
    assert.deepEqual(clampRectToArea({ x: 100, y: 100, width: 240, height: 270 }, area),
        { x: 1920, y: 100, width: 240, height: 270 });
});
