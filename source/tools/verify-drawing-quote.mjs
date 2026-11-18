#!/usr/bin/env node
// 出图 / 算量 / 估价 —— node 全组合验收（契约 §6.1）
//
// 用法：
//   node dental/tools/verify-drawing-quote.mjs [选项]
//     --js-dir <dir>     模块目录（默认 dental/server/public/demo/js）
//     --out-dir <dir>    结果 / 样例 DXF·SVG 输出目录（默认 _lead_scratch/qa/exports）
//     --date <YYYY-MM-DD> 固定日期（保证可复现），默认今天
//     --limit <n>        只跑前 n 个组合（调试用；0=全部）
//     --no-export        不写样例 DXF/SVG
//     --wait <seconds>   等待 cad.js / quote.js / price-book.js 出现（默认 0）
//     --quiet            不打印进度
//
// 退出码：0 = 全部 PASS；1 = 有 FAIL；2 = 模块未就绪 / 导入失败
//
// stdout 只输出一个 JSON 结果对象；进度日志走 stderr。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = {
    jsDir: path.join(ROOT, 'dental/server/public/demo/js'),
    outDir: path.join(ROOT, '_lead_scratch/qa/exports'),
    date: localDate(),
    limit: 0,
    export: true,
    wait: 0,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--js-dir') o.jsDir = path.resolve(next());
    else if (a === '--out-dir') o.outDir = path.resolve(next());
    else if (a === '--date') o.date = next();
    else if (a === '--limit') o.limit = Number(next());
    else if (a === '--full') o.limit = 0;
    else if (a === '--no-export') o.export = false;
    else if (a === '--wait') o.wait = Number(next());
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`[verify] 未知参数: ${a}`); process.exit(2); }
  }
  return o;
}
function printHelp() {
  console.log(`node dental/tools/verify-drawing-quote.mjs [--js-dir dir] [--out-dir dir] [--date YYYY-MM-DD] [--limit n] [--no-export] [--wait seconds] [--quiet]`);
}
function localDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { if (!ARGS.quiet) console.error('[verify]', ...a); };
const ARGS = parseArgs(process.argv.slice(2));

// ── 结果收集 ────────────────────────────────────────────────────────────────
const result = {
  ok: false,
  tool: 'verify-drawing-quote',
  version: 1,
  startedAt: new Date().toISOString(),
  date: ARGS.date,
  jsDir: path.relative(ROOT, ARGS.jsDir),
  combos: { total: 0, checked: 0, passed: 0, failed: 0, byPlatform: {} },
  checks: {},          // 类别 → { pass, fail, warnings, notes }
  numbers: {},         // 关键数字
  typical: [],
  monotonic: {},
  modules: {},
  failures: [],
  warnings: [],
  elapsedMs: 0,
};
const failCounts = new Map();
let failureTotal = 0;
const MAX_FAILURES = 300;

function check(cond, category, msg) {
  const c = result.checks[category] || (result.checks[category] = { pass: 0, fail: 0 });
  if (cond) { c.pass++; return true; }
  c.fail++;
  failureTotal++;
  failCounts.set(category, (failCounts.get(category) || 0) + 1);
  if (result.failures.length < MAX_FAILURES) result.failures.push(`[${category}] ${msg}`);
  return false;
}
function warn(category, msg) {
  const c = result.checks[category] || (result.checks[category] = { pass: 0, fail: 0 });
  c.warnings = (c.warnings || 0) + 1;
  if (result.warnings.length < MAX_FAILURES) result.warnings.push(`[${category}] ${msg}`);
}
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const close = (a, b, tol) => Math.abs(a - b) <= tol;
const relClose = (a, b, rel, absMin = 1) => close(a, b, Math.max(absMin, Math.abs(b) * rel));

// 递归扫描 NaN / Infinity / 字符串里的 NaN
function scanNonFinite(obj, label, out, depth = 0, seen = new Set()) {
  if (depth > 24 || out.length > 8) return out;
  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) out.push(`${label} = ${obj}`);
    return out;
  }
  if (typeof obj === 'string') {
    if (/NaN|Infinity/.test(obj)) out.push(`${label} 字符串含 NaN/Infinity: ${obj.slice(0, 80)}`);
    return out;
  }
  if (!obj || typeof obj !== 'object') return out;
  if (seen.has(obj)) return out;
  seen.add(obj);
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length && out.length <= 8; i++) scanNonFinite(obj[i], `${label}[${i}]`, out, depth + 1, seen);
  } else {
    for (const [k, v] of Object.entries(obj)) {
      if (out.length > 8) break;
      scanNonFinite(v, `${label}.${k}`, out, depth + 1, seen);
    }
  }
  return out;
}

// ── 元数据（与浏览器 assets.js 同源：inventory + extra inventory）────────────
function loadMeta() {
  const map = new Map();
  const files = [
    'dental/server/public/inventory.json',
    'dental/server/public/demo/extra/inventory-extra.json',
  ];
  const missingFiles = [];
  for (const f of files) {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) { missingFiles.push(f); continue; }
    try {
      const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
      for (const it of data.items || []) map.set(it.id, { zh: it.zh, cat: it.category });
    } catch (e) { missingFiles.push(`${f} (${e.message})`); }
  }
  return {
    map,
    missingFiles,
    nameOf: (id) => (map.get(id) && map.get(id).zh) || id,
    categoryOf: (id) => (map.get(id) && map.get(id).cat) || '',
  };
}

// ── 组合枚举 ────────────────────────────────────────────────────────────────
function moduleSubsets(moduleIds, maxSize) {
  const out = [];
  const rec = (start, cur) => {
    if (cur.length > maxSize) return;
    out.push([...cur]);
    for (let i = start; i < moduleIds.length; i++) { cur.push(moduleIds[i]); rec(i + 1, cur); cur.pop(); }
  };
  rec(0, []);
  return out;
}

function comboKey(state, plan) {
  return `${state.platform}|${state.type}|${state.style}|${[...(state.modules || [])].sort().join('+') || '-'}`;
}

// ── DXF 结构解析（单遍，不落地全部 token）──────────────────────────────────
function parseDxf(dxf) {
  const info = {
    sections: [], endsecs: 0, eof: false, layers: [], usedLayers: new Set(),
    styles: [], tables: new Set(), entityCount: 0, has: {}, endsWithEof: false,
    header: {}, styleCN: false, textCount: 0, nonAscii: false,
  };
  const trimmed = dxf.trimEnd();
  info.endsWithEof = /(?:^|\r?\n)0\r?\nEOF$/.test(trimmed);
  const m = /(?:^|\r?\n)\$ACADVER\r?\n\s*1\r?\n([A-Z0-9]+)/.exec(dxf);
  info.header.ACADVER = m ? m[1] : null;
  const ins = /(?:^|\r?\n)\$INSUNITS\r?\n\s*70\r?\n\s*(-?\d+)/.exec(dxf);
  info.header.INSUNITS = ins ? Number(ins[1]) : null;
  const meas = /(?:^|\r?\n)\$MEASUREMENT\r?\n\s*70\r?\n\s*(-?\d+)/.exec(dxf);
  info.header.MEASUREMENT = meas ? Number(meas[1]) : null;
  info.header.hasEXTMIN = /(?:^|\r?\n)\$EXTMIN\r?\n/.test(dxf);
  info.header.hasEXTMAX = /(?:^|\r?\n)\$EXTMAX\r?\n/.test(dxf);
  info.nonAscii = /[^\x00-\x7F]/.test(dxf);
  if (/NaN|Infinity/.test(dxf)) info.hasBadNumber = true;

  const re = /(?:^|\r?\n)(\d{1,4})\r?\n([^\r\n]*)/g;
  let mt;
  let section = null;
  let pendingSection = false;
  let pendingTable = null;
  let currentTable = null;
  let pendingEntity = false;
  let entityLayerPending = false;
  let inEntities = false;
  while ((mt = re.exec(dxf)) !== null) {
    const code = Number(mt[1]);
    const val = mt[2];
    if (code === 0) {
      const v = val.trim();
      pendingEntity = true;
      entityLayerPending = false;
      if (v === 'SECTION') { pendingSection = true; info.has.SECTION = true; }
      else if (v === 'ENDSEC') {
        info.endsecs++;
        if (section) info.sections.push(section);
        section = null; inEntities = false; currentTable = null; pendingTable = null;
      } else if (v === 'EOF') info.eof = true;
      else if (v === 'TABLE') pendingTable = true;
      else if (v === 'ENDTAB') { currentTable = null; pendingTable = null; }
      else if (v === 'LAYER' && currentTable === 'layer') { pendingEntity = 'layer'; }
      else if (v === 'STYLE' && currentTable === 'style') { pendingEntity = 'style'; }
      else if (inEntities) {
        info.entityCount++;
        entityLayerPending = true;
      }
    } else if (code === 2) {
      if (pendingSection) { section = val.trim(); pendingSection = false; inEntities = section === 'ENTITIES'; }
      else if (pendingTable) { pendingTable = false; currentTable = val.trim().toLowerCase(); info.tables.add(currentTable); if (currentTable === 'layer') info.has.LAYER = true; }
      else if (pendingEntity === 'layer') { info.layers.push(val.trim()); pendingEntity = false; }
      else if (pendingEntity === 'style') { info.styles.push(val.trim()); pendingEntity = false; }
      else if (inEntities && entityLayerPending) { /* code 2 不是图层 */ }
    } else if (code === 8 && inEntities && entityLayerPending) {
      info.usedLayers.add(val.trim());
    } else if (code === 1 && inEntities) {
      info.textCount++;
    }
  }
  info.styleCN = info.styles.includes('CN');
  return info;
}

// ── 单组合校验 ──────────────────────────────────────────────────────────────
const REQUIRED_GROUP_ORDER = ['硬装工程', '机电与暖通', '家具与设备', '设计与管理', '税金'];
const ALLOWED_ENTITY_TYPES = new Set(['line', 'poly', 'circle', 'text', 'solid']);

function checkQuote(state, plan, q, q2, meta, ctx) {
  const key = ctx.key;
  const finiteIssues = scanNonFinite(q, 'quote', []);
  check(finiteIssues.length === 0, 'quote:finite', `${key}: 非有限值 ${finiteIssues.join('; ')}`);

  check(q && q.kind === 'clinic-quote', 'quote:shape', `${key}: kind=${q && q.kind}`);
  check(q && q.version === 1, 'quote:shape', `${key}: version=${q && q.version}`);
  check(!!q.generatedAt, 'quote:shape', `${key}: generatedAt 为空`);
  if (ARGS.date && q.generatedAt && !String(q.generatedAt).startsWith(ARGS.date)) {
    check(false, 'quote:repro', `${key}: generatedAt=${q.generatedAt} 未用 opts.date=${ARGS.date}`);
  }

  // config 对齐 plan
  const cfg = q.config || {};
  check(cfg.platform === plan.platform, 'quote:config', `${key}: config.platform=${cfg.platform} != ${plan.platform}`);
  if (ctx.expectTypeName) check(cfg.typeName === ctx.expectTypeName, 'quote:config', `${key}: config.typeName=${cfg.typeName} != ${ctx.expectTypeName}`);
  if (ctx.expectStyleName) check(cfg.styleName === ctx.expectStyleName, 'quote:config', `${key}: config.styleName=${cfg.styleName} != ${ctx.expectStyleName}`);
  if (ctx.expectPlatformLabel) check(cfg.platformLabel === ctx.expectPlatformLabel, 'quote:config', `${key}: config.platformLabel=${cfg.platformLabel} != ${ctx.expectPlatformLabel}`);
  check(cfg.area === plan.stats.area, 'quote:config', `${key}: config.area=${cfg.area} != ${plan.stats.area}`);
  check(cfg.chairs === plan.stats.chairs, 'quote:config', `${key}: config.chairs=${cfg.chairs} != ${plan.stats.chairs}`);
  check(Number.isFinite(cfg.roomCount) && cfg.roomCount === plan.stats.roomCount, 'quote:config', `${key}: config.roomCount=${cfg.roomCount} != ${plan.stats.roomCount}`);
  if (Array.isArray(cfg.modules)) {
    const a = [...cfg.modules].sort().join('+');
    const b = [...(plan.modules || [])].sort().join('+');
    check(a === b, 'quote:config', `${key}: config.modules=${JSON.stringify(cfg.modules)} != plan.modules=${JSON.stringify(plan.modules)}`);
  } else warn('quote:config', `${key}: config.modules 不是数组`);

  // lines
  const lines = Array.isArray(q.lines) ? q.lines : [];
  check(lines.length > 0, 'quote:lines', `${key}: lines 为空`);
  let lineAmountSum = 0;
  let lineHoursSum = 0;
  const lineNos = new Set();
  for (const ln of lines) {
    const tag = `${key}: line#${ln && ln.no}`;
    check(ln && Number.isFinite(ln.amount), 'quote:lines', `${tag} amount 非有限`);
    check(ln && Number.isFinite(ln.hours), 'quote:lines', `${tag} hours 非有限`);
    check(ln && Number.isFinite(ln.qty), 'quote:lines', `${tag} qty 非有限`);
    check(ln && Number.isFinite(ln.price), 'quote:lines', `${tag} price 非有限`);
    check(ln && typeof ln.name === 'string' && ln.name.length > 0, 'quote:lines', `${tag} name 为空`);
    check(ln && typeof ln.group === 'string' && ln.group.length > 0, 'quote:lines', `${tag} group 为空`);
    check(ln && typeof ln.unit === 'string' && ln.unit.length > 0, 'quote:lines', `${tag} unit 为空`);
    if (ln && Number.isFinite(ln.qty) && Number.isFinite(ln.price) && Number.isFinite(ln.amount)) {
      check(relClose(ln.amount, ln.qty * ln.price, 0.002, 2), 'quote:lines', `${tag} amount=${ln.amount} != qty*price=${(ln.qty * ln.price).toFixed(2)}`);
    }
    if (ln && Number.isFinite(ln.amount)) lineAmountSum += ln.amount;
    if (ln && Number.isFinite(ln.hours)) lineHoursSum += ln.hours;
    if (ln && ln.no !== undefined) lineNos.add(ln.no);
  }
  check(lineNos.size === lines.length, 'quote:lines', `${key}: lines.no 有重复 (${lineNos.size}/${lines.length})`);

  // groups
  const groups = Array.isArray(q.groups) ? q.groups : [];
  check(groups.length === 5, 'quote:groups', `${key}: groups.length=${groups.length} != 5`);
  const names = groups.map((g) => g && g.name);
  check(JSON.stringify(names) === JSON.stringify(REQUIRED_GROUP_ORDER), 'quote:groups', `${key}: groups 名称/顺序=${JSON.stringify(names)}`);
  let groupSum = 0;
  let shareSum = 0;
  const taxGroup = groups.find((g) => g && g.name === '税金') || groups.find((g) => g && /税/.test(String(g.id) + String(g.name)));
  let nonTaxSum = 0;
  for (const g of groups) {
    check(g && Number.isFinite(g.amount), 'quote:groups', `${key}: group ${g && g.name} amount 非有限`);
    check(g && Number.isFinite(g.hours), 'quote:groups', `${key}: group ${g && g.name} hours 非有限`);
    if (g && Number.isFinite(g.amount)) { groupSum += g.amount; if (g !== taxGroup) nonTaxSum += g.amount; }
    if (g && Number.isFinite(g.share)) shareSum += g.share;
  }
  check(!!taxGroup, 'quote:groups', `${key}: 未找到税金分组`);
  check(close(shareSum, 1, 1e-3), 'quote:groups', `${key}: Σgroups.share=${shareSum.toFixed(6)} != 1`);

  const t = q.totals || {};
  const subtotal = t.subtotal, tax = t.tax, total = t.total;
  check(finite(subtotal) && finite(tax) && finite(total), 'quote:totals', `${key}: subtotal/tax/total 非有限`);
  check(relClose(groupSum, total, 0.001, 3), 'quote:totals', `${key}: Σgroups.amount=${groupSum} != total=${total}`);
  check(relClose(nonTaxSum, subtotal, 0.001, 3), 'quote:totals', `${key}: Σ非税 groups=${nonTaxSum} != subtotal=${subtotal}`);
  check(relClose(subtotal + tax, total, 0.001, 3), 'quote:totals', `${key}: subtotal+tax=${subtotal + tax} != total=${total}`);
  check(relClose(taxGroup ? taxGroup.amount : NaN, tax, 0.001, 3), 'quote:totals', `${key}: 税金组=${taxGroup && taxGroup.amount} != totals.tax=${tax}`);
  // Σ lines.amount 与 subtotal/total 的对应（税金行是否进 lines 由实现决定，两者都接受）
  const lineVsSub = Math.abs(lineAmountSum - subtotal);
  const lineVsTotal = Math.abs(lineAmountSum - total);
  check(Math.min(lineVsSub, lineVsTotal) <= Math.max(2, Math.abs(total) * 0.001),
    'quote:totals', `${key}: Σlines.amount=${lineAmountSum} 既不等 subtotal=${subtotal} 也不等 total=${total}`);
  const rangePct = Number.isFinite(t.rangePct) ? t.rangePct : 0.08;
  check(finite(t.low) && t.low < total, 'quote:totals', `${key}: low=${t.low} 未 < total=${total}`);
  check(finite(t.high) && total < t.high, 'quote:totals', `${key}: high=${t.high} 未 > total=${total}`);
  if (finite(t.low)) check(relClose(t.low, total * (1 - rangePct), 0.002, 2), 'quote:totals', `${key}: low=${t.low} != total*(1-${rangePct})=${(total * (1 - rangePct)).toFixed(1)}`);
  if (finite(t.high)) check(relClose(t.high, total * (1 + rangePct), 0.002, 2), 'quote:totals', `${key}: high=${t.high} != total*(1+${rangePct})=${(total * (1 + rangePct)).toFixed(1)}`);

  // 单方 / 每椅（恒等式始终校验；区间只校验 UI 可达组合 —— 2026-11-13 Lead 口径）
  const area = plan.stats.area, chairs = plan.stats.chairs;
  check(finite(t.perArea) && relClose(t.perArea, total / area, 0.005, 1), 'quote:unitPrice', `${key}: perArea=${t.perArea} != total/area=${(total / area).toFixed(1)}`);
  check(finite(t.perChair) && relClose(t.perChair, total / chairs, 0.005, 1), 'quote:unitPrice', `${key}: perChair=${t.perChair} != total/chairs=${(total / chairs).toFixed(1)}`);
  if (ctx.reachable) {
    check(finite(t.perArea) && t.perArea >= 3000 && t.perArea <= 15000, 'quote:range', `${key}: perArea=${t.perArea} 超出 [3000,15000] 元/㎡`);
    check(finite(t.perChair) && t.perChair >= 80000 && t.perChair <= 600000, 'quote:range', `${key}: perChair=${t.perChair} 元/椅 超出 [8,60] 万元/椅`);
  }

  // 金额大写
  if (typeof ctx.amountInWords === 'function' && finite(total)) {
    const expect = ctx.amountInWords(total);
    check(typeof t.amountInWords === 'string' && t.amountInWords === expect, 'quote:words', `${key}: amountInWords=${t.amountInWords} != amountInWords(total)=${expect}`);
    check(/^人民币/.test(String(t.amountInWords)), 'quote:words', `${key}: amountInWords 未以「人民币」开头: ${t.amountInWords}`);
    check(Number.isInteger(total) ? /元整$/.test(String(t.amountInWords)) : true, 'quote:words', `${key}: 整数总额金额大写未以「元整」结尾: ${t.amountInWords}`);
  }

  // 工时
  const labor = q.labor || {};
  check(finite(labor.totalHours) && relClose(labor.totalHours, lineHoursSum, 1e-6, 1e-6), 'quote:labor', `${key}: labor.totalHours=${labor.totalHours} != Σlines.hours=${lineHoursSum}`);
  check(finite(labor.totalHours) && labor.totalHours > 0, 'quote:labor', `${key}: labor.totalHours<=0`);
  check(Number.isInteger(labor.calendarDays) && labor.calendarDays > 0, 'quote:labor', `${key}: calendarDays=${labor.calendarDays} 应为正整数`);
  check(Array.isArray(labor.phases) && labor.phases.length >= 4, 'quote:labor', `${key}: phases.length=${labor.phases && labor.phases.length} < 4`);
  let phaseDays = 0, phaseHours = 0;
  for (const p of labor.phases || []) {
    check(p && finite(p.days) && p.days >= 0, 'quote:labor', `${key}: phase ${p && p.id} days 非有限/负`);
    check(p && finite(p.hours) && p.hours >= 0, 'quote:labor', `${key}: phase ${p && p.id} hours 非有限/负`);
    check(p && finite(p.crew) && p.crew >= 1, 'quote:labor', `${key}: phase ${p && p.id} crew=${p && p.crew} 应 >= 1`);
    check(p && typeof p.name === 'string' && p.name.length > 0, 'quote:labor', `${key}: phase name 为空`);
    if (p) { if (Number.isFinite(p.days)) phaseDays += p.days; if (Number.isFinite(p.hours)) phaseHours += p.hours; }
  }
  check(close(phaseDays, labor.calendarDays, 1e-9), 'quote:labor', `${key}: Σphase.days=${phaseDays} != calendarDays=${labor.calendarDays}`);
  check(phaseHours > 0, 'quote:labor', `${key}: Σphase.hours<=0`);
  check(finite(labor.peakCrew) && labor.peakCrew >= 1, 'quote:labor', `${key}: peakCrew=${labor.peakCrew} 应 >= 1`);
  const trades = Array.isArray(labor.byTrade) ? labor.byTrade : [];
  check(trades.length > 0, 'quote:labor', `${key}: byTrade 为空`);
  let tradeShare = 0;
  for (const tr of trades) {
    check(tr && finite(tr.hours) && tr.hours >= 0, 'quote:labor', `${key}: trade ${tr && tr.id} hours 非有限`);
    check(tr && finite(tr.share), 'quote:labor', `${key}: trade ${tr && tr.id} share 非有限`);
    if (tr && Number.isFinite(tr.share)) tradeShare += tr.share;
  }
  if (trades.length) check(close(tradeShare, 1, 5e-3), 'quote:labor', `${key}: ΣbyTrade.share=${tradeShare.toFixed(6)} != 1`);

  // metrics 与 plan 对齐
  const m = q.metrics || {};
  check(m.area === plan.stats.area, 'quote:metrics', `${key}: metrics.area=${m.area} != ${plan.stats.area}`);
  check(m.chairs === plan.stats.chairs, 'quote:metrics', `${key}: metrics.chairs=${m.chairs} != ${plan.stats.chairs}`);
  check(m.roomCount === plan.stats.roomCount, 'quote:metrics', `${key}: metrics.roomCount=${m.roomCount} != ${plan.stats.roomCount}`);
  check(m.itemCount === plan.stats.itemCount, 'quote:metrics', `${key}: metrics.itemCount=${m.itemCount} != ${plan.stats.itemCount}`);
  const pts = m.points || {};
  const pointSum = ['water', 'power', 'gas', 'drain', 'net'].reduce((a, k) => a + (Number.isFinite(pts[k]) ? pts[k] : NaN), 0);
  check(Number.isFinite(pointSum) && m.pointCount === pointSum, 'quote:metrics', `${key}: metrics.pointCount=${m.pointCount} != Σpoints=${pointSum}`);
  check(Number.isFinite(m.pointCount) && m.pointCount === plan.hardPoints.length, 'quote:metrics', `${key}: pointCount=${m.pointCount} != plan.hardPoints=${plan.hardPoints.length}`);
  check(finite(m.usableArea) && m.usableArea > 0 && m.usableArea <= plan.stats.area, 'quote:metrics', `${key}: usableArea=${m.usableArea} 异常`);
  for (const k of ['perimeter', 'partitionLen', 'ceilingArea', 'hardArea', 'mepArea', 'itemArea', 'designArea']) {
    if (!(k in m)) warn('quote:metrics', `${key}: metrics.${k} 缺失`);
  }
  check(typeof q.priceBookVersion === 'string' && q.priceBookVersion.length > 0, 'quote:metrics', `${key}: priceBookVersion 为空`);

  // 可复现
  check(JSON.stringify(q) === JSON.stringify(q2), 'quote:repro', `${key}: 两次 buildQuote JSON 不一致`);
  return { lineAmountSum, lineHoursSum, lineCount: lines.length };
}

function checkDrawingAndFormats(state, plan, q, drawing, dxf, svg, stats, dxfInfo, ctx) {
  const key = ctx.key;
  const finiteIssues = scanNonFinite(drawing, 'drawing', []);
  check(finiteIssues.length === 0, 'drawing:finite', `${key}: 非有限值 ${finiteIssues.join('; ')}`);
  check(drawing && drawing.kind === 'cad-drawing', 'drawing:shape', `${key}: kind=${drawing && drawing.kind}`);
  check(drawing && drawing.units === 'mm', 'drawing:shape', `${key}: units=${drawing && drawing.units}`);
  check(drawing && drawing.version === 1, 'drawing:shape', `${key}: version=${drawing && drawing.version}`);
  check(!!(stats && typeof stats === 'object'), 'drawing:stats', `${key}: drawingStats 返回空`);
  if (stats && typeof stats === 'object') {
    check(stats.sheets === drawing.sheets.length, 'drawing:stats', `${key}: stats.sheets=${stats.sheets} != ${drawing.sheets.length}`);
  }

  const proj = (drawing && drawing.project) || {};
  check(typeof proj.title === 'string' && proj.title.length > 0, 'drawing:project', `${key}: project.title 为空`);
  check(proj.platform === plan.platform, 'drawing:project', `${key}: project.platform=${proj.platform} != ${plan.platform}`);
  check(proj.area === plan.stats.area, 'drawing:project', `${key}: project.area=${proj.area} != ${plan.stats.area}`);
  check(proj.chairs === plan.stats.chairs, 'drawing:project', `${key}: project.chairs=${proj.chairs} != ${plan.stats.chairs}`);
  check(proj.roomCount === plan.stats.roomCount, 'drawing:project', `${key}: project.roomCount=${proj.roomCount} != ${plan.stats.roomCount}`);
  check(/^\d{4}-\d{2}-\d{2}$/.test(String(proj.date)), 'drawing:project', `${key}: project.date=${proj.date} 格式错误`);
  if (ctx.expectBoq) {
    check(proj.quoteSummary && finite(proj.quoteSummary.total), 'drawing:project', `${key}: project.quoteSummary 缺失（boq 模式下标题栏应带估价/工时）`);
  }

  const sheets = Array.isArray(drawing.sheets) ? drawing.sheets : [];
  const minSheets = ctx.expectBoq ? 3 : 2;
  check(sheets.length >= minSheets, 'drawing:sheets', `${key}: sheets.length=${sheets.length} < ${minSheets}`);
  const planSheetList = sheets.filter((s) => s && s.id === 'plan');
  const mepSheetList = sheets.filter((s) => s && s.id === 'mep');
  const boqSheetList = sheets.filter((s) => s && (s.id === 'boq' || /^boq-\d+$/.test(String(s.id)) || String(s.name || '').startsWith('工程量与估价表')));
  check(planSheetList.length === 1, 'drawing:sheets', `${key}: plan 图页数=${planSheetList.length}（应 1）`);
  check(mepSheetList.length === 1, 'drawing:sheets', `${key}: mep 图页数=${mepSheetList.length}（应 1）`);
  if (ctx.expectBoq) check(boqSheetList.length >= 1, 'drawing:sheets', `${key}: 缺 boq 图页（行数续页可为多页）`);
  const ids = sheets.map((s) => s && s.id);
  check(new Set(ids).size === ids.length, 'drawing:sheets', `${key}: sheet.id 重复 ${JSON.stringify(ids)}`);
  const names = sheets.map((s) => s && s.name);
  if (ctx.expectBoq) check(names.some((n) => String(n).startsWith('工程量与估价表')), 'drawing:sheets', `${key}: 缺「工程量与估价表」页名 ${JSON.stringify(names)}`);
  check(names.includes('平面布置图'), 'drawing:sheets', `${key}: 缺「平面布置图」页名`);
  check(names.includes('机电点位图'), 'drawing:sheets', `${key}: 缺「机电点位图」页名`);
  let entityTotal = 0;
  const layers = new Set();
  for (const s of sheets) {
    const stag = `${key}: sheet ${s && s.id}`;
    check(typeof s.no === 'string' && s.no.length > 0, 'drawing:sheets', `${stag} no 为空`);
    if (!/^ADS-/.test(String(s.no))) warn('drawing:sheets', `${stag} no=${s.no} 不符 ADS- 编号`);
    check(s.paper === 'A2', 'drawing:sheets', `${stag} paper=${s.paper} 应为 A2`);
    check(finite(s.scaleDen) && s.scaleDen > 0, 'drawing:sheets', `${stag} scaleDen=${s.scaleDen} 非法`);
    check(s.frame && [s.frame.x, s.frame.y, s.frame.w, s.frame.h].every(finite) && s.frame.w > 0 && s.frame.h > 0, 'drawing:sheets', `${stag} frame 非法`);
    check(s.inner && [s.inner.x, s.inner.y, s.inner.w, s.inner.h].every(finite) && s.inner.w > 0 && s.inner.h > 0, 'drawing:sheets', `${stag} inner 非法`);
    const ents = Array.isArray(s.entities) ? s.entities : [];
    check(ents.length > 0, 'drawing:sheets', `${stag} entities 为空`);
    entityTotal += ents.length;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      const etag = `${stag} entity#${i}`;
      check(e && ALLOWED_ENTITY_TYPES.has(e.t), 'drawing:entities', `${etag} 未知实体类型 ${e && e.t}`);
      check(e && typeof e.layer === 'string' && e.layer.length > 0, 'drawing:entities', `${etag} layer 为空`);
      if (!e) continue;
      if (typeof e.layer === 'string') layers.add(e.layer);
      if (e.t === 'line') check([e.x1, e.y1, e.x2, e.y2].every(finite), 'drawing:entities', `${etag} line 坐标非有限`);
      else if (e.t === 'circle') check(finite(e.x) && finite(e.y) && finite(e.r) && e.r > 0, 'drawing:entities', `${etag} circle 非法`);
      else if (e.t === 'text') {
        check(typeof e.text === 'string' && e.text.length > 0, 'drawing:entities', `${etag} text 为空`);
        check(finite(e.x) && finite(e.y) && finite(e.h) && e.h > 0, 'drawing:entities', `${etag} text 位置/字高非法`);
      } else if (e.t === 'poly') {
        check(Array.isArray(e.pts) && e.pts.length >= 2 && e.pts.every((p) => Array.isArray(p) && finite(p[0]) && finite(p[1])), 'drawing:entities', `${etag} poly pts 非法`);
      } else if (e.t === 'solid') {
        check(Array.isArray(e.pts) && e.pts.length === 4 && e.pts.every((p) => Array.isArray(p) && finite(p[0]) && finite(p[1])), 'drawing:entities', `${etag} solid pts 必须 4 点且有限`);
      }
    }
  }
  if (stats && typeof stats === 'object') {
    check(stats.entities === entityTotal, 'drawing:stats', `${key}: stats.entities=${stats.entities} != Σentities=${entityTotal}`);
    if (stats.byLayer && typeof stats.byLayer === 'object') {
      const byLayerSum = Object.values(stats.byLayer).reduce((a, b) => a + b, 0);
      check(byLayerSum === entityTotal, 'drawing:stats', `${key}: ΣbyLayer=${byLayerSum} != entities=${entityTotal}`);
    } else warn('drawing:stats', `${key}: drawingStats 无 byLayer`);
    if (finite(stats.layers) && stats.layers !== layers.size) warn('drawing:stats', `${key}: stats.layers=${stats.layers} != 实体图层数=${layers.size}`);
  }
  // DXF
  check(typeof dxf === 'string' && dxf.length > 20000, 'dxf:size', `${key}: DXF ${dxf && dxf.length} bytes <= 20KB`);
  check(dxfInfo.header.ACADVER === 'AC1021', 'dxf:header', `${key}: $ACADVER=${dxfInfo.header.ACADVER} 应为 AC1021`);
  check(dxfInfo.header.INSUNITS === 4, 'dxf:header', `${key}: $INSUNITS=${dxfInfo.header.INSUNITS} 应为 4(mm)`);
  check(dxfInfo.header.MEASUREMENT === 1, 'dxf:header', `${key}: $MEASUREMENT=${dxfInfo.header.MEASUREMENT} 应为 1`);
  check(dxfInfo.header.hasEXTMIN && dxfInfo.header.hasEXTMAX, 'dxf:header', `${key}: 缺 $EXTMIN/$EXTMAX`);
  check(dxfInfo.endsWithEof, 'dxf:structure', `${key}: DXF 未以 "0\\nEOF" 结尾`);
  check(dxfInfo.endsecs === dxfInfo.sections.length && dxfInfo.sections.length >= 4, 'dxf:structure', `${key}: SECTION/ENDSEC 不配对 (sections=${dxfInfo.sections.length}, endsecs=${dxfInfo.endsecs})`);
  for (const s of ['HEADER', 'TABLES', 'BLOCKS', 'ENTITIES']) {
    check(dxfInfo.sections.includes(s), 'dxf:structure', `${key}: 缺少 ${s} section`);
  }
  check(dxfInfo.eof, 'dxf:structure', `${key}: 缺 EOF 标记`);
  check(dxfInfo.tables.has('layer'), 'dxf:structure', `${key}: 缺 LAYER 表`);
  check(dxfInfo.tables.has('ltype'), 'dxf:structure', `${key}: 缺 LTYPE 表`);
  check(dxfInfo.tables.has('style'), 'dxf:structure', `${key}: 缺 STYLE 表`);
  check(dxfInfo.layers.length >= 9, 'dxf:layers', `${key}: 图层数=${dxfInfo.layers.length} < 9 (${dxfInfo.layers.slice(0, 20).join(',')})`);
  check(new Set(dxfInfo.layers).size === dxfInfo.layers.length, 'dxf:layers', `${key}: 图层名重复`);
  check(dxfInfo.layers.every((n) => n && n.trim().length > 0), 'dxf:layers', `${key}: 存在空图层名`);
  // 实体引用的图层必须已在 LAYER 表中定义
  const declared = new Set(dxfInfo.layers);
  const undeclared = [...dxfInfo.usedLayers].filter((l) => !declared.has(l) && l !== '0');
  check(undeclared.length === 0, 'dxf:layers', `${key}: 实体引用未定义图层 [${undeclared.slice(0, 8).join(',')}]`);
  // 契约命名图层（硬失败：核心 8 个；其余记为 warning）
  const CORE_LAYERS = ['A-外墙', 'A-内墙', 'A-门', 'A-家具', 'A-文字', 'A-标注', 'A-图例', 'TK-图框'];
  const missingCore = CORE_LAYERS.filter((n) => !declared.has(n));
  check(missingCore.length === 0, 'dxf:layers', `${key}: 缺核心图层 [${missingCore.join(',')}]`);
  const CONTRACT_LAYERS = [...CORE_LAYERS, 'M-给水', 'M-排水', 'E-强电', 'E-弱电', 'G-气'];
  const missingNamed = CONTRACT_LAYERS.filter((n) => !declared.has(n));
  if (missingNamed.length) warn('dxf:layers', `${key}: 缺契约图层 [${missingNamed.join(',')}]（有 ${dxfInfo.layers.length} 层：${dxfInfo.layers.join(',')}）`);
  check(dxfInfo.styleCN, 'dxf:style', `${key}: STYLE 表缺 CN 文本样式（契约要求 font simsun.ttc）`);
  check(dxfInfo.nonAscii, 'dxf:text', `${key}: DXF 未见中文（UTF-8 直写）`);
  check(!dxfInfo.hasBadNumber, 'dxf:finite', `${key}: DXF 文本含 NaN/Infinity`);
  check(dxfInfo.entityCount >= 50, 'dxf:entities', `${key}: DXF 实体数=${dxfInfo.entityCount} 过少`);
  check(/^<svg[\s>]/.test(svg) || /^<\?xml[\s\S]{0,200}?<svg[\s>]/.test(svg), 'svg:structure', `${key}: SVG 未以 <svg 开头`);
  check(/<\/svg>\s*$/.test(svg), 'svg:structure', `${key}: SVG 未以 </svg> 结尾`);
  check(svg.length > 8000, 'svg:size', `${key}: SVG ${svg.length} bytes <= 8KB`);
  check(!/NaN|Infinity/.test(svg), 'svg:finite', `${key}: SVG 含 NaN/Infinity`);
  check(svg.includes('平面布置图'), 'svg:content', `${key}: SVG 缺图页标题「平面布置图」`);
  if (ctx.expectBoq) check(svg.includes('工程量与估价表'), 'svg:content', `${key}: SVG 缺图页标题「工程量与估价表」`);
  if (ctx.expectBoq) check(svg.includes('机电点位图'), 'svg:content', `${key}: SVG 缺图页标题「机电点位图」`);
  const roomNames = [...new Set(plan.rooms.filter((r) => r.kind !== 'corridor').map((r) => r.name))];
  const missingRooms = roomNames.filter((n) => !svg.includes(n));
  check(missingRooms.length === 0, 'svg:content', `${key}: SVG 缺房间名 [${missingRooms.join(',')}]`);
  return { entityTotal, layers };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const meta = loadMeta();
  result.meta = { assetCount: meta.map.size, missingFiles: meta.missingFiles };
  if (meta.missingFiles.length) warn('meta', `inventory 读取问题: ${meta.missingFiles.join('; ')}`);

  const mods = await loadModules();
  if (!mods.ok) {
    result.ok = false;
    result.reason = mods.reason;
    if (mods.missing) result.missing = mods.missing;
    if (mods.error) result.importError = mods.error;
    finish(2);
    return;
  }
  const { buildPlan, PLATFORMS, TYPES, STYLES, MODULES, buildQuote, quoteToCSV, amountInWords, buildDrawing, toDXF, toSVG, drawingStats, CAD_UNITS } = mods;

  log(`模块: ${mods.files.map((f) => path.basename(f) + ' ' + fs.statSync(f).size + 'B').join(', ')}`);
  result.modules = {
    files: mods.files.map((f) => ({ path: path.relative(ROOT, f), bytes: fs.statSync(f).size })),
    exports: { CAD_UNITS },
  };
  check(CAD_UNITS === 'mm', 'cad:api', `CAD_UNITS=${CAD_UNITS} 应为 'mm'`);

  // 组合枚举：3 平台 × 可用类型 × 5 风格 × 0..槽位模块组合
  const combos = [];
  for (const pid of Object.keys(PLATFORMS)) {
    const P = PLATFORMS[pid];
    const allowed = P.types;
    const subsets = moduleSubsets(MODULES.map((m) => m.id), P.slots);
    for (const typeId of allowed) {
      for (const s of STYLES) {
        for (const mods of subsets) {
          combos.push({ platform: pid, type: typeId, style: s.id, modules: mods });
        }
      }
    }
    result.combos.byPlatform[pid] = { types: allowed.length, moduleSubsets: subsets.length, combos: allowed.length * STYLES.length * subsets.length };
  }
  const useCombos = ARGS.limit > 0 ? combos.slice(0, ARGS.limit) : combos;
  result.combos.total = combos.length;
  log(`组合数 ${combos.length}（本次校验 ${useCombos.length}）`);

  const totals = new Map(); // comboKey → total
  const roomNames = new Map();
  const dxfLayerNames = new Map(); // pid → layer names (first combo)
  const allLayers = new Set();
  const missingMeta = new Set();
  const TYPE_NAME = new Map(TYPES.map((t) => [t.id, t.name]));
  const TYPE_DEF = new Map(TYPES.map((t) => [t.id, t]));
  const STYLE_NAME = new Map(STYLES.map((s) => [s.id, s.name]));
  const reachByKey = new Map(); // comboKey → UI 是否可达（强制模块 + 可选模块数 ≤ 平台槽位剩余）
  const knownSuperslotRangeViolations = []; // 超槽位组合里会越界的金额（按 Lead 裁定豁免，仅列出）
  let perAreaMin = Infinity, perAreaMax = -Infinity, perChairMin = Infinity, perChairMax = -Infinity;
  let perAreaMinReach = Infinity, perAreaMaxReach = -Infinity, perChairMinReach = Infinity, perChairMaxReach = -Infinity;
  const startCheck = Date.now();
  let idx = 0;
  for (const st of useCombos) {
    idx++;
    if (!ARGS.quiet && idx % 100 === 0) log(`进度 ${idx}/${useCombos.length} (${((Date.now() - startCheck) / 1000).toFixed(1)}s)`);
    const key = comboKey(st);
    const typeDef = TYPE_DEF.get(st.type);
    const mandated = new Set((typeDef && typeDef.modules) || []);
    const nonMandated = st.modules.filter((m) => !mandated.has(m)).length;
    const freeSlots = (PLATFORMS[st.platform] ? PLATFORMS[st.platform].slots : 0) - mandated.size;
    const reachable = nonMandated <= freeSlots && nonMandated >= 0;
    reachByKey.set(key, reachable);
    const ctx = {
      key, expectBoq: true, amountInWords, reachable,
      expectTypeName: TYPE_NAME.get(st.type),
      expectStyleName: STYLE_NAME.get(st.style),
      expectPlatformLabel: PLATFORMS[st.platform] && PLATFORMS[st.platform].label,
    };
    try {
      const plan = buildPlan({ platform: st.platform, type: st.type, style: st.style, modules: st.modules });
      for (const id of plan.assetIds) if (!meta.map.has(id)) missingMeta.add(id);
      if (!roomNames.has(st.type)) roomNames.set(st.type, [...new Set(plan.rooms.filter((r) => r.kind !== 'corridor').map((r) => r.name))]);
      const q1 = buildQuote(plan, { meta: { nameOf: meta.nameOf, categoryOf: meta.categoryOf }, date: ARGS.date });
      const q2 = buildQuote(plan, { meta: { nameOf: meta.nameOf, categoryOf: meta.categoryOf }, date: ARGS.date });
      checkQuote(st, plan, q1, q2, meta, ctx);
      totals.set(key, q1.totals.total);
      if (!reachable) {
        const t1 = q1.totals;
        const bad = [];
        if (!(finite(t1.perArea) && t1.perArea >= 3000 && t1.perArea <= 15000)) bad.push(`perArea=${round2(t1.perArea)}`);
        if (!(finite(t1.perChair) && t1.perChair >= 80000 && t1.perChair <= 600000)) bad.push(`perChair=${round2(t1.perChair)}`);
        if (bad.length) knownSuperslotRangeViolations.push({ key, total: t1.total, violations: bad });
      }
      perAreaMin = Math.min(perAreaMin, q1.totals.perArea); perAreaMax = Math.max(perAreaMax, q1.totals.perArea);
      perChairMin = Math.min(perChairMin, q1.totals.perChair); perChairMax = Math.max(perChairMax, q1.totals.perChair);
      if (reachable) {
        perAreaMinReach = Math.min(perAreaMinReach, q1.totals.perArea); perAreaMaxReach = Math.max(perAreaMaxReach, q1.totals.perArea);
        perChairMinReach = Math.min(perChairMinReach, q1.totals.perChair); perChairMaxReach = Math.max(perChairMaxReach, q1.totals.perChair);
      }

      // drawing：无 boq 与有 boq 各建一次（页面 3 只在 boq 时生成）
      const drawing = buildDrawing(plan, { boq: q1, meta: { nameOf: meta.nameOf } });
      const drawingNoBoq = buildDrawing(plan, { meta: { nameOf: meta.nameOf } });
      check(drawingNoBoq.sheets && drawingNoBoq.sheets.length === 2, 'drawing:sheets', `${key}: 无 boq 时应为 2 页，实为 ${drawingNoBoq.sheets && drawingNoBoq.sheets.length}`);
      const dxf = toDXF(drawing);
      const svg = toSVG(drawing);
      const stats = drawingStats(drawing);
      const dxfInfo = parseDxf(dxf);
      for (const l of dxfInfo.layers) allLayers.add(l);
      if (!dxfLayerNames.has(st.platform)) dxfLayerNames.set(st.platform, dxfInfo.layers);
      checkDrawingAndFormats(st, plan, q1, drawing, dxf, svg, stats, dxfInfo, ctx);
      check(typeof svg === 'string' && svg.length > 0, 'svg:size', `${key}: SVG 为空`);
      check(typeof dxf === 'string' && dxf.length > 0, 'dxf:size', `${key}: DXF 为空`);
      result.combos.checked++;
      result.combos.passed++;
    } catch (e) {
      result.combos.checked++;
      result.combos.failed++;
      check(false, 'combo:exception', `${key}: 抛出异常 ${e && (e.stack || e.message)}`);
    }
  }
  result.combos.failed = result.combos.checked - result.combos.passed;
  result.combos.reachable = [...reachByKey.values()].filter(Boolean).length;
  result.combos.unreachable = [...reachByKey.values()].filter((v) => !v).length;
  if (missingMeta.size) warn('meta', `以下资产在 inventory 中无中文名/分类（渲染回退 id）: ${[...missingMeta].slice(0, 20).join(',')}${missingMeta.size > 20 ? ` …等 ${missingMeta.size} 个` : ''}`);
  result.numbers = {
    combosTotal: combos.length,
    combosChecked: result.combos.checked,
    combosReachable: result.combos.reachable,
    combosUnreachable: result.combos.unreachable,
    perArea: { min: round2(perAreaMin), max: round2(perAreaMax), inRange: perAreaMin >= 3000 && perAreaMax <= 15000 },
    perChairYuan: { min: round2(perChairMin), max: round2(perChairMax), inRange: perChairMin >= 80000 && perChairMax <= 600000 },
    perAreaReachable: { min: round2(perAreaMinReach), max: round2(perAreaMaxReach), inRange: perAreaMinReach >= 3000 && perAreaMaxReach <= 15000 },
    perChairReachableYuan: { min: round2(perChairMinReach), max: round2(perChairMaxReach), inRange: perChairMinReach >= 80000 && perChairMaxReach <= 600000 },
    knownSuperslotRangeViolations, // 超槽位（UI 不可达）组合中会越出金额区间的组合，按 Lead 2026-11-13 裁定豁免
    layers: [...allLayers].sort(),
    layersByPlatform: Object.fromEntries([...dxfLayerNames].map(([k, v]) => [k, v.length])),
  };

  // ── 单调性 ────────────────────────────────────────────────────────────────
  const monotonic = { platformOrder: { pass: 0, fail: 0, pairs: [] }, addModule: { pass: 0, fail: 0, samples: [] } };
  for (const typeId of TYPES.map((t) => t.id)) {
    for (const style of STYLES.map((s) => s.id)) {
      const vals = ['S', 'M', 'L'].map((pid) => ({ pid, plan: PLATFORMS[pid], typeOk: PLATFORMS[pid].types.includes(typeId) }));
      for (let i = 0; i + 1 < vals.length; i++) {
        const a = vals[i], b = vals[i + 1];
        if (!a.typeOk || !b.typeOk) continue;
        const ta = totals.get(`${a.pid}|${typeId}|${style}|-`) ?? totals.get(comboKey({ platform: a.pid, type: typeId, style, modules: [] }));
        const tb = totals.get(`${b.pid}|${typeId}|${style}|-`) ?? totals.get(comboKey({ platform: b.pid, type: typeId, style, modules: [] }));
        if (!Number.isFinite(ta) || !Number.isFinite(tb)) continue;
        const ok = tb > ta;
        if (ok) monotonic.platformOrder.pass++; else monotonic.platformOrder.fail++;
        monotonic.platformOrder.pairs.push({ type: typeId, style, from: a.pid, to: b.pid, fromTotal: ta, toTotal: tb, ok });
        check(ok, 'monotonic:platform', `${typeId}/${style}: ${b.pid}(${tb}) 应 > ${a.pid}(${ta})`);
      }
      // 加模块不降价：只对 UI 可达组合（Lead 2026-11-13 口径）
      for (const pid of Object.keys(PLATFORMS)) {
        if (!PLATFORMS[pid].types.includes(typeId)) continue;
        const subsets = moduleSubsets(MODULES.map((m) => m.id), PLATFORMS[pid].slots);
        for (const sub of subsets) {
          const baseKey = `${pid}|${typeId}|${style}|${[...sub].sort().join('+') || '-'}`;
          if (!reachByKey.get(baseKey)) continue;
          const baseTotal = totals.get(baseKey);
          if (!Number.isFinite(baseTotal)) continue;
          for (const modId of MODULES.map((m) => m.id)) {
            if (sub.includes(modId) || sub.length >= PLATFORMS[pid].slots) continue;
            const supKey = `${pid}|${typeId}|${style}|${[...sub, modId].sort().join('+')}`;
            if (!reachByKey.get(supKey)) continue;
            const supTotal = totals.get(supKey);
            if (!Number.isFinite(supTotal)) continue;
            const ok = supTotal >= baseTotal - 1;
            if (ok) monotonic.addModule.pass++; else monotonic.addModule.fail++;
            if (!ok && monotonic.addModule.samples.length < 10) monotonic.addModule.samples.push({ pid, type: typeId, style, base: sub, add: modId, baseTotal, supTotal });
            check(ok, 'monotonic:module', `${pid}/${typeId}/${style}: ${sub.join('+') || '∅'}+${modId} 总价 ${supTotal} < 原 ${baseTotal}`);
          }
        }
      }
    }
  }
  result.monotonic = {
    platformOrder: { pass: monotonic.platformOrder.pass, fail: monotonic.platformOrder.fail, pairs: monotonic.platformOrder.pairs.filter((p) => p.from === 'S' || p.to === 'M').slice(0, 6) },
    addModule: { pass: monotonic.addModule.pass, fail: monotonic.addModule.fail, samples: monotonic.addModule.samples },
  };

  // ── 典型配置 + 量级基准 + CSV / 导出 ─────────────────────────────────────
  const typical = [
    { platform: 'S', type: 'community', style: 'calm', modules: [], baseline: { min: 550000, max: 700000, label: 'S 社区店 55–70 万' } },
    { platform: 'M', type: 'implant', style: 'cream', modules: [], baseline: { min: 1700000, max: 2000000, label: 'M 种植旗舰店+影像 170–200 万' }, perAreaBaseline: { min: 11000, max: 13000, label: 'M 种植单方 1.1–1.3 万/㎡' } },
    { platform: 'L', type: 'aesthetic', style: 'wood', modules: [], baseline: { min: 1900000, max: 2300000, label: 'L 美学体验店 190–230 万' } },
    { platform: 'M', type: 'community', style: 'kids', modules: ['lab'] },
  ];
  fs.mkdirSync(ARGS.outDir, { recursive: true });
  for (const tc of typical) {
    const plan = buildPlan({ platform: tc.platform, type: tc.type, style: tc.style, modules: tc.modules });
    const q = buildQuote(plan, { meta: { nameOf: meta.nameOf, categoryOf: meta.categoryOf }, date: ARGS.date });
    const drawing = buildDrawing(plan, { boq: q, meta: { nameOf: meta.nameOf } });
    const dxf = toDXF(drawing);
    const svg = toSVG(drawing);
    const csv = quoteToCSV(q);
    const dxfInfo = parseDxf(dxf);
    const tag = `${tc.platform}-${tc.type}-${tc.style}`;
    const item = {
      key: tag,
      platform: tc.platform,
      platformLabel: PLATFORMS[tc.platform] && PLATFORMS[tc.platform].label,
      typeName: TYPE_NAME.get(tc.type),
      styleName: STYLE_NAME.get(tc.style),
      modules: plan.modules,
      area: plan.stats.area, chairs: plan.stats.chairs, roomCount: plan.stats.roomCount, itemCount: plan.stats.itemCount,
      total: q.totals.total, subtotal: q.totals.subtotal, tax: q.totals.tax,
      low: q.totals.low, high: q.totals.high,
      perArea: round2(q.totals.perArea), perChair: round2(q.totals.perChair),
      totalHours: q.labor.totalHours, calendarDays: q.labor.calendarDays, lineCount: q.lines.length,
      dxfBytes: dxf.length, svgBytes: svg.length, csvBytes: csv.length,
      dxfEntities: dxfInfo.entityCount, dxfLayers: dxfInfo.layers.length,
    };
    result.typical.push(item);
    // 量级基准（契约 §4，2026 华东中端口径；2026-11-13 Lead 更新）
    if (tc.baseline) {
      check(item.total >= tc.baseline.min && item.total <= tc.baseline.max, 'quote:baseline',
        `${tag}: total=${item.total} 不在 ${tc.baseline.label} [${tc.baseline.min}, ${tc.baseline.max}] 区间`);
    }
    if (tc.perAreaBaseline) {
      check(item.perArea >= tc.perAreaBaseline.min && item.perArea <= tc.perAreaBaseline.max, 'quote:baseline',
        `${tag}: perArea=${item.perArea} 不在 ${tc.perAreaBaseline.label} [${tc.perAreaBaseline.min}, ${tc.perAreaBaseline.max}] 区间`);
    }
    // CSV 专项
    check(typeof csv === 'string' && csv.startsWith('\ufeff'), 'csv:bom', `${tag}: CSV 未以 BOM(\\ufeff) 开头`);
    check(typeof csv === 'string' && csv.length > 500, 'csv:size', `${tag}: CSV ${csv && csv.length} bytes <= 500`);
    check(typeof csv === 'string' && !/NaN|Infinity/.test(csv), 'csv:finite', `${tag}: CSV 含 NaN/Infinity`);
    for (const g of REQUIRED_GROUP_ORDER) check(typeof csv === 'string' && csv.includes(g), 'csv:content', `${tag}: CSV 缺分组「${g}」`);
    check(typeof csv === 'string' && (csv.includes('总计') || csv.includes('合计')), 'csv:content', `${tag}: CSV 缺合计/总计行`);
    check(amountInWords(q.totals.total) === q.totals.amountInWords, 'quote:words', `${tag}: amountInWords 不一致`);
    // 导出样例
    if (ARGS.export) {
      fs.writeFileSync(path.join(ARGS.outDir, `dxf-typ-${tag}.dxf`), dxf, 'utf8');
      fs.writeFileSync(path.join(ARGS.outDir, `svg-typ-${tag}.svg`), svg, 'utf8');
      fs.writeFileSync(path.join(ARGS.outDir, `csv-typ-${tag}.csv`), csv, 'utf8');
      item.files = {
        dxf: path.relative(ROOT, path.join(ARGS.outDir, `dxf-typ-${tag}.dxf`)),
        svg: path.relative(ROOT, path.join(ARGS.outDir, `svg-typ-${tag}.svg`)),
        csv: path.relative(ROOT, path.join(ARGS.outDir, `csv-typ-${tag}.csv`)),
      };
    }
  }

  // ── 全组合失败归一 ────────────────────────────────────────────────────────
  for (const [cat, n] of failCounts) {
    const c = result.checks[cat] || (result.checks[cat] = { pass: 0, fail: 0 });
    c.fail = n;
  }
  const failTotal = [...failCounts.values()].reduce((a, b) => a + b, 0);
  result.ok = failTotal === 0 && result.combos.failed === 0;
  result.failureTotal = failTotal;
  result.failedChecks = Object.fromEntries([...failCounts].sort((a, b) => b[1] - a[1]));
  finish(result.ok ? 0 : 1);
}

function round2(v) { return Number.isFinite(v) ? Math.round(v * 100) / 100 : v; }

async function loadModules() {
  const jsDir = ARGS.jsDir;
  const files = ['plan.js', 'config.js', 'quote.js', 'price-book.js', 'cad.js'];
  const required = files.map((f) => path.join(jsDir, f));
  if (ARGS.wait > 0) {
    const deadline = Date.now() + ARGS.wait * 1000;
    let stable = 0, prev = '';
    while (Date.now() < deadline) {
      const present = required.every((f) => fs.existsSync(f) && fs.statSync(f).size > 0);
      const sig = required.map((f) => (fs.existsSync(f) ? fs.statSync(f).size + ':' + fs.statSync(f).mtimeMs : '-')).join('|');
      if (present && sig === prev) stable++; else stable = 0;
      prev = sig;
      if (stable >= 2) break;
      await sleep(1500);
    }
  }
  const missing = required.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error('[verify] 模块未就绪，缺少文件：\n  ' + missing.map((f) => path.relative(ROOT, f)).join('\n  '));
    return { ok: false, reason: 'module-not-ready', missing: missing.map((f) => path.relative(ROOT, f)) };
  }
  try {
    const load = async (f) => import(pathToFileURL(path.join(jsDir, f)).href);
    const config = await load('config.js');
    const planMod = await load('plan.js');
    const quoteMod = await load('quote.js');
    await load('price-book.js').catch(() => null); // quote.js 内部会 import
    const cadMod = await load('cad.js');
    for (const fn of ['buildQuote', 'quoteToCSV', 'amountInWords']) {
      if (typeof quoteMod[fn] !== 'function') throw new Error(`quote.js 缺导出 ${fn}`);
    }
    for (const fn of ['buildDrawing', 'toDXF', 'toSVG', 'drawingStats']) {
      if (typeof cadMod[fn] !== 'function') throw new Error(`cad.js 缺导出 ${fn}`);
    }
    return {
      ok: true,
      files: required.filter((f) => fs.existsSync(f)),
      buildPlan: planMod.buildPlan,
      PLATFORMS: config.PLATFORMS, TYPES: config.TYPES, STYLES: config.STYLES, MODULES: config.MODULES,
      buildQuote: quoteMod.buildQuote, quoteToCSV: quoteMod.quoteToCSV, amountInWords: quoteMod.amountInWords,
      PRICE_BOOK: quoteMod.PRICE_BOOK,
      buildDrawing: cadMod.buildDrawing, toDXF: cadMod.toDXF, toSVG: cadMod.toSVG,
      drawingStats: cadMod.drawingStats, CAD_UNITS: cadMod.CAD_UNITS,
    };
  } catch (e) {
    console.error('[verify] 模块导入失败:', e && (e.stack || e.message));
    return { ok: false, reason: 'import-failed', error: String(e && (e.stack || e.message)) };
  }
}

function finish(code) {
  for (const [cat, n] of failCounts) {
    const c = result.checks[cat] || (result.checks[cat] = { pass: 0, fail: 0 });
    c.fail = n;
  }
  result.elapsedMs = Date.now() - result.t0 || 0;
  result.finishedAt = new Date().toISOString();
  if (!result.checks || Object.keys(result.checks).length === 0) result.checks = {};
  for (const c of Object.values(result.checks)) { if (c && typeof c.pass !== 'number') c.pass = 0; if (c && typeof c.fail !== 'number') c.fail = 0; }
  const passN = Object.values(result.checks).reduce((a, c) => a + (c.pass || 0), 0);
  const failN = Object.values(result.checks).reduce((a, c) => a + (c.fail || 0), 0);
  result.summary = { assertionsPass: passN, assertionsFail: failN, combosPassed: result.combos.passed, combosFailed: result.combos.failed, warnings: result.warnings.length };
  try {
    fs.mkdirSync(ARGS.outDir, { recursive: true });
    fs.writeFileSync(path.join(ARGS.outDir, 'verify-drawing-quote.result.json'), JSON.stringify(result, null, 2), 'utf8');
    result.resultFile = path.relative(ROOT, path.join(ARGS.outDir, 'verify-drawing-quote.result.json'));
  } catch (e) { console.error('[verify] 写结果文件失败:', e.message); }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = code;
}

result.t0 = Date.now();
main().catch((e) => {
  console.error('[verify] 未捕获异常:', e && (e.stack || e.message));
  result.ok = false;
  result.uncaught = String(e && (e.stack || e.message));
  finish(2);
});
