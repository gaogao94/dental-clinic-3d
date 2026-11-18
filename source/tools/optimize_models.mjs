#!/usr/bin/env node
// Optimize generated dental GLBs for web preview + delivery:
//   * drop normal / metallicRoughness textures (baked 2048 PNG, not useful for preview)
//   * resize remaining baseColor texture to <=1024 and re-encode as JPEG
//   * weld + quantize geometry (KHR_mesh_quantization) to cut file size
// Keeps the untouched service output as model_raw.glb next to the model.
//
// Usage:
//   node dental/tools/optimize_models.mjs [--limit N] [--only id1,id2]
//        [--texture-size 1024] [--quality 84] [--dry-run] [--workers 2]
// Output: dental/models/<id>/model.glb (optimized), model_raw.glb (original),
//         meta.json gains "optimized": {...}; report at dental/logs/optimize-report.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { textureCompress, quantize, weld, prune } from '@gltf-transform/functions';
import sharp from 'sharp';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOLS, '..', '..');
let MODELS_DIR = path.join(ROOT, 'dental', 'models');
const REPORT = path.join(ROOT, 'dental', 'logs', 'optimize-report.json');
// Original service outputs (with 2048px PNG textures) are archived off the work drive:
// D: runs low on space while the full library is generated.
let RAW_ARCHIVE_DIR = process.env.DENTAL_RAW_ARCHIVE || 'C:\\dental-models-raw';

const args = {
  limit: 0, only: null, textureSize: 1024, quality: 84, dryRun: false, workers: 1, force: false,
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === '--limit') args.limit = Number(next()) || 0;
  else if (a === '--only') args.only = String(next()).split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--texture-size') args.textureSize = Number(next()) || 1024;
  else if (a === '--quality') args.quality = Number(next()) || 84;
  else if (a === '--dry-run') args.dryRun = true;
  else if (a === '--force') args.force = true;
  else if (a === '--workers') args.workers = Math.max(1, Number(next()) || 1);
  else if (a === '--models-dir') MODELS_DIR = path.resolve(ROOT, next());
  else if (a === '--raw-dir') RAW_ARCHIVE_DIR = path.resolve(next());
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const report = { startedAt: new Date().toISOString(), items: [] };

function listTargets() {
  const out = [];
  for (const name of fs.readdirSync(MODELS_DIR)) {
    if (name.startsWith('_') || name.startsWith('zz-')) continue;
    const dir = path.join(MODELS_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const model = path.join(dir, 'model.glb');
    if (!fs.existsSync(model)) continue;
    if (args.only && !args.only.includes(name)) continue;
    out.push({ id: name, dir, model });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return args.limit ? out.slice(0, args.limit) : out;
}

async function optimizeOne(t) {
  const raw = path.join(t.dir, 'model_raw.glb');
  const rawArchive = path.join(RAW_ARCHIVE_DIR, t.id, 'model_raw.glb');
  const sizeBefore = fs.statSync(t.model).size;
  const metaPath = path.join(t.dir, 'meta.json');
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8').replace(/^\uFEFF/, '')); } catch { meta = null; }
  const already = Boolean(meta && meta.optimized && meta.optimized.sizeBytes === sizeBefore);
  if (already && !args.force) {
    return { id: t.id, status: 'skipped', sizeBefore, sizeAfter: sizeBefore };
  }
  const tmp = path.join(t.dir, `.opt-${process.pid}.glb`);
  try {
    const doc = await io.read(t.model);
    const root = doc.getRoot();
    for (const mat of root.listMaterials()) {
      mat.setNormalTexture(null);
      mat.setMetallicRoughnessTexture(null);
      if (mat.getMetallicFactor() > 0.5) mat.setMetallicFactor(0.0);
      if (mat.getRoughnessFactor() < 0.2) mat.setRoughnessFactor(0.85);
    }
    await doc.transform(
      weld({ tolerance: 0.0001 }),
      quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }),
      prune(),
      textureCompress({
        encoder: sharp, targetFormat: 'jpeg',
        resize: [args.textureSize, args.textureSize], quality: args.quality,
      }),
    );
    await io.write(tmp, doc);
    fs.mkdirSync(path.dirname(rawArchive), { recursive: true });
    fs.copyFileSync(t.model, rawArchive); // cross-drive: copy then unlink (rename fails with EXDEV)
    fs.unlinkSync(t.model);
    fs.renameSync(tmp, t.model);
    const sizeAfter = fs.statSync(t.model).size;
    const metaPath = path.join(t.dir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8').replace(/^\uFEFF/, ''));
        meta.optimized = {
          sizeBytes: sizeAfter, rawBytes: sizeBefore, textureSize: args.textureSize,
          quality: args.quality, rawArchivePath: rawArchive,
        };
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 1), 'utf8');
      } catch { /* keep going */ }
    }
    return { id: t.id, status: 'ok', sizeBefore, sizeAfter, rawArchive };
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { id: t.id, status: 'error', sizeBefore, error: String(e && e.message || e).slice(0, 300) };
  }
}

const targets = listTargets();
console.log(`targets: ${targets.length}`);
let done = 0;
let savedBefore = 0;
let savedAfter = 0;
const queue = [...targets];
async function worker(wid) {
  while (queue.length) {
    const t = queue.shift();
    const res = await optimizeOne(t);
    if (res.status === 'ok' && !args.dryRun) {
      savedBefore += res.sizeBefore;
      savedAfter += res.sizeAfter;
    }
    report.items.push(res);
    done += 1;
    if (done % 10 === 0 || res.status !== 'ok') {
      console.log(`[${done}/${targets.length}] ${res.id}: ${res.status} ${res.sizeBefore || 0} -> ${res.sizeAfter || 0}`);
    }
    if (args.dryRun) { report.items.pop(); }
  }
}
await Promise.all(Array.from({ length: args.workers }, (_, i) => worker(i)));
report.finishedAt = new Date().toISOString();
report.savedBytes = Math.max(0, savedBefore - savedAfter);
fs.writeFileSync(REPORT, JSON.stringify(report, null, 1), 'utf8');
console.log(`done: ${done}, saved ${(report.savedBytes / 1e6).toFixed(1)} MB -> ${REPORT}`);
