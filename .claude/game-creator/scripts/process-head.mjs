#!/usr/bin/env node
/**
 * process-head.mjs — Strip background from a head/face image using ML.
 *
 * Uses @imgly/background-removal-node (ISNet ONNX model) to produce a
 * clean transparent PNG. No halos, no color threshold hacks.
 *
 * Usage:
 *   node scripts/process-head.mjs <input> [output]
 *
 * Examples:
 *   node scripts/process-head.mjs public/assets/trump-head.png
 *   node scripts/process-head.mjs photo.jpg public/assets/cleaned.png
 *
 * If output is omitted, overwrites the input file.
 * First run downloads ~40 MB of model files (cached for future runs).
 */

import { removeBackground } from '@imgly/background-removal-node';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node scripts/process-head.mjs <input> [output]');
  process.exit(1);
}

const inputPath = resolve(args[0]);
const outputPath = resolve(args[1] || inputPath);

console.log(`Processing: ${basename(inputPath)}`);
console.log('(First run downloads ~40 MB model — cached after that)\n');

const startTime = Date.now();

try {
  // Read source image — detect MIME from magic bytes
  const inputBuffer = await readFile(inputPath);
  let mime = 'image/png';
  if (inputBuffer[0] === 0xFF && inputBuffer[1] === 0xD8) mime = 'image/jpeg';
  else if (inputBuffer[0] === 0x89 && inputBuffer[1] === 0x50) mime = 'image/png';
  else if (inputBuffer[0] === 0x52 && inputBuffer[1] === 0x49) mime = 'image/webp';
  const inputBlob = new Blob([inputBuffer], { type: mime });
  console.log(`  Detected: ${mime} (${(inputBuffer.length / 1024).toFixed(0)} KB)`);

  // Run ML background removal
  const resultBlob = await removeBackground(inputBlob, {
    model: 'medium',       // Good balance of quality/speed (~80 MB)
    output: {
      format: 'image/png',
      quality: 1.0,
      type: 'foreground',  // Keep the person, remove everything else
    },
    progress: (key, current, total) => {
      if (total > 0) {
        const pct = Math.round((current / total) * 100);
        process.stdout.write(`\r  ${key}: ${pct}%`);
        if (current >= total) process.stdout.write('\n');
      }
    },
  });

  // Write transparent PNG
  const resultBuffer = Buffer.from(await resultBlob.arrayBuffer());
  await writeFile(outputPath, resultBuffer);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s → ${basename(outputPath)} (${(resultBuffer.length / 1024).toFixed(0)} KB)`);
} catch (err) {
  console.error('Background removal failed:', err.message);
  process.exit(1);
}
