#!/usr/bin/env node
/**
 * optimize-glb.mjs — Optimize GLB files for web games.
 *
 * Zero npm dependencies. Uses `npx` to run @gltf-transform/cli.
 *
 * Pipeline:
 *   1. Resize textures to max dimensions (default 1024x1024)
 *   2. Optimize: dedup, prune, weld, meshopt compression, WebP textures
 *
 * Usage:
 *   node scripts/optimize-glb.mjs <file.glb>
 *   node scripts/optimize-glb.mjs <file.glb> --texture-size 512
 *   node scripts/optimize-glb.mjs <file.glb> --no-compress
 *   node scripts/optimize-glb.mjs <file.glb> --verbose
 *
 * Flags:
 *   --texture-size <n>   Max texture dimension (default: 1024)
 *   --no-compress        Skip meshopt compression (texture optimization only)
 *   --verbose            Show gltf-transform output
 *
 * Exit codes:
 *   0 — success (or graceful fallback if gltf-transform unavailable)
 *   1 — missing input file or other fatal error
 */

import { existsSync, statSync, copyFileSync, unlinkSync } from 'node:fs';
import { resolve, basename, dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(name, fallback = null) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  return args[idx + 1];
}

const hasFlag = (name) => args.includes(`--${name}`);

// First positional arg is the GLB file path
const inputFile = args.find((a) => !a.startsWith('--'));
const textureSize = parseInt(getArg('texture-size', '1024'), 10);
const noCompress = hasFlag('no-compress');
const verbose = hasFlag('verbose');

if (!inputFile) {
  console.error(`Usage: node scripts/optimize-glb.mjs <file.glb> [options]

Options:
  --texture-size <n>   Max texture dimension (default: 1024)
  --no-compress        Skip meshopt compression (texture optimization only)
  --verbose            Show gltf-transform output`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function run(cmd) {
  const stdio = verbose ? 'inherit' : 'pipe';
  try {
    execSync(cmd, { stdio, timeout: 120_000 });
    return true;
  } catch (err) {
    if (verbose) console.error(`  [optimize] Command failed: ${cmd}`);
    return false;
  }
}

/**
 * Check if gltf-transform is available via npx.
 */
function checkGltfTransform() {
  try {
    execSync('npx --yes @gltf-transform/cli --help', { stdio: 'pipe', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main optimization pipeline
// ---------------------------------------------------------------------------

export function optimizeGlb(filePath, options = {}) {
  const {
    textureSize: texSize = 1024,
    noCompress: skipCompress = false,
    verbose: isVerbose = false,
  } = options;

  const absPath = resolve(filePath);

  if (!existsSync(absPath)) {
    console.error(`  [optimize] File not found: ${absPath}`);
    return false;
  }

  if (!absPath.endsWith('.glb')) {
    if (isVerbose) console.log(`  [optimize] Skipping non-GLB file: ${basename(absPath)}`);
    return false;
  }

  const originalSize = statSync(absPath).size;
  const dir = dirname(absPath);
  const name = basename(absPath, '.glb');
  const tmpPath = join(dir, `${name}.opt.glb`);

  console.log(`  [optimize] Optimizing ${basename(absPath)} (${formatBytes(originalSize)})...`);

  // Check gltf-transform availability
  if (!checkGltfTransform()) {
    console.warn(`  [optimize] gltf-transform not available — skipping optimization`);
    console.warn(`  [optimize] Install with: npm install -g @gltf-transform/cli`);
    return false;
  }

  const npx = 'npx --yes @gltf-transform/cli';

  // Step 1: Resize textures
  const resizeOk = run(`${npx} resize "${absPath}" "${tmpPath}" --width ${texSize} --height ${texSize}`);
  if (!resizeOk) {
    // If resize fails, copy original to tmp for next step
    copyFileSync(absPath, tmpPath);
  }

  // Step 2: Optimize (dedup, prune, weld, compress)
  const optimizeSrc = tmpPath;
  let optimizeCmd;

  if (skipCompress) {
    // Texture optimization only — dedup, prune, weld, WebP textures
    optimizeCmd = `${npx} optimize "${optimizeSrc}" "${absPath}" --texture-compress webp`;
  } else {
    // Full optimization — dedup, prune, weld, meshopt compression, WebP textures
    optimizeCmd = `${npx} optimize "${optimizeSrc}" "${absPath}" --compress meshopt --texture-compress webp`;
  }

  const optimizeOk = run(optimizeCmd);

  // Cleanup tmp file
  try { unlinkSync(tmpPath); } catch { /* ignore */ }

  if (!optimizeOk) {
    // Restore original if optimization failed
    if (existsSync(absPath) && statSync(absPath).size === 0) {
      console.warn(`  [optimize] Optimization failed — keeping original file`);
    }
    return false;
  }

  const newSize = statSync(absPath).size;
  const savings = ((1 - newSize / originalSize) * 100).toFixed(0);
  console.log(`  [optimize] ${formatBytes(originalSize)} → ${formatBytes(newSize)} (${savings}% reduction)`);

  return true;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('optimize-glb.mjs')) {
  const absPath = resolve(inputFile);

  if (!existsSync(absPath)) {
    console.error(`Error: File not found: ${absPath}`);
    process.exit(1);
  }

  const success = optimizeGlb(absPath, { textureSize, noCompress, verbose });
  if (!success) {
    console.log(`  [optimize] Optimization skipped or failed — original file unchanged`);
  }
}
