#!/usr/bin/env node
/**
 * build-spritesheet.mjs — Combine 1-4 expression PNGs into a horizontal spritesheet.
 *
 * Output: 800x300 PNG with 4 frames (200x300 each).
 * Frame layout: [NORMAL | HAPPY | ANGRY | SURPRISED]
 * Missing frames get transparent fill (runtime fallback handles it).
 *
 * Usage:
 *   node scripts/build-spritesheet.mjs <outputPath> [--normal img] [--happy img] [--angry img] [--surprised img]
 *
 * Example:
 *   node scripts/build-spritesheet.mjs public/assets/trump-expressions.png \
 *     --normal cropped/normal.png --happy cropped/happy.png \
 *     --angry cropped/angry.png --surprised cropped/surprised.png
 */

import sharp from 'sharp';
import { resolve, basename } from 'node:path';
import { existsSync } from 'node:fs';

const FRAME_W = 200;
const FRAME_H = 300;
const FRAME_COUNT = 4;
const SHEET_W = FRAME_W * FRAME_COUNT; // 800
const SHEET_H = FRAME_H;              // 300

const EXPRESSIONS = ['normal', 'happy', 'angry', 'surprised'];

// Parse CLI args
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node scripts/build-spritesheet.mjs <output> [--normal img] [--happy img] [--angry img] [--surprised img]');
  process.exit(1);
}

const outputPath = resolve(args[0]);
const inputs = {};

for (let i = 1; i < args.length; i++) {
  const flag = args[i].replace(/^--/, '');
  if (EXPRESSIONS.includes(flag) && args[i + 1]) {
    inputs[flag] = resolve(args[++i]);
  }
}

console.log(`Building spritesheet: ${basename(outputPath)} (${SHEET_W}x${SHEET_H})`);

// Build composite operations
const composites = [];

for (let i = 0; i < EXPRESSIONS.length; i++) {
  const expr = EXPRESSIONS[i];
  const filePath = inputs[expr];

  if (!filePath || !existsSync(filePath)) {
    console.log(`  [${i}] ${expr}: (empty — transparent fill)`);
    continue;
  }

  console.log(`  [${i}] ${expr}: ${basename(filePath)}`);

  // Resize to fit within frame, centered, preserving aspect ratio
  const resized = await sharp(filePath)
    .resize(FRAME_W, FRAME_H, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer();

  composites.push({
    input: resized,
    left: i * FRAME_W,
    top: 0,
  });
}

// Create transparent base and composite all frames
await sharp({
  create: {
    width: SHEET_W,
    height: SHEET_H,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite(composites)
  .png()
  .toFile(outputPath);

console.log(`  -> ${basename(outputPath)} (${SHEET_W}x${SHEET_H}, ${composites.length}/${FRAME_COUNT} frames)`);
