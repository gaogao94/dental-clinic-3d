#!/usr/bin/env node
// Build lightweight LOD copies of the demo assets for software-rendered browsers:
//   * simplify geometry (meshopt) to ~30% triangles
//   * quantize + jpeg textures at 512px
// Writes dental/demo/lod-models/<id>/model.glb (raw sources untouched).
//
// Usage: node dental/tools/build_demo_lod.mjs [--limit N] [--only a,b] [--ratio 0.3] [--workers 2]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  textureCompress, quantize, weld, prune, simplify,
} from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOLS, '..', '..');
const DENTAL = path.join(ROOT, 'dental');
const OUT = path.join(DENTAL, 'demo', 'lod-models');
const REPORT = path.join(DENTAL, 'demo', 'lod-report.json');

const argv = process.argv.slice(2);
const args = { limit: 0, only: null, ratio: 0.3, error: 0.002, workers: 2, force: false };
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === '--limit') args.limit = Number(next()) || 0;
  else if (a === '--only') args.only = String(next()).split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--ratio') args.ratio = Number(next()) || 0.3;
  else if (a === '--error') args.error = Number(next()) || 0.002;
  else if (a === '--workers') args.workers = Math.max(1, Number(next()) || 2);
  else if (a === '--force') args.force = true;
}

await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const ids = JSON.parse(fs.readFileSync(path.join(DENTAL, 'demo', 'lod-ids.json'), 'utf8'));
const queue = (args.only || ids).filter((id) => args.only || !fs.existsSync(path.join(OUT, id, 'model.glb')) || args.force);
const targets = args.limit ? queue.slice(0, args.limit) : queue;
console.log(`targets: ${targets.length} / used ids ${ids.length}`);

function srcOf(id) {
  const extra = path.join(DENTAL, 'demo', 'extra', 'models', id, 'model.glb');
  if (fs.existsSync(extra)) return extra;
  const main = path.join(DENTAL, 'models', id, 'model.glb');
  if (fs.existsSync(main)) return main;
  return null;
}

async function one(id) {
  const src = srcOf(id);
  if (!src) return { id, status: 'missing' };
  const outDir = path.join(OUT, id);
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = path.join(outDir, 'model.tmp.glb');
  try {
    const doc = await io.read(src);
    await doc.transform(
      weld({ tolerance: 0.0001 }),
      simplify({ simplifier: MeshoptSimplifier, ratio: args.ratio, error: args.error }),
      prune(),
      quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }),
      textureCompress({ encoder: sharp, targetFormat: 'jpeg', resize: [512, 512], quality: 78 }),
    );
    await io.write(tmp, doc);
    const dst = path.join(outDir, 'model.glb');
    fs.renameSync(tmp, dst);
    return { id, status: 'ok', srcBytes: fs.statSync(src).size, bytes: fs.statSync(dst).size };
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { id, status: 'error', error: String(e && e.message || e).slice(0, 200) };
  }
}

const report = [];
let cursor = 0;
let done = 0;
async function worker() {
  while (cursor < targets.length) {
    const id = targets[cursor++];
    const r = await one(id);
    report.push(r);
    done += 1;
    if (done % 10 === 0 || r.status !== 'ok') console.log(`[${done}/${targets.length}] ${id}: ${r.status} ${((r.bytes || 0) / 1e6).toFixed(2)}MB`);
  }
}
await Promise.all(Array.from({ length: args.workers }, worker));
fs.writeFileSync(REPORT, JSON.stringify({ at: new Date().toISOString(), ratio: args.ratio, report }, null, 1));
const total = report.reduce((s, r) => s + (r.bytes || 0), 0);
console.log(`done: ok=${report.filter((r) => r.status === 'ok').length} err=${report.filter((r) => r.status !== 'ok').length} total=${(total / 1e6).toFixed(1)}MB -> ${OUT}`);
