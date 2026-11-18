#!/usr/bin/env node
// 出图 · 算量 · 估价 —— 浏览器端 E2E（契约 §6.3）
//
// 用法：
//   node dental/tools/shot-sheet.mjs [选项]
//     --out-dir <dir>      截图 / 结果输出目录（默认 _lead_scratch/qa）
//     --timeout <seconds>  页面 __demoReady 超时（默认 240）
//     --js-dir <dir>       纯模块目录（默认 dental/server/public/demo/js，用于与浏览器结果对照）
//     --no-node-compare    跳过 node 端一致性对照
//     --skip-downloads     跳过三个下载按钮的验证
//     --keep-open          结束后不关闭 Chrome（调试）
//
// 静态服务：root=dental/server/public；mount:
//   /demo/lod-models/    → dental/demo/lod-models
//   /demo/extra/models/  → dental/demo/extra/models
//   /models/             → dental/models
// 页面：/demo/index.html?shadow=0&dpr=1
//
// 校验：window.__demoReady；console/异常无 error；window.demo.quote()/drawing()/dxf()/svg()/csv()
// 非空且与 node 端同配置一致；点「出图」→ 截图；切平台/类型/风格各截图；三个下载按钮
// （Page.setDownloadBehavior）落盘校验文件名与内容；ESC 关闭；打印路径不报错。
//
// 退出码：0 全 PASS；1 有 FAIL；2 模块/页面未就绪。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  launchChrome, createStaticServer, newPage, connect, evaluate, waitFor,
  setViewport, screenshotToFile, sleep,
} from './cdp_lite.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DEMO = path.join(ROOT, 'dental/server/public/demo');

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = {
    outDir: path.join(ROOT, '_lead_scratch/qa'),
    timeout: 240,
    jsDir: path.join(DEMO, 'js'),
    nodeCompare: true,
    downloads: true,
    keepOpen: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out-dir') o.outDir = path.resolve(next());
    else if (a === '--timeout') o.timeout = Number(next());
    else if (a === '--js-dir') o.jsDir = path.resolve(next());
    else if (a === '--no-node-compare') o.nodeCompare = false;
    else if (a === '--skip-downloads') o.downloads = false;
    else if (a === '--keep-open') o.keepOpen = true;
    else if (a === '--help' || a === '-h') {
      console.log('node dental/tools/shot-sheet.mjs [--out-dir dir] [--timeout s] [--js-dir dir] [--no-node-compare] [--skip-downloads] [--keep-open]');
      process.exit(0);
    } else { console.error(`[shot] 未知参数: ${a}`); process.exit(2); }
  }
  return o;
}
const ARGS = parseArgs(process.argv.slice(2));
const OUT = ARGS.outDir;
const DL = path.join(OUT, 'dl');
const T0 = Date.now();

// ── 结果收集 ────────────────────────────────────────────────────────────────
const result = {
  ok: false,
  tool: 'shot-sheet',
  version: 1,
  startedAt: new Date().toISOString(),
  url: null,
  viewport: { width: 1280, height: 900, scale: 1 },
  checks: {},
  failures: [],
  warnings: [],
  consoleErrors: [],
  screenshots: [],
  downloads: [],
  state: {},
  numbers: {},
  elapsedMs: 0,
};
let failureTotal = 0;
const MAX_FAILURES = 200;
function check(name, ok, detail = '') {
  const c = result.checks[name] || (result.checks[name] = { pass: 0, fail: 0 });
  if (ok) { c.pass++; return true; }
  c.fail++; failureTotal++;
  if (result.failures.length < MAX_FAILURES) result.failures.push(`[${name}] ${detail}`);
  return false;
}
function warn(name, detail) {
  const c = result.checks[name] || (result.checks[name] = { pass: 0, fail: 0 });
  c.warnings = (c.warnings || 0) + 1;
  if (result.warnings.length < MAX_FAILURES) result.warnings.push(`[${name}] ${detail}`);
}
const log = (...a) => console.error('[shot]', ...a);
const rel = (p) => path.relative(ROOT, p);
function hashStr(s) { // djb2 over UTF-16 code units（与页面内一致）
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16) + ':' + s.length;
}

async function waitUntil(cdp, expr, { timeoutMs = 30000, intervalMs = 200, label = expr } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await evaluate(cdp, expr, { awaitPromise: true, timeoutMs: 30000 });
      if (v) return v;
      lastErr = null;
    } catch (e) { lastErr = e; }
    await sleep(intervalMs);
  }
  throw new Error(`waitUntil 超时: ${label}${lastErr ? ' / ' + lastErr.message : ''}`);
}

let cdp = null;
async function shot(name) {
  const file = path.join(OUT, `sheet-${name}.png`);
  await screenshotToFile(cdp, file);
  const st = fs.statSync(file);
  result.screenshots.push({ file: rel(file), bytes: st.size });
  return file;
}
async function click(sel) {
  return evaluate(cdp, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
}
async function textOf(sel) {
  return evaluate(cdp, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.innerText : ''; })()`);
}

// ── 文件/模块就绪 ───────────────────────────────────────────────────────────
function checkFiles() {
  const needed = ['js/quote.js', 'js/price-book.js', 'js/cad.js', 'js/sheet.js', 'js/main.js', 'index.html'];
  const missing = needed.map((f) => path.join(DEMO, f)).filter((f) => !fs.existsSync(f) || fs.statSync(f).size === 0);
  if (missing.length) {
    console.error('[shot] 模块未就绪，缺少文件：\n  ' + missing.map((f) => rel(f)).join('\n  '));
    return { ok: false, missing: missing.map((f) => rel(f)) };
  }
  const html = fs.readFileSync(path.join(DEMO, 'index.html'), 'utf8');
  const uiReady = html.includes('id="toggleSheet"') && html.includes('id="sheetPanel"');
  const mainJs = fs.readFileSync(path.join(DEMO, 'js/main.js'), 'utf8');
  const apiReady = /window\.demo\s*=/.test(mainJs) && /drawing\(\)/.test(mainJs) && /dxf\(\)/.test(mainJs);
  if (!uiReady || !apiReady) {
    console.error('[shot] UI 未接线完成：toggleSheet/sheetPanel 或 window.demo 出图 API 缺失');
    return { ok: false, missing: ['index.html#toggleSheet/sheetPanel 或 main.js window.demo 出图 API'], uiReady, apiReady };
  }
  return { ok: true };
}

// ── node 端对照 ────────────────────────────────────────────────────────────
async function loadNodeModules() {
  const load = async (f) => import(pathToFileURL(path.join(ARGS.jsDir, f)).href);
  const config = await load('config.js');
  const planMod = await load('plan.js');
  const quoteMod = await load('quote.js');
  const cadMod = await load('cad.js');
  return { ...config, buildPlan: planMod.buildPlan, buildQuote: quoteMod.buildQuote, buildDrawing: cadMod.buildDrawing, toDXF: cadMod.toDXF, toSVG: cadMod.toSVG };
}
function loadNodeMeta() {
  const map = new Map();
  for (const f of ['dental/server/public/inventory.json', 'dental/server/public/demo/extra/inventory-extra.json']) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      for (const it of data.items || []) map.set(it.id, { zh: it.zh, cat: it.category });
    } catch { /* meta 可选 */ }
  }
  return { nameOf: (id) => (map.get(id) && map.get(id).zh) || id, categoryOf: (id) => (map.get(id) && map.get(id).cat) || '' };
}

// ── 下载等待 ────────────────────────────────────────────────────────────────
function listDownloads() {
  try { return fs.readdirSync(DL).filter((f) => !f.endsWith('.crdownload')); } catch { return []; }
}
async function waitDownload(expectedName, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = listDownloads();
    if (files.includes(expectedName)) {
      const p = path.join(DL, expectedName);
      const s1 = fs.statSync(p).size;
      await sleep(150);
      if (fs.statSync(p).size === s1 && s1 > 0) return p;
    }
    await sleep(200);
  }
  return null;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(DL, { recursive: true, force: true });
  fs.mkdirSync(DL, { recursive: true });

  const files = checkFiles();
  if (!files.ok) { result.reason = 'module-not-ready'; result.missing = files.missing; finish(2); return; }

  let nodeMods = null;
  let nodeMeta = null;
  if (ARGS.nodeCompare) {
    try {
      nodeMods = await loadNodeModules();
      nodeMeta = loadNodeMeta();
    } catch (e) {
      log('node 端模块加载失败（跳过一致性对照）:', e.message);
      result.nodeCompareError = e.message;
      nodeMods = null;
    }
  }

  // 1) 静态服务
  const server = await createStaticServer(path.join(ROOT, 'dental/server/public'), [
    { prefix: '/demo/lod-models/', dir: path.join(ROOT, 'dental/demo/lod-models') },
    { prefix: '/demo/extra/models/', dir: path.join(ROOT, 'dental/demo/extra/models') },
    { prefix: '/models/', dir: path.join(ROOT, 'dental/models') },
  ]);
  const url = server.url('/demo/index.html?shadow=0&dpr=1');
  result.url = url;
  log('静态服务:', server.url('/'), '→ 页面', url);

  const chrome = await launchChrome({ width: 1280, height: 900 });
  const page = await newPage(chrome.port, 'about:blank');
  cdp = await connect(page.webSocketDebuggerUrl);
  const cleanup = async () => {
    try { cdp && cdp.close(); } catch { /* ignore */ }
    if (!ARGS.keepOpen) {
      try { await chrome.close(); } catch { /* ignore */ }
      try { await server.close(); } catch { /* ignore */ }
    }
  };
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await setViewport(cdp, 1280, 900, 1);

    // console / 异常收集
    const consoleErrors = [];
    let downloadDirReady = false;
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error' && p.type !== 'assert') return;
      const text = (p.args || []).map((a) => {
        if (a.value !== undefined) return String(a.value);
        if (a.description) return a.description;
        return a.type || '';
      }).join(' ');
      if (/favicon\.ico/.test(text)) return;
      consoleErrors.push({ kind: 'console.' + p.type, text: text.slice(0, 1000) });
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      consoleErrors.push({ kind: 'exception', text: ((d.exception && (d.exception.description || d.exception.value)) || d.text || '').slice(0, 1500) });
    });
    cdp.on('Log.entryAdded', (p) => {
      const e = p.entry || {};
      if (e.level !== 'error') return;
      const text = `${e.text || ''} ${e.url || ''}`;
      if (/favicon\.ico/.test(text)) return;
      consoleErrors.push({ kind: 'log.error', text: text.slice(0, 1000) });
    });

    // 2) 打开页面，等 __demoReady
    await cdp.send('Page.navigate', { url });
    log('等待 window.__demoReady …');
    try {
      await waitUntil(cdp, 'window.__demoReady === true', { timeoutMs: ARGS.timeout * 1000, label: 'window.__demoReady' });
    } catch (e) {
      const info = await evaluate(cdp, `JSON.stringify({ ready: !!window.__demoReady, lastError: window.__lastError || null, hasDemo: !!window.demo })`).catch(() => '{}');
      result.readyInfo = info;
      check('demoReady', false, `页面未就绪: ${e.message} / ${info}`);
      throw e;
    }
    check('demoReady', true, 'window.__demoReady 已置位');
    await sleep(300);
    const bootInfo = JSON.parse(await evaluate(cdp, `JSON.stringify({ lastError: window.__lastError || null, quoteError: window.__quoteError || null, loadErrors: window.__loadErrors || null, sheetError: window.__sheetError || null, innerW: window.innerWidth, innerH: window.innerHeight })`));
    result.bootInfo = bootInfo;
    check('no-lastError', !bootInfo.lastError, `window.__lastError=${bootInfo.lastError}`);
    check('no-quoteError', !bootInfo.quoteError, `window.__quoteError=${bootInfo.quoteError}`);
    check('no-loadErrors', !bootInfo.loadErrors, `window.__loadErrors=${JSON.stringify(bootInfo.loadErrors)}`);
    check('no-sheetError', !bootInfo.sheetError, `window.__sheetError=${bootInfo.sheetError}`);
    check('viewport', bootInfo.innerW === 1280 && bootInfo.innerH === 900, `window.inner=${bootInfo.innerW}x${bootInfo.innerH}`);

    // 3) window.demo API
    const api = JSON.parse(await evaluate(cdp, `(() => {
      const d = window.demo || {};
      const fns = ['quote','drawing','dxf','svg','csv','openSheet','closeSheet','print','printHtml'];
      return JSON.stringify({
        hasDemo: !!window.demo,
        fns: Object.fromEntries(fns.map((k) => [k, typeof d[k]])),
        state: d.state,
        info: d.info ? d.info() : null,
        metricsText: (document.getElementById('metrics') || {}).innerText || '',
        panelExists: !!document.getElementById('sheetPanel'),
        toggleExists: !!document.getElementById('toggleSheet'),
      });
    })()`));
    result.state = api.state || {};
    for (const [k, t] of Object.entries(api.fns || {})) check(`api-${k}`, t === 'function', `window.demo.${k} 类型=${t}`);
    check('api-state', !!(api.state && api.state.platform && api.state.type && api.state.style), `state=${JSON.stringify(api.state)}`);
    check('element-sheetPanel', api.panelExists, '#sheetPanel 不存在');
    check('element-toggleSheet', api.toggleExists, '#toggleSheet 不存在');
    check('no-missing-assets', !(api.info && api.info.missing && api.info.missing.length), `缺失模型=${JSON.stringify(api.info && api.info.missing)}`);
    const metricsText = api.metricsText || '';
    check('metrics-cost', metricsText.includes('估算造价') && !/^\s*—/.test(metricsText.trim()), `#metrics 缺估算造价数值: ${metricsText.replace(/\n/g, ' / ').slice(0, 200)}`);
    check('metrics-hours', metricsText.includes('估算工时') && !/^\s*—[\s\S]{0,30}估算工时/.test(metricsText), '#metrics 缺估算工时');
    // 4) 浏览器端 quote/drawing/dxf/svg/csv
    const state = api.state;
    const browserQuote = JSON.parse(await evaluate(cdp, `JSON.stringify(window.demo.quote())`));
    const drawingInfo = JSON.parse(await evaluate(cdp, `(() => {
      const d = window.demo.drawing();
      if (!d) return JSON.stringify({ missing: true });
      return JSON.stringify({
        kind: d.kind, units: d.units, version: d.version,
        project: d.project,
        sheets: (d.sheets || []).map((s) => ({ id: s.id, name: s.name, no: s.no, entities: (s.entities || []).length })),
      });
    })()`));
    const dxfInfo = JSON.parse(await evaluate(cdp, `(() => {
      const s = window.demo.dxf(); if (!s) return JSON.stringify({ missing: true });
      return JSON.stringify({ len: s.length, head: s.slice(0, 24), tail: s.slice(-8), hash: (() => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16) + ':' + s.length; })() });
    })()`));
    const svgInfo = JSON.parse(await evaluate(cdp, `(() => {
      const s = window.demo.svg(); if (!s) return JSON.stringify({ missing: true });
      return JSON.stringify({ len: s.length, head: s.slice(0, 24), tail: s.slice(-8), hasSvgTag: s.includes('<svg'), hash: (() => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16) + ':' + s.length; })() });
    })()`));
    const csvInfo = JSON.parse(await evaluate(cdp, `(() => {
      const s = window.demo.csv(); if (!s) return JSON.stringify({ missing: true });
      return JSON.stringify({ len: s.length, bom: s.charCodeAt(0) === 0xFEFF, head: s.slice(0, 40) });
    })()`));
    result.numbers.browser = {
      quoteTotal: browserQuote && browserQuote.totals && browserQuote.totals.total,
      quoteHours: browserQuote && browserQuote.labor && browserQuote.labor.totalHours,
      quoteLines: browserQuote && browserQuote.lines && browserQuote.lines.length,
      drawingSheets: drawingInfo.sheets && drawingInfo.sheets.length,
      drawingEntities: drawingInfo.sheets ? drawingInfo.sheets.reduce((a, s) => a + s.entities, 0) : 0,
      dxfBytes: dxfInfo.len, svgBytes: svgInfo.len, csvBytes: csvInfo.len,
    };
    check('quote-object', !!(browserQuote && browserQuote.kind === 'clinic-quote' && browserQuote.totals), `quote=${JSON.stringify(browserQuote && browserQuote.kind)}`);
    check('drawing-object', !!(drawingInfo && !drawingInfo.missing && drawingInfo.kind === 'cad-drawing'), `drawing=${JSON.stringify(drawingInfo && drawingInfo.kind)}`);
    check('drawing-sheets', !!(drawingInfo.sheets && drawingInfo.sheets.length >= 3), `drawing sheets=${drawingInfo.sheets && drawingInfo.sheets.length}（>=3，boq 续页可更多）`);
    check('drawing-planmep', !!(drawingInfo.sheets && drawingInfo.sheets.some((s) => s.id === 'plan') && drawingInfo.sheets.some((s) => s.id === 'mep')), `drawing sheets=${JSON.stringify(drawingInfo.sheets && drawingInfo.sheets.map((s) => s.id))}`);
    check('dxf-nonempty', !!(dxfInfo && dxfInfo.len > 20000), `DXF ${dxfInfo && dxfInfo.len} bytes`);
    check('dxf-structure', !!(dxfInfo && /SECTION/.test(dxfInfo.head) && /EOF/.test(dxfInfo.tail)), `DXF head=${dxfInfo && dxfInfo.head} tail=${dxfInfo && dxfInfo.tail}`);
    check('svg-nonempty', !!(svgInfo && svgInfo.len > 8000 && svgInfo.hasSvgTag), `SVG ${svgInfo && svgInfo.len} bytes`);
    check('csv-nonempty', !!(csvInfo && csvInfo.len > 500 && csvInfo.bom), `CSV ${csvInfo && csvInfo.len} bytes, BOM=${csvInfo && csvInfo.bom}`);
    // 指标卡数字与 quote 一致（造价按万元 1 位小数）
    if (browserQuote && browserQuote.totals && Number.isFinite(browserQuote.totals.total)) {
      const expectWan = (browserQuote.totals.total / 10000).toFixed(1);
      const firstNum = (metricsText.trim().match(/^([\d,]+\.\d)\s*万/) || [])[1];
      check('metrics-cost-match', firstNum === expectWan, `#metrics 造价=${firstNum} 万 != quote.total/10000=${expectWan} 万`);
      const expectHours = String(Math.round(browserQuote.labor.totalHours));
      check('metrics-hours-match', new RegExp('(^|\\n)' + expectHours + '\\s*人天').test(metricsText), `#metrics 工时不等于 quote.labor.totalHours=${browserQuote.labor.totalHours}`);
    }

    // 5) node 端一致性
    if (nodeMods) {
      try {
        const plan = nodeMods.buildPlan({ platform: state.platform, type: state.type, style: state.style, modules: state.modules });
        const meta = { nameOf: nodeMeta.nameOf, categoryOf: nodeMeta.categoryOf };
        const nq = nodeMods.buildQuote(plan, { meta });
        const nd = nodeMods.buildDrawing(plan, { boq: nq, meta });
        const ndxf = nodeMods.toDXF(nd);
        const nsvg = nodeMods.toSVG(nd);
        const nodeInfo = {
          total: nq.totals.total, hours: nq.labor.totalHours, lines: nq.lines.length,
          sheets: nd.sheets.length, entities: nd.sheets.reduce((a, s) => a + s.entities.length, 0),
          dxfBytes: ndxf.length, svgBytes: nsvg.length, dxfHash: hashStr(ndxf), svgHash: hashStr(nsvg),
        };
        result.numbers.node = nodeInfo;
        check('compare-total', browserQuote && browserQuote.totals && Math.abs(browserQuote.totals.total - nodeInfo.total) <= 1,
          `浏览器 total=${browserQuote && browserQuote.totals && browserQuote.totals.total} vs node=${nodeInfo.total}`);
        check('compare-hours', browserQuote && browserQuote.labor && Math.abs(browserQuote.labor.totalHours - nodeInfo.hours) < 1e-6,
          `浏览器 hours=${browserQuote && browserQuote.labor && browserQuote.labor.totalHours} vs node=${nodeInfo.hours}`);
        check('compare-lines', browserQuote && browserQuote.lines && browserQuote.lines.length === nodeInfo.lines,
          `浏览器 lines=${browserQuote && browserQuote.lines && browserQuote.lines.length} vs node=${nodeInfo.lines}`);
        check('compare-sheets', drawingInfo.sheets && drawingInfo.sheets.length === nodeInfo.sheets, `sheets ${drawingInfo.sheets && drawingInfo.sheets.length} vs ${nodeInfo.sheets}`);
        check('compare-entities', result.numbers.browser.drawingEntities === nodeInfo.entities, `entities ${result.numbers.browser.drawingEntities} vs ${nodeInfo.entities}`);
        const dxfRatio = dxfInfo.len / nodeInfo.dxfBytes;
        check('compare-dxf', Math.abs(dxfRatio - 1) <= 0.02, `DXF 长度比 ${dxfRatio.toFixed(4)}（浏览器 ${dxfInfo.len} / node ${nodeInfo.dxfBytes}）`);
        if (dxfInfo.hash === nodeInfo.dxfHash) check('compare-dxf-hash', true, 'DXF 与 node 端逐字节一致');
        else warn('compare-dxf-hash', `DXF 与 node 端非逐字节一致（浏览器 ${dxfInfo.hash} / node ${nodeInfo.dxfHash}），已按长度与实体数对照`);
        const svgRatio = svgInfo.len / nodeInfo.svgBytes;
        check('compare-svg', Math.abs(svgRatio - 1) <= 0.02, `SVG 长度比 ${svgRatio.toFixed(4)}（浏览器 ${svgInfo.len} / node ${nodeInfo.svgBytes}）`);
        if (svgInfo.hash === nodeInfo.svgHash) check('compare-svg-hash', true, 'SVG 与 node 端逐字节一致');
        else warn('compare-svg-hash', `SVG 与 node 端非逐字节一致（浏览器 ${svgInfo.hash} / node ${nodeInfo.svgHash}），已按长度对照`);
      } catch (e) {
        check('node-compare', false, `node 端对照异常: ${e.message}`);
      }
    }

    // 6) 点击「出图」→ 截图 + 面板内容
    const beforeOpen = JSON.parse(await evaluate(cdp, `JSON.stringify({
      panelHidden: document.getElementById('sheetPanel').classList.contains('hidden'),
      previewEmpty: (document.getElementById('sheetPreview').innerText || '').trim().length === 0,
    })`));
    check('panel-closed-initially', beforeOpen.panelHidden, '初始 #sheetPanel 未隐藏');
    check('preview-empty-initially', beforeOpen.previewEmpty, '初始预览非空（应在打开时才现算）');
    const clicked = await click('#toggleSheet');
    check('toggle-click', clicked, '点击 #toggleSheet 失败');
    await waitUntil(cdp, `!document.getElementById('sheetPanel').classList.contains('hidden')`, { timeoutMs: 60000, label: 'sheetPanel 打开' });
    await waitUntil(cdp, `!!document.querySelector('#sheetPreview svg')`, { timeoutMs: 60000, label: '#sheetPreview SVG 渲染' });
    await sleep(400);
    const panel = JSON.parse(await evaluate(cdp, `(() => {
      const p = document.getElementById('sheetPanel');
      const prev = document.getElementById('sheetPreview');
      const side = document.getElementById('sheetSide');
      const cfg = document.getElementById('sheetConfig');
      const papers = prev.querySelectorAll('figure.paper');
      return JSON.stringify({
        visible: !p.classList.contains('hidden'),
        bodySheetOpen: document.body.classList.contains('sheet-open'),
        config: (cfg.innerText || '').trim(),
        papers: papers.length,
        paperHeads: [...papers].map((f) => (f.querySelector('.paper-head') || {}).innerText || '').join(' | '),
        svgCount: prev.querySelectorAll('svg').length,
        svgChars: [...prev.querySelectorAll('svg')].reduce((a, s) => a + (s.outerHTML || '').length, 0),
        side: (side.innerText || ''),
        actions: [...document.querySelectorAll('#sheetPanel [data-dl]')].map((b) => b.dataset.dl + ':' + b.innerText.trim()),
        toggleActive: document.getElementById('toggleSheet').classList.contains('active'),
        bodyOverflow: getComputedStyle(document.body).overflow,
        panelZ: Number(getComputedStyle(p).zIndex) || 0,
        infoCardZ: Number(getComputedStyle(document.getElementById('infoCard')).zIndex) || 0,
      });
    })()`));
    result.panel = { config: panel.config, papers: panel.papers, actions: panel.actions, sideChars: panel.side.length };
    check('panel-open', panel.visible && panel.bodySheetOpen, `panel visible=${panel.visible} body.sheet-open=${panel.bodySheetOpen}`);
    check('panel-toggle-active', panel.toggleActive, '#toggleSheet 未加 active');
    check('panel-no-scroll-through', panel.bodyOverflow === 'hidden', `浮层打开时 body overflow=${panel.bodyOverflow}（应 hidden，防滚动穿透）`);
    check('panel-zindex', panel.panelZ > panel.infoCardZ, `浮层 z-index=${panel.panelZ} 未高于 3D 信息卡 z-index=${panel.infoCardZ}`);
    check('panel-config', panel.config.length > 5, `#sheetConfig 为空: "${panel.config}"`);
    if (panel.papers === 1) warn('panel-papers', '预览为整卷 1 张（cad.js 未按 opts.sheet 分页，sheet.js 回退整卷模式，允许）');
    else if (drawingInfo.sheets && panel.papers === drawingInfo.sheets.length) check('panel-papers', true, `预览 = ${panel.papers} 张图页`);
    else check('panel-papers', false, `预览图页数=${panel.papers} != drawing.sheets=${drawingInfo.sheets && drawingInfo.sheets.length}`);
    check('panel-svg', panel.svgCount >= 1 && panel.svgChars > 8000, `预览 SVG 数=${panel.svgCount}, 字符数=${panel.svgChars}`);
    const headsOk = panel.paperHeads.includes('平面布置图') && panel.paperHeads.includes('机电点位图') && panel.paperHeads.includes('工程量与估价表');
    if (headsOk) check('panel-heads', true, '三张图页标题齐全');
    else warn('panel-heads', `图页标题=${panel.paperHeads}（整卷预览模式下无分页标题）`);
    for (const label of ['估算造价', '单方造价', '每椅造价', '总工日', '工期']) {
      check(`panel-side-${label}`, panel.side.includes(label), `侧栏缺「${label}」`);
    }
    for (const g of ['硬装工程', '机电与暖通', '家具与设备', '设计与管理', '税金']) {
      check(`panel-group-${g}`, panel.side.includes(g), `侧栏缺分组「${g}」`);
    }
    for (const a of ['dxf:DXF', 'svg:SVG', 'csv:报价 CSV', 'print:打印', 'close:关闭']) {
      const [k, v] = a.split(':');
      check(`panel-action-${k}`, panel.actions.some((x) => x.startsWith(k + ':') && x.includes(v)), `动作按钮 ${a} 缺失: ${panel.actions.join(',')}`);
    }
    await shot('01-open');

    // 7) 三个下载按钮
    if (ARGS.downloads) {
      let downloadBehavior = 'Page';
      try {
        await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
      } catch {
        try {
          await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
          downloadBehavior = 'Browser';
        } catch (e) {
          downloadBehavior = 'none';
          check('download-behavior', false, `无法设置下载目录: ${e.message}`);
        }
      }
      result.numbers.downloadBehavior = downloadBehavior;
      // 期望文件名：从浏览器 quote.config 生成（与 sheet.js fileNames 同口径）
      const expected = {};
      const qcfg = (browserQuote && browserQuote.config) || {};
      const typeName = qcfg.typeName || state.type;
      const platform = qcfg.platform || state.platform;
      const styleName = qcfg.styleName || state.style;
      expected.dxf = `平面图_${typeName}_${platform}_${styleName}.dxf`;
      expected.svg = `平面图_${typeName}_${platform}_${styleName}.svg`;
      expected.csv = `估价单_${typeName}_${platform}.csv`;
      result.numbers.expectedDownloads = expected;
      for (const kind of ['dxf', 'svg', 'csv']) {
        const btn = await click(`#sheetPanel [data-dl="${kind}"]`);
        check(`download-click-${kind}`, btn, `点击下载按钮 ${kind} 失败`);
        const file = await waitDownload(expected[kind], 30000);
        if (!file) {
          const existing = listDownloads();
          check(`download-file-${kind}`, false, `未落盘 ${expected[kind]}（目录中: ${existing.join(',')}）`);
          continue;
        }
        const buf = fs.readFileSync(file);
        const st = fs.statSync(file);
        const txt = buf.toString('utf8');
        const okName = path.basename(file) === expected[kind];
        check(`download-file-${kind}`, okName && st.size > 0, `文件名 ${path.basename(file)} / ${st.size}B`);
        result.downloads.push({ kind, file: rel(file), bytes: st.size, expectedName: expected[kind], nameOk: okName });
        if (kind === 'dxf') {
          const headOk = /SECTION/.test(txt.slice(0, 200));
          const tailOk = /0\r?\nEOF\r?\n?$/.test(txt.trimEnd() + '\n') || /0\r?\nEOF/.test(txt.slice(-40));
          check('download-dxf-content', headOk && tailOk, `DXF 头=${JSON.stringify(txt.slice(0, 20))} 尾=${JSON.stringify(txt.slice(-12))}`);
          check('download-dxf-size', st.size > 20000, `DXF ${st.size}B <= 20KB`);
          // 落盘 UTF-8 bytes（中文字符 3 字节）→ 字符串后应与 window.demo.dxf() 完全一致
          check('download-dxf-hash', hashStr(txt) === dxfInfo.hash, `下载 DXF 哈希 ${hashStr(txt)} != window.demo.dxf() ${dxfInfo.hash}`);
        } else if (kind === 'svg') {
          check('download-svg-content', /<svg[\s>]/.test(txt) && /<\/svg>\s*$/.test(txt.trimEnd()), 'SVG 内容缺 <svg> 包裹');
          check('download-svg-size', st.size > 8000, `SVG ${st.size}B <= 8KB`);
          check('download-svg-roomname', txt.includes('平面布置图'), 'SVG 缺图页标题「平面布置图」');
          check('download-svg-hash', hashStr(txt) === svgInfo.hash, `下载 SVG 哈希 ${hashStr(txt)} != window.demo.svg() ${svgInfo.hash}`);
        } else {
          check('download-csv-bom', buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF, `CSV 首字节=${[...buf.slice(0, 3)].map((b) => b.toString(16)).join(' ')}（应 EF BB BF）`);
          check('download-csv-content', txt.includes('总计') || txt.includes('合计'), 'CSV 缺合计/总计');
        }
      }
    }

    // 8) 切换平台 / 类型 / 风格（浮层保持打开、数字刷新），各截图
    const prevTotals = { current: result.numbers.browser.quoteTotal };
    const switchAndShot = async (shotName, clickSel, expect) => {
      const ok = await click(clickSel);
      check(`switch-${shotName}-click`, ok, `点击 ${clickSel} 失败`);
      await sleep(300);
      await waitUntil(cdp, `window.__busy !== true && window.__lastError === null`, { timeoutMs: 120000, label: `${shotName} apply 完成` });
      await waitUntil(cdp, `!!(window.demo.quote() && window.demo.quote().config) && window.demo.quote().config.platform === ${JSON.stringify(expect.platform)} && window.demo.quote().config.typeName === ${JSON.stringify(expect.typeName)} && window.demo.quote().config.styleName === ${JSON.stringify(expect.styleName)}`,
        { timeoutMs: 120000, label: `${shotName} quote 刷新` });
      await waitUntil(cdp, `!!document.querySelector('#sheetPreview svg')`, { timeoutMs: 120000, label: `${shotName} 预览刷新` });
      await sleep(300);
      const snap = JSON.parse(await evaluate(cdp, `(() => {
        const side = document.getElementById('sheetSide');
        const cfg = document.getElementById('sheetConfig');
        const st = window.demo.state;
        return JSON.stringify({
          state: st,
          config: (cfg.innerText || '').trim(),
          side: (side.innerText || '').slice(0, 400),
          total: window.demo.quote() && window.demo.quote().totals && window.demo.quote().totals.total,
          panelHidden: document.getElementById('sheetPanel').classList.contains('hidden'),
          svgCount: document.querySelectorAll('#sheetPreview svg').length,
        });
      })()`));
      result.numbers[`after_${shotName}`] = { total: snap.total, config: snap.config, state: snap.state };
      check(`switch-${shotName}-panel-open`, !snap.panelHidden, `${shotName} 切换后浮层被关闭`);
      check(`switch-${shotName}-config`, snap.config.includes(expect.typeName) && snap.config.includes(expect.styleName), `${shotName} 配置摘要未刷新: ${snap.config}`);
      check(`switch-${shotName}-total-changed`, snap.total !== prevTotals.current, `${shotName} 切换后总价未变 (${snap.total})`);
      check(`switch-${shotName}-svg`, snap.svgCount >= 1, `${shotName} 切换后预览 SVG 数=${snap.svgCount}`);
      prevTotals.current = snap.total;
      await shot(shotName);
      return snap;
    };
    // 平台 M → L（社区家庭店在两平台都存在）
    await switchAndShot('02-platform-L', '#platformSeg [data-p="L"]', { platform: 'L', typeName: '社区家庭店', styleName: '洁净蓝白' });
    // 类型：L 平台上做「美学体验店」
    await switchAndShot('03-type-aesthetic', '#typeList [data-type="aesthetic"]', { platform: 'L', typeName: '美学体验店', styleName: '疗愈木' });
    // 风格：极简黑白（L 平台 1:100，用于可读性回归）
    await switchAndShot('04-style-mono', '#styleList [data-style="mono"]', { platform: 'L', typeName: '美学体验店', styleName: '极简黑白' });

    // 6d) 预览分页数量 + L 1:100 plan/mep 可读性取数 + 分页截图
    const pageStats = JSON.parse(await evaluate(cdp, `(() => {
      const d = window.demo.drawing() || { sheets: [] };
      const figs = [...document.querySelectorAll('#sheetPages figure.paper')].map((f) => {
        const svg = f.querySelector('svg');
        const texts = svg ? [...svg.querySelectorAll('text')] : [];
        const circles = svg ? [...svg.querySelectorAll('circle')] : [];
        const fs = texts.map((t) => parseFloat(t.getAttribute('font-size') || '0')).filter((v) => v > 0).sort((a, b) => a - b);
        const rs = circles.map((c) => parseFloat(c.getAttribute('r') || '0')).filter((v) => v > 0).sort((a, b) => a - b);
        return {
          id: f.dataset.sheet,
          head: (f.querySelector('.paper-head') || {}).innerText || '',
          svgChars: svg ? (svg.outerHTML || '').length : 0,
          texts: texts.length,
          fontMin: fs.length ? fs[0] : null,
          fontMedian: fs.length ? fs[Math.floor(fs.length / 2)] : null,
          circles: circles.length,
          rMin: rs.length ? rs[0] : null,
          rMax: rs.length ? rs[rs.length - 1] : null,
        };
      });
      return JSON.stringify({ sheets: d.sheets.map((s) => ({ id: s.id, name: s.name, no: s.no })), figures: figs, navAnchors: [...document.querySelectorAll('#sheetNav .preview-anchor')].map((b) => b.dataset.page) });
    })()`));
    result.numbers.previewPages = pageStats;
    check('preview-page-count', pageStats.figures.length === pageStats.sheets.length,
      `预览图页数 ${pageStats.figures.length} != drawing.sheets ${pageStats.sheets.length}（${pageStats.sheets.map((s) => s.id).join(',')}）`);
    check('preview-nav-count', pageStats.navAnchors.length === pageStats.sheets.length,
      `预览锚点数 ${pageStats.navAnchors.length} != drawing.sheets ${pageStats.sheets.length}`);
    const planFig = pageStats.figures.find((f) => f.id === 'plan') || {};
    const mepFig = pageStats.figures.find((f) => f.id === 'mep') || {};
    check('preview-plan-content', planFig.texts > 50 && planFig.svgChars > 8000, `平面图页 texts=${planFig.texts} svgChars=${planFig.svgChars}`);
    check('preview-mep-symbols', mepFig.circles >= 10 && mepFig.rMin > 0, `机电点位图页 circles=${mepFig.circles} rMin=${mepFig.rMin} rMax=${mepFig.rMax}`);
    // L 1:100 比例归一：mep 符号半径应明显大于 1:50 配置（cad.js 冻结版 L r=360，S/M r=180）
    check('preview-mep-symbol-scale', mepFig.rMin >= 300, `L(1:100) 机电符号 rMin=${mepFig.rMin}，应 ≥300（1:50 时约 180）`);
    check('preview-plan-font', planFig.fontMin >= 300, `L(1:100) 平面图最小字高=${planFig.fontMin}（模型 mm，比例归一后应 ≥300，旧版 1:100 约 168）`);
    await click('#sheetNav .preview-anchor[data-page="mep"]');
    await sleep(900);
    await shot('06-mep-L');
    await click('#sheetNav .preview-anchor[data-page="plan"]');
    await sleep(900);
    await shot('07-plan-L');

    // 9) ESC 关闭
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await waitUntil(cdp, `document.getElementById('sheetPanel').classList.contains('hidden')`, { timeoutMs: 15000, label: 'ESC 关闭浮层' });
    const closed = JSON.parse(await evaluate(cdp, `JSON.stringify({ hidden: document.getElementById('sheetPanel').classList.contains('hidden'), bodyOpen: document.body.classList.contains('sheet-open') })`));
    check('esc-close', closed.hidden && !closed.bodyOpen, `ESC 后 hidden=${closed.hidden} body.sheet-open=${closed.bodyOpen}`);
    await shot('05-closed');

    // 10) 打印路径（window.open 打桩，headless 下不弹真窗口）
    await click('#toggleSheet');
    await waitUntil(cdp, `!document.getElementById('sheetPanel').classList.contains('hidden')`, { timeoutMs: 30000, label: '再次打开浮层' });
    await sleep(200);
    const printResult = JSON.parse(await evaluate(cdp, `(async () => {
      const stub = { opened: 0, written: '', printed: 0, focus: 0 };
      const orig = window.open;
      window.open = function () {
        stub.opened++;
        return {
          document: { open() {}, write(s) { stub.written += String(s); }, close() {} },
          addEventListener() {},
          focus() { stub.focus++; },
          print() { stub.printed++; },
        };
      };
      window.__printStub = stub;
      try {
        const r = window.demo.print();
        await new Promise((resolve) => setTimeout(resolve, 600));
        const html = (r && r.html) || '';
        return JSON.stringify({
          opened: stub.opened, printed: stub.printed, focus: stub.focus,
          writtenChars: stub.written.length, htmlChars: html.length,
          hasSvg: /<svg[\\s>]/.test(stub.written || html),
          hasDoctype: /<!doctype html>/i.test(html),
          hasPrintCss: /@page/.test(html),
          returnedOpened: !!(r && r.opened),
        });
      } finally {
        window.open = orig;
        delete window.__printStub;
      }
    })()`));
    result.numbers.print = printResult;
    check('print-html', printResult.hasSvg && printResult.hasDoctype, `打印 HTML: doctype=${printResult.hasDoctype} svg=${printResult.hasSvg} chars=${printResult.htmlChars}`);
    check('print-css', printResult.hasPrintCss, '打印 HTML 缺 @page 打印样式');
    check('print-called', printResult.printed >= 1, `window.print() 调用次数=${printResult.printed}`);
    check('print-return', printResult.returnedOpened === true, `print() 返回 opened=${printResult.returnedOpened}`);
    check('no-sheetError-after-print', !(await evaluate(cdp, 'window.__sheetError || null')), `window.__sheetError=${await evaluate(cdp, 'window.__sheetError || null').catch(() => '?')}`);
    // 关闭浮层
    await click('#sheetPanel [data-dl="close"]');
    await waitUntil(cdp, `document.getElementById('sheetPanel').classList.contains('hidden')`, { timeoutMs: 15000, label: '关闭按钮关闭浮层' });
    check('close-button', true, '关闭按钮可关浮层');

    // 11) 全程 console error
    result.consoleErrors = consoleErrors;
    check('console-clean', consoleErrors.length === 0, `console/异常错误 ${consoleErrors.length} 条: ${consoleErrors.slice(0, 5).map((e) => e.text).join(' | ')}`);
  } finally {
    try { await cleanup(); } catch { /* ignore */ }
  }
  result.ok = failureTotal === 0;
  finish(result.ok ? 0 : 1);
}

function finish(code) {
  result.elapsedMs = Date.now() - T0;
  result.finishedAt = new Date().toISOString();
  result.failureTotal = failureTotal;
  const passN = Object.values(result.checks).reduce((a, c) => a + (c.pass || 0), 0);
  const failN = Object.values(result.checks).reduce((a, c) => a + (c.fail || 0), 0);
  result.summary = { assertionsPass: passN, assertionsFail: failN, warnings: result.warnings.length, consoleErrors: result.consoleErrors.length };
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'shot-sheet.result.json'), JSON.stringify(result, null, 2), 'utf8');
    result.resultFile = rel(path.join(OUT, 'shot-sheet.result.json'));
  } catch (e) { console.error('[shot] 写结果失败:', e.message); }
  for (const [k, c] of Object.entries(result.checks)) {
    if (c.fail > 0) for (const f of result.failures.filter((x) => x.startsWith(`[${k}]`)).slice(0, 3)) log('FAIL', f);
  }
  if (result.ok) log('全部 PASS');
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = code;
}

main().catch((e) => {
  console.error('[shot] 未捕获异常:', e && (e.stack || e.message));
  result.ok = false;
  result.uncaught = String(e && (e.stack || e.message));
  finish(2);
});
