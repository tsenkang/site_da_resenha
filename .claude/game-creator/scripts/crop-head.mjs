#!/usr/bin/env node
/**
 * crop-head.mjs — Smart face crop using face-api.js detection.
 *
 * Uses @vladmandic/face-api (SSD MobileNet v1) to detect the face
 * bounding box, then crops with configurable padding. Falls back to
 * the bounding-box-of-non-transparent-pixels heuristic if no face
 * is detected.
 *
 * Usage:
 *   node scripts/crop-head.mjs <input> [output] [--padding 0.25]
 *
 * Example:
 *   node scripts/crop-head.mjs input.png output.png
 *   node scripts/crop-head.mjs input.png output.png --padding 0.40
 */

import sharp from 'sharp';
import { resolve, basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Polyfill deprecated util functions — removed/deprecated in Node 22+ but needed by @tensorflow/tfjs-node
import util from 'node:util';
if (!util.isNullOrUndefined) {
  util.isNullOrUndefined = (v) => v === null || v === undefined;
}
// Override to suppress DEP0044 deprecation warning
util.isArray = Array.isArray;

const faceapi = require('@vladmandic/face-api');
const canvasPkg = require('canvas');

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Arg parsing ---

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node scripts/crop-head.mjs <input> [output] [--padding 0.25]');
  process.exit(1);
}

let facePadding = 0.25;
const positional = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--padding' && args[i + 1]) {
    facePadding = parseFloat(args[++i]);
  } else if (args[i] === '--ratio') {
    // Legacy flag — ignore silently (face detection replaces it)
    if (args[i + 1] && !args[i + 1].startsWith('--')) i++;
  } else {
    positional.push(args[i]);
  }
}

const inputFile = positional[0];
const outputFile = positional[1];

const inputPath = resolve(inputFile);
const outputPath = resolve(outputFile || inputPath.replace(/\.png$/, '-head.png'));

console.log(`Cropping head from: ${basename(inputPath)} (padding: ${facePadding})`);

// --- Load face-api model ---

const MODEL_DIR = join(dirname(require.resolve('@vladmandic/face-api')), '..', 'model');

async function initFaceApi() {
  // Monkey-patch the environment for face-api (needs canvas globals)
  faceapi.env.monkeyPatch({
    Canvas: canvasPkg.Canvas,
    Image: canvasPkg.Image,
    ImageData: canvasPkg.ImageData,
    createCanvasElement: () => canvasPkg.createCanvas(1, 1),
    createImageElement: () => new canvasPkg.Image(),
  });

  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_DIR);
  console.log('  Face detection model loaded');
}

// --- Face detection ---

async function detectFace(imagePath) {
  const img = await canvasPkg.loadImage(imagePath);
  const canvas = canvasPkg.createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const detection = await faceapi.detectSingleFace(
    canvas,
    new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 })
  );

  if (!detection) return null;

  const box = detection.box;
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
    score: detection.score,
  };
}

// --- Bounding box fallback (from original crop-head.mjs) ---

async function fallbackBboxCrop(inputPath) {
  console.log('  No face detected — using bounding-box fallback');
  const headRatio = 0.45; // generous default

  const image = sharp(inputPath);
  const { width, height } = await image.metadata();
  const { data } = await image.raw().ensureAlpha().toBuffer({ resolveWithObject: true });

  let minX = width, maxX = 0, minY = height, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const figureW = maxX - minX;
  const figureH = maxY - minY;
  const centerX = minX + figureW / 2;

  console.log(`  Figure bounds: ${figureW}x${figureH} at (${minX},${minY})`);

  const headH = Math.round(figureH * headRatio);
  const headW = Math.round(headH * 0.9);
  const pad = Math.round(headW * 0.15);

  const cropX = Math.max(0, Math.round(centerX - headW / 2) - pad);
  const cropY = Math.max(0, minY - pad);
  const cropW = Math.min(width - cropX, headW + pad * 2);
  const cropH = Math.min(height - cropY, headH + pad * 2);

  return { cropX, cropY, cropW, cropH, width, height };
}

// --- Trim pass: remove excess transparent border, re-add padding ---

async function trimAndRepad(buffer) {
  const trimImage = sharp(buffer);
  const trimMeta = await trimImage.metadata();
  const { data: trimData } = await trimImage.raw().ensureAlpha().toBuffer({ resolveWithObject: true });

  let tMinX = trimMeta.width, tMaxX = 0, tMinY = trimMeta.height, tMaxY = 0;
  for (let y = 0; y < trimMeta.height; y++) {
    for (let x = 0; x < trimMeta.width; x++) {
      const alpha = trimData[(y * trimMeta.width + x) * 4 + 3];
      if (alpha > 10) {
        if (x < tMinX) tMinX = x;
        if (x > tMaxX) tMaxX = x;
        if (y < tMinY) tMinY = y;
        if (y > tMaxY) tMaxY = y;
      }
    }
  }

  const contentW = tMaxX - tMinX + 1;
  const contentH = tMaxY - tMinY + 1;

  const padX = Math.round(contentW * 0.05);
  const padY = Math.round(contentH * 0.05);

  const finalX = Math.max(0, tMinX - padX);
  const finalY = Math.max(0, tMinY - padY);
  const finalW = Math.min(trimMeta.width - finalX, contentW + padX * 2);
  const finalH = Math.min(trimMeta.height - finalY, contentH + padY * 2);

  console.log(`  Trimmed: ${finalW}x${finalH} (content: ${contentW}x${contentH})`);

  return sharp(buffer)
    .extract({ left: finalX, top: finalY, width: finalW, height: finalH })
    .toBuffer();
}

// --- Main ---

await initFaceApi();

const { width: imgWidth, height: imgHeight } = await sharp(inputPath).metadata();
const face = await detectFace(inputPath);

let croppedBuffer;

if (face) {
  console.log(`  Face detected: ${face.width}x${face.height} at (${face.x},${face.y}) [confidence: ${(face.score * 100).toFixed(1)}%]`);

  // Add padding around the face box
  const padX = Math.round(face.width * facePadding);
  const padY = Math.round(face.height * facePadding);

  const cropX = Math.max(0, face.x - padX);
  const cropY = Math.max(0, face.y - padY);
  const cropRight = Math.min(imgWidth, face.x + face.width + padX);
  const cropBottom = Math.min(imgHeight, face.y + face.height + padY);
  const cropW = cropRight - cropX;
  const cropH = cropBottom - cropY;

  console.log(`  Crop region: ${cropW}x${cropH} at (${cropX},${cropY})`);

  croppedBuffer = await sharp(inputPath)
    .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
    .toBuffer();
} else {
  // Fallback: bounding box heuristic
  const { cropX, cropY, cropW, cropH } = await fallbackBboxCrop(inputPath);

  console.log(`  Fallback crop: ${cropW}x${cropH} at (${cropX},${cropY})`);

  croppedBuffer = await sharp(inputPath)
    .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
    .toBuffer();
}

// Trim pass — remove excess transparent border
const finalBuffer = await trimAndRepad(croppedBuffer);

await sharp(finalBuffer).toFile(outputPath);
console.log(`  → ${basename(outputPath)}`);
