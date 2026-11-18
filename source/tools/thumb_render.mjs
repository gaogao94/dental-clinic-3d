#!/usr/bin/env node
// Batch-render 320x320 3/4-view thumbnails for dental GLB objects.
// Node static server + headless Chrome (CDP). No npm deps besides local three.js.
//
// Usage:
//   node dental/tools/thumb_render.mjs [--force] [--batch-size 14] [--size 320]
//        [--only id1,id2] [--limit N] [--item-timeout 45000] [--out dental/preview/thumbs]
//
// Outputs: dental/preview/thumbs/<id>.png + dental/preview/thumbs-report.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launchChrome, newPage, connect, evaluate, waitFor, createStaticServer, sleep,
} from './cdp_lite.mjs';
import { repoRootFromTools, loadItems } from './object_data.mjs';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = repoRootFromTools();

function parseArgs(argv) {
  const args = {
    force: false, batchSize: 14, size: 320, only: null, limit: 0, includeTest: false,
    itemTimeout: 45000, outDir: path.join(REPO_ROOT, 'dental', 'preview', 'thumbs'),
    reportPath: path.join(REPO_ROOT, 'dental', 'preview', 'thumbs-report.json'),
    bg: '#f3f5f8',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--force') args.force = true;
    else if (a === '--include-test') args.includeTest = true;
    else if (a === '--batch-size') args.batchSize = Math.max(1, Number(next()) || 14);
    else if (a === '--size') args.size = Math.max(128, Number(next()) || 320);
    else if (a === '--only') args.only = String(next()).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--limit') args.limit = Math.max(0, Number(next()) || 0);
    else if (a === '--item-timeout') args.itemTimeout = Math.max(5000, Number(next()) || 45000);
    else if (a === '--out') args.outDir = path.resolve(REPO_ROOT, next());
    else if (a === '--report') args.reportPath = path.resolve(REPO_ROOT, next());
    else if (a === '--bg') args.bg = String(next());
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else throw new Error('unknown arg: ' + a);
  }
  return args;
}

function printHelp() {
  console.log(`thumb_render.mjs — 批量渲染牙科物件缩略图
  --force              重新渲染已有缩略图
  --include-test       把 dental/models/_test-smoke 的测试物件算进来
  --batch-size N       每批物件数（默认 14，建议 12–16）
  --size N             缩略图边长（默认 320）
  --only id1,id2       只渲染指定物件
  --limit N            最多渲染 N 件
  --item-timeout MS    单件超时（默认 45000）
  --out DIR            输出目录（默认 dental/preview/thumbs）
  --report FILE        报告路径（默认 dental/preview/thumbs-report.json）`);
}

const RENDER_PAGE = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>render</title>
<style>html,body{margin:0;background:#f3f5f8}canvas{display:block}</style>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
</head>
<body>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const SIZE = SIZE_PLACEHOLDER;
const BG = 'BG_PLACEHOLDER';
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
renderer.setPixelRatio(1);
renderer.setSize(SIZE, SIZE, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(new THREE.Color(BG), 1);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
try {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;
} catch (e) { /* environment is optional */ }
const hemi = new THREE.HemisphereLight(0xffffff, 0xb9c4d4, 0.85);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 1.55);
key.position.set(4, 7, 5);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.bias = -0.0004;
scene.add(key);
scene.add(key.target);
const fill = new THREE.DirectionalLight(0xffffff, 0.35);
fill.position.set(-5, 2, -4);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 0.5);
rim.position.set(-1.5, 3.5, -6);
scene.add(rim);
const camera = new THREE.PerspectiveCamera(35, 1, 0.001, 100000);

const loader = new GLTFLoader();
const VIEW_DIR = new THREE.Vector3(0.82, 0.62, 1.0).normalize();

function disposeObject(root) {
  root.traverse((node) => {
    if (node.geometry) node.geometry.dispose();
    const mats = node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : [];
    for (const m of mats) {
      for (const key of Object.keys(m)) {
        const v = m[key];
        if (v && v.isTexture) v.dispose();
      }
      m.dispose();
    }
  });
}

async function renderOne(item) {
  const gltf = await new Promise((resolve, reject) => {
    loader.load(item.url, resolve, undefined, (err) => reject(new Error('加载失败: ' + (err && err.message || err))));
  });
  const obj = gltf.scene || (gltf.scenes && gltf.scenes[0]);
  if (!obj) throw new Error('GLB 无场景');
  const box = new THREE.Box3().setFromObject(obj);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) throw new Error('模型包围盒为空');
  let meshCount = 0;
  obj.traverse((n) => { if (n.isMesh) { meshCount += 1; n.castShadow = true; } });
  if (!meshCount) throw new Error('模型不含网格');
  scene.add(obj);
  const radius = sphere.radius;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 14, radius * 14),
    new THREE.ShadowMaterial({ opacity: 0.14 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = box.min.y;
  ground.receiveShadow = true;
  scene.add(ground);
  try {
    key.position.copy(sphere.center).add(new THREE.Vector3(0.55, 1.0, 0.45).multiplyScalar(radius * 3.2));
    key.target.position.copy(sphere.center);
    key.target.updateMatrixWorld();
    key.shadow.camera.left = -radius * 2.2;
    key.shadow.camera.right = radius * 2.2;
    key.shadow.camera.top = radius * 2.2;
    key.shadow.camera.bottom = -radius * 2.2;
    key.shadow.camera.near = radius * 0.05;
    key.shadow.camera.far = radius * 12;
    key.shadow.camera.updateProjectionMatrix();
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const distance = (sphere.radius / Math.sin(fov / 2)) * 1.06;
    camera.position.copy(sphere.center).addScaledVector(VIEW_DIR, distance);
    camera.near = Math.max(distance / 2000, 0.0001);
    camera.far = distance * 2000;
    camera.updateProjectionMatrix();
    camera.lookAt(sphere.center);
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  } finally {
    scene.remove(ground);
    ground.geometry.dispose();
    ground.material.dispose();
    scene.remove(obj);
    disposeObject(obj);
  }
}

const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
  let done = false;
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    reject(new Error('单件超时: ' + label));
  }, ms);
  promise.then((v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); },
    (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); });
});

window.renderBatch = async (items, opts = {}) => {
  const itemTimeoutMs = opts.itemTimeoutMs || 45000;
  const out = [];
  for (const item of items) {
    const t0 = performance.now();
    try {
      const dataUrl = await withTimeout(renderOne(item), itemTimeoutMs, item.id);
      out.push({ id: item.id, ok: true, dataUrl, ms: Math.round(performance.now() - t0) });
    } catch (err) {
      out.push({ id: item.id, ok: false, error: String((err && err.message) || err), ms: Math.round(performance.now() - t0) });
    }
  }
  return out;
};
window.__renderPageReady = true;
</script>
</body></html>`;

function fmtDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms / 60000) + 'm' + Math.round((ms % 60000) / 1000) + 's';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = REPO_ROOT;
  const threeDir = path.join(repoRoot, '_probe', 'node_modules', 'three');
  fs.mkdirSync(args.outDir, { recursive: true });
  fs.mkdirSync(path.dirname(args.reportPath), { recursive: true });

  const loaded = loadItems({ repoRoot, includeTest: args.includeTest });
  let items = loaded.items.filter((it) => it.modelExists);
  if (args.only) items = items.filter((it) => args.only.includes(it.id));
  if (args.limit) items = items.slice(0, args.limit);
  if (!items.length) {
    console.error('没有可渲染的模型（dental/models/<id>/model.glb 不存在）');
    process.exitCode = 2;
    return;
  }

  const thumbFile = (id) => path.join(args.outDir, id + '.png');
  const pending = [];
  let existing = 0;
  for (const it of items) {
    const out = thumbFile(it.id);
    if (!args.force && fs.existsSync(out) && fs.statSync(out).size > 0
        && fs.statSync(out).mtimeMs >= fs.statSync(it.modelFile).mtimeMs) {
      existing += 1;
      continue;
    }
    pending.push(it);
  }

  const report = {
    schema: 'dental-clinic-thumbs/v1',
    generatedAt: new Date().toISOString(),
    size: args.size,
    batchSize: args.batchSize,
    total: items.length,
    rendered: 0,
    failed: 0,
    skippedExisting: existing,
    skippedRemaining: 0,
    batches: 0,
    durationMs: 0,
    items: [],
  };
  for (const it of items) {
    if (!pending.includes(it)) report.items.push({ id: it.id, zh: it.zh, status: 'existing', file: path.relative(repoRoot, thumbFile(it.id)).replace(/\\/g, '/') });
  }

  const startedAt = Date.now();
  console.log(`[thumb] 待渲染 ${pending.length} 件 / 共 ${items.length} 件（已有 ${existing}）`);

  const chunks = [];
  for (let i = 0; i < pending.length; i += args.batchSize) chunks.push(pending.slice(i, i + args.batchSize));

  let chrome = null;
  let server = null;
  let page = null;
  let port = 0;
  const closePage = () => { try { page?.cdp.close(); } catch {} page = null; };

  async function startPage() {
    closePage();
    const target = await newPage(port, 'about:blank');
    const cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    page = { targetId: target.id, cdp };
    return page;
  }

  async function renderViaPage(batch) {
    const p = page;
    await p.cdp.send('Page.navigate', { url: server.url('/_render-page.html') });
    await waitFor(p.cdp, "document.readyState === 'complete' && window.__renderPageReady === true", {
      timeoutMs: 45000, label: 'render page load',
    });
    const payload = batch.map((it) => {
      const rel = path.relative(path.join(repoRoot, 'dental', 'models'), it.dir).split(path.sep).join('/');
      return { id: it.id, url: server.url('/models/' + rel + '/model.glb') };
    });
    return evaluate(p.cdp, `window.renderBatch(${JSON.stringify(payload)}, {itemTimeoutMs:${args.itemTimeout}})`, {
      timeoutMs: Math.max(120000, args.itemTimeout * batch.length + 60000),
    });
  }

  try {
    // render page lives next to the thumbnails; server root = dental/preview
    const tmpPage = path.join(repoRoot, 'dental', 'preview', '_render-page.html');
    fs.mkdirSync(path.dirname(tmpPage), { recursive: true });
    fs.writeFileSync(tmpPage, RENDER_PAGE
      .replace('SIZE_PLACEHOLDER', String(args.size))
      .replace('BG_PLACEHOLDER', args.bg));
    server = await createStaticServer(path.join(repoRoot, 'dental', 'preview'), [
      { prefix: '/three/', dir: threeDir },
      { prefix: '/models/', dir: path.join(repoRoot, 'dental', 'models') },
    ]);

    chrome = await launchChrome({ width: args.size, height: args.size });
    port = chrome.port;
    await startPage();

    let batchIndex = 0;
    for (const batch of chunks) {
      batchIndex += 1;
      const tag = `[thumb] 批次 ${batchIndex}/${chunks.length}（${batch.length} 件）`;
      console.log(tag);
      let results = null;
      try {
        results = await renderViaPage(batch);
        report.batches += 1;
      } catch (err) {
        console.warn(tag + ' 整批失败，改逐件重试: ' + err.message);
        await startPage().catch(() => {});
        results = [];
        for (const it of batch) {
          try {
            const one = await renderViaPage([it]);
            results.push(...(one || []));
            report.batches += 1;
          } catch (e2) {
            results.push({ id: it.id, ok: false, error: '批次重试失败: ' + e2.message, ms: 0 });
          }
        }
      }
      const byId = new Map((results || []).map((r) => [r.id, r]));
      for (const it of batch) {
        const r = byId.get(it.id);
        const rel = path.relative(repoRoot, thumbFile(it.id)).replace(/\\/g, '/');
        if (r && r.ok && r.dataUrl) {
          const base64 = r.dataUrl.replace(/^data:image\/png;base64,/, '');
          fs.writeFileSync(thumbFile(it.id), Buffer.from(base64, 'base64'));
          report.rendered += 1;
          report.items.push({ id: it.id, zh: it.zh, status: 'ok', file: rel, ms: r.ms });
          console.log(`  ok ${it.id} (${fmtDuration(r.ms)})`);
        } else {
          report.failed += 1;
          report.items.push({ id: it.id, zh: it.zh, status: 'failed', error: r?.error || '无结果', file: null });
          console.warn(`  fail ${it.id}: ${r?.error || '无结果'}`);
        }
      }
    }
  } finally {
    try { closePage(); } catch {}
    try { chrome?.close(); } catch {}
    try { await server?.close(); } catch {}
    try { fs.rmSync(path.join(repoRoot, 'dental', 'preview', '_render-page.html'), { force: true }); } catch {}
  }

  report.durationMs = Date.now() - startedAt;
  report.skippedRemaining = pending.length - report.rendered - report.failed;
  fs.writeFileSync(args.reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`[thumb] 完成 渲染 ${report.rendered} 失败 ${report.failed} 跳过(已有) ${report.skippedExisting}，用时 ${fmtDuration(report.durationMs)}`);
  console.log('[thumb] 报告 ' + path.relative(repoRoot, args.reportPath).replace(/\\/g, '/'));
  if (report.rendered === 0 && report.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[thumb] 致命错误: ' + (err && err.stack || err));
  process.exitCode = 1;
});
