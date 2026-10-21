#!/usr/bin/env node
/**
 * build-character.mjs — Orchestrate the full character pipeline.
 *
 * For each of 4 emotion images:
 *   1. process-head.mjs → ML background removal
 *   2. crop-head.mjs → isolate head (no shoulders)
 *   3. build-spritesheet.mjs → combine into 800x300 spritesheet
 *
 * Usage:
 *   node scripts/build-character.mjs <name> <outputDir> [--skip-find]
 *
 * Example:
 *   node scripts/build-character.mjs "Donald Trump" public/assets/trump/ --skip-find
 *
 * --skip-find mode (default): expects user to manually place images in <outputDir>/raw/:
 *   normal.jpg  happy.jpg  angry.jpg  surprised.jpg
 *
 * Output structure:
 *   <outputDir>/
 *     raw/        normal.jpg  happy.jpg  ...
 *     clean/      normal.png  happy.png  ...
 *     cropped/    normal.png  happy.png  ...
 *     <name>-expressions.png   # final 800x300 spritesheet
 */

import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPRESSIONS = ['normal', 'happy', 'angry', 'surprised'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

// Parse CLI args
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node scripts/build-character.mjs <name> <outputDir> [--skip-find]');
  process.exit(1);
}

const name = args[0];
const outputDir = resolve(args[1]);

// --skip-find is default, accepted but ignored
// --ratio is legacy, accepted but ignored (face detection handles it)

// Derive slug from name for output file
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// Ensure directories exist
const rawDir = join(outputDir, 'raw');
const cleanDir = join(outputDir, 'clean');
const croppedDir = join(outputDir, 'cropped');

for (const dir of [rawDir, cleanDir, croppedDir]) {
  mkdirSync(dir, { recursive: true });
}

console.log(`\n=== Building character: ${name} ===`);
console.log(`  Output: ${outputDir}\n`);

// Find raw images for each expression
function findRawImage(expression) {
  if (!existsSync(rawDir)) return null;
  const files = readdirSync(rawDir);
  for (const ext of IMAGE_EXTS) {
    const match = files.find(f => f.toLowerCase() === `${expression}${ext}`);
    if (match) return join(rawDir, match);
  }
  return null;
}

const processHeadScript = join(__dirname, 'process-head.mjs');
const cropHeadScript = join(__dirname, 'crop-head.mjs');
const buildSpritesheetScript = join(__dirname, 'build-spritesheet.mjs');

// Step 1 & 2: Process each expression
const croppedPaths = {};

for (const expr of EXPRESSIONS) {
  const rawPath = findRawImage(expr);
  if (!rawPath) {
    console.log(`[${expr}] No raw image found — skipping`);
    continue;
  }

  console.log(`\n--- ${expr.toUpperCase()} ---`);

  const cleanPath = join(cleanDir, `${expr}.png`);
  const croppedPath = join(croppedDir, `${expr}.png`);

  // Step 1: ML background removal
  if (existsSync(cleanPath)) {
    console.log(`  [skip] ${expr} clean already exists`);
  } else {
    console.log(`  [process-head] ${rawPath} → ${cleanPath}`);
    execFileSync('node', [processHeadScript, rawPath, cleanPath], { stdio: 'inherit' });
  }

  // Step 2: Crop to just the head
  if (existsSync(croppedPath)) {
    console.log(`  [skip] ${expr} cropped already exists`);
  } else {
    console.log(`  [crop-head] ${cleanPath} → ${croppedPath}`);
    execFileSync('node', [cropHeadScript, cleanPath, croppedPath], { stdio: 'inherit' });
  }

  croppedPaths[expr] = croppedPath;
}

// Step 3: Build spritesheet
const spritesheetPath = join(outputDir, `${slug}-expressions.png`);
console.log(`\n--- SPRITESHEET ---`);

const spritesheetArgs = [buildSpritesheetScript, spritesheetPath];
for (const expr of EXPRESSIONS) {
  if (croppedPaths[expr]) {
    spritesheetArgs.push(`--${expr}`, croppedPaths[expr]);
  }
}

execFileSync('node', spritesheetArgs, { stdio: 'inherit' });

console.log(`\n=== Done: ${spritesheetPath} ===\n`);
