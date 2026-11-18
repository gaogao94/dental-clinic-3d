// 工程量 + 工时 + 造价估算（纯 ESM：不 import DOM/three/fetch/cad，只 import 本目录 price-book.js）
//
// 契约见 dental/plan/drawing-quote-contract.md §4：
//   buildQuote(plan, opts) → Quote
//   quoteToCSV(quote)      → UTF-8 带 BOM 的 CSV（Excel 中文不乱码）
//   amountInWords(yuan)    → 人民币大写
//
// 设计口径：
//   · 5 个固定分组：硬装工程 / 机电与暖通 / 家具与设备 / 设计与管理 / 税金
//   · 工时单位人天；工期 = 各阶段 ceil(阶段工时 / 班组人数) 之和
//   · 造价 = 单价 × 工程量（数量 2 位小数，金额取整到元）；税 = 前四组合计 × taxRate
//   · 可复现：无随机；generatedAt 取 opts.date 或本地日期字符串
import { PRICE_BOOK } from './price-book.js';

export { PRICE_BOOK } from './price-book.js';

// ── 常量 ──────────────────────────────────────────────────────────────────
const GROUPS = [
  { id: 'hard', name: '硬装工程' },
  { id: 'mep', name: '机电与暖通' },
  { id: 'furn', name: '家具与设备' },
  { id: 'design', name: '设计与管理' },
  { id: 'tax', name: '税金' },
];
const GROUP_BY_NAME = Object.fromEntries(GROUPS.map((g) => [g.name, g]));
const TRADES = [
  { id: 'design', name: '设计' },
  { id: 'build', name: '硬装' },
  { id: 'mep', name: '机电' },
  { id: 'install', name: '安装' },
  { id: 'commission', name: '调试' },
];
const PHASES = [
  { id: 'design', name: '设计', trade: 'design', crew: 'design' },
  { id: 'build', name: '硬装施工', trade: 'build', crew: 'build' },
  { id: 'mep', name: '机电安装', trade: 'mep', crew: 'mep' },
  { id: 'install', name: '家具设备安装', trade: 'install', crew: 'install' },
  { id: 'commission', name: '调试交付', trade: 'commission', crew: 'commission' },
];
// 平台 / 门店类型 / 风格显示名（与 js/config.js 一致；quote.js 不 import config 以保持纯模块边界）
const PLATFORM_LABELS = { S: 'S', M: 'M', L: 'L' };
const TYPE_LABELS = {
  community: '社区家庭店', kids: '儿童诊疗店', ortho: '正畸中心',
  implant: '种植旗舰店', aesthetic: '美学体验店',
};
const STYLE_LABELS = {
  calm: '洁净蓝白', kids: '儿童糖果', mono: '极简黑白', wood: '疗愈木', cream: '暖奶油',
};
const QTY_LABELS = {
  area: '建筑面积', usableArea: '净使用面积', ceilingArea: '天花面积',
  partitionArea: '隔墙投影面积', extWallArea: '外墙内表面面积', intWallArea: '隔墙双面面积',
  perimeter: '建筑周长', doors: '门洞数量', glassArea: '幕墙玻璃面积',
  lightCount: '灯具数量', acCount: '空调数量',
};
const HARD_KIND_LABELS = { water: '给水', power: '强电', gas: '医用气体', drain: '排水', net: '弱电' };

// ── 小工具 ────────────────────────────────────────────────────────────────
const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const toYuan = (v) => Math.round(Number(v || 0));
const ceilDays = (h) => (h > 0 ? Math.max(1, Math.ceil(h - 1e-9)) : 0);
function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function localDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── 工程量：从 plan 几何/清单推出计量基数（㎡ / m / 点 / 件）────────────────
function measurePlan(plan, book, nm) {
  const W = num(plan.W);
  const D = num(plan.D);
  const usableW = num(plan.usableW, W - num(plan.conn));
  const frontD = num(plan.frontD);
  const corrAz = num(plan.corrAz);
  const corrAd = num(plan.corrAd);
  const corrBz = num(plan.corrBz);
  const corrBd = num(plan.corrBd);
  const backd = num(plan.backd);
  const wallH = num(book.wallHeight, 2.8);
  const rooms = Array.isArray(plan.rooms) ? plan.rooms : [];

  // 建筑面积 / 净使用面积（不含公共走廊、竖向通道）
  const area = round2(W * D);
  const usableArea = round2(usableW * (D - corrAd - corrBd));
  const perimeter = round2(2 * (W + D));

  // 内墙：横向隔墙（前区墙 + 各条走廊隔墙）+ 每条房带的房间分隔墙 + 段末墙
  const hWalls = [frontD, corrAz, corrAz + corrAd];
  if (corrBd > 0.001) hWalls.push(corrBz);                 // rowB 南墙（L 平台）
  if (backd > 0.001) hWalls.push(corrBz + corrBd);         // 后区北墙（带门洞）
  let partitionLen = hWalls.length * usableW;
  for (const zone of ['rowA', 'rowB', 'back']) {
    const list = rooms.filter((r) => r.zone === zone);
    if (!list.length) continue;
    const depth = num(list[0].d);
    partitionLen += list.length * depth;                   // n 间房 → n 道墙（含段末墙）
  }
  partitionLen = round2(partitionLen);
  const partitionArea = round2(partitionLen * wallH);
  const intWallArea = round2(partitionArea * 2);           // 双面
  const ceilingArea = area;                                // 全屋吊顶（含走廊）

  // 入口玻璃幕墙：facade 两条玻璃带，按建筑宽度裁切
  const facade = book.facade || {};
  const gw = num(facade.glassW, 3.6);
  const gh = num(facade.glassH, 2.45);
  const entranceX = num(plan.entranceX, W / 2);
  const entranceW = num(plan.entranceW, 1.8);
  const entranceH = num(facade.entranceH, 2.45);
  const glassOffset = num(facade.glassOffset, 2.7);
  let glassLen = 0;
  for (const cx of [entranceX - glassOffset, entranceX + glassOffset]) {
    const x1 = Math.max(0, cx - gw / 2);
    const x2 = Math.min(W, cx + gw / 2);
    if (x2 > x1) glassLen += x2 - x1;
  }
  const glassArea = round2(glassLen * gh);
  const extWallArea = round2(Math.max(0, perimeter * wallH - glassArea - entranceW * entranceH));

  // 五类硬点
  const points = { water: 0, power: 0, gas: 0, drain: 0, net: 0 };
  for (const hp of plan.hardPoints || []) {
    if (hp && points[hp.kind] != null) points[hp.kind] += 1;
  }
  const pointCount = points.water + points.power + points.gas + points.drain + points.net;

  // 天花灯具 / 空调数量
  let lightCount = 0;
  let acCount = 0;
  for (const f of plan.ceilingFixtures || []) {
    if (f.kind === 'light') lightCount += 1;
    else if (f.kind === 'ac') acCount += 1;
  }

  // 资产件数 / 分类
  const itemsByAsset = {};
  const itemsByCategory = {};
  for (const it of plan.items || []) {
    if (!it || !it.asset) continue;
    itemsByAsset[it.asset] = (itemsByAsset[it.asset] || 0) + 1;
    const cat = nm.categoryOf(it.asset);
    itemsByCategory[cat] = (itemsByCategory[cat] || 0) + 1;
  }
  const itemCount = (plan.items || []).length;
  const diffSet = new Set(Array.isArray(plan.diffIds) ? plan.diffIds : []);
  let diffItemCount = 0;
  for (const it of plan.items || []) if (it && diffSet.has(it.asset)) diffItemCount += 1;
  const sharedItemCount = itemCount - diffItemCount;
  const chairs = Math.max(1, num(plan.stats && plan.stats.chairs, countChairs(plan)));
  const clinics = num(plan.stats && plan.stats.clinics, chairs);
  const roomCount = num(plan.stats && plan.stats.roomCount,
    rooms.filter((r) => r.kind !== 'corridor').length);
  const doors = rooms.filter((r) => r && r.door).length + 1; // + 入口感应门

  return {
    area, usableArea, perimeter, partitionLen, partitionArea, extWallArea, intWallArea,
    ceilingArea, glassArea, wallHeight: wallH,
    points, pointCount, lightCount, acCount,
    doors, chairs, clinics, roomCount, itemCount, sharedItemCount, diffItemCount,
    itemsByAsset, itemsByCategory,
    // 各分组计价面积基数（㎡）：硬装/机电/设计按建筑面积，家具与设备按净使用面积
    hardArea: area, mepArea: area, itemArea: usableArea, designArea: area,
  };
}

function countChairs(plan) {
  let n = 0;
  for (const it of plan.items || []) if (it && String(it.asset).startsWith('dental-chair')) n += 1;
  return n || 1;
}

// 面积类规则的工程量选择器
function areaQty(rule, m) {
  const base = {
    area: m.area,
    usableArea: m.usableArea,
    ceilingArea: m.ceilingArea,
    partitionArea: m.partitionArea,
    extWallArea: m.extWallArea,
    intWallArea: m.intWallArea,
    perimeter: m.perimeter,
  }[rule.qty];
  return applyFactor(base, rule);
}
// 件数类规则的工程量选择器
function countQty(rule, m) {
  const base = {
    doors: m.doors,
    glassArea: m.glassArea,
    lightCount: m.lightCount,
    acCount: m.acCount,
  }[rule.qty];
  return applyFactor(base, rule);
}
function applyFactor(base, rule) {
  const v = num(base, 0) * num(rule.factor, 1) + num(rule.offset, 0);
  return v > 0 ? round2(v) : 0;
}

// ── 名称 / 分类 / 单价 / 工时查找 ────────────────────────────────────────
function makeNameCategory(plan, meta, book) {
  void plan;
  const m = meta || {};
  // meta 契约：{ nameOf(id), categoryOf(id) }；node 端缺省时用 price-book 的 assetCategories 兜底
  const nameFn = typeof m.nameOf === 'function' ? m.nameOf : null;
  const catFn = typeof m.categoryOf === 'function' ? m.categoryOf : null;
  const table = book.assetCategories || {};
  const def = book.defaultCategory || '';
  return {
    nameOf(id) {
      if (nameFn) {
        try { const v = nameFn(id); if (v) return String(v); } catch { /* 兜底 */ }
      }
      return String(id);
    },
    categoryOf(id) {
      if (catFn) {
        try { const v = catFn(id); if (v) return String(v); } catch { /* 兜底 */ }
      }
      return table[id] || def;
    },
  };
}

function priceOf(book, id, cat) {
  const p = book.itemPrices && book.itemPrices[id];
  if (Number.isFinite(p)) return Number(p);
  const cp = book.categoryPrices || {};
  const v = cp[cat] != null ? cp[cat] : cp[book.defaultCategory];
  return Number.isFinite(v) ? Number(v) : 0;
}
function hoursOf(book, id, cat) {
  const h = book.itemHours && book.itemHours[id];
  if (Number.isFinite(h)) return Number(h);
  const ch = book.categoryHours || {};
  const v = ch[cat] != null ? ch[cat] : ch[book.defaultCategory];
  return Number.isFinite(v) ? Number(v) : 0;
}

// ── buildQuote ────────────────────────────────────────────────────────────
export function buildQuote(plan, opts = {}) {
  if (!plan || typeof plan !== 'object') throw new TypeError('buildQuote: 需要 plan 对象');
  const book = opts.book || PRICE_BOOK;
  const meta = opts.meta || {};
  const generatedAt = opts.date || localDate();
  const nm = makeNameCategory(plan, meta, book);
  const m = measurePlan(plan, book, nm);
  const mods = new Set(Array.isArray(plan.modules) ? plan.modules : []);
  const styleFactor = num(book.styleFactor && book.styleFactor[plan.style], 1);

  // 每组 line 记录：内部带 trade 用于工种工时，输出前剥离
  const buckets = { hard: [], mep: [], furn: [], design: [], tax: [] };
  const add = (bucket, trade, name, spec, unit, qty, price, amount, hours) => {
    buckets[bucket].push({
      trade, name: String(name || ''),
      spec: String(spec || ''), unit: String(unit || ''),
      qty: round2(qty), price: round2(price), amount: toYuan(amount), hours: round2(hours),
    });
  };

  // ── 1. 硬装工程：面积 / 长度 / 件数规则 ────────────────────────────────
  for (const rule of book.areaRules || []) {
    const qty = areaQty(rule, m);
    if (!(qty > 0)) continue;
    const isHard = (rule.group || '硬装工程') === '硬装工程';
    const sf = isHard ? styleFactor : 1;
    const price = num(rule.price);
    add(isHard ? 'hard' : 'mep', isHard ? 'build' : 'mep',
      rule.name || rule.id, rule.spec || QTY_LABELS[rule.qty] || '', rule.unit || '㎡',
      qty, price * sf, qty * price * sf, qty * num(rule.hours));
  }
  for (const rule of book.countRules || []) {
    const qty = countQty(rule, m);
    if (!(qty > 0)) continue;
    const isHard = (rule.group || '硬装工程') === '硬装工程';
    const sf = isHard ? styleFactor : 1;
    const price = num(rule.price);
    add(isHard ? 'hard' : 'mep', isHard ? 'build' : 'mep',
      rule.name || rule.id, rule.spec || QTY_LABELS[rule.qty] || '', rule.unit || '项',
      qty, price * sf, qty * price * sf, qty * num(rule.hours));
  }

  // ── 2. 机电与暖通：五类硬点 / 选装模块附加 / 调试 ──────────────────────
  for (const rule of book.pointRules || []) {
    const qty = num(m.points[rule.kind]);
    if (!(qty > 0)) continue;
    const price = num(rule.price);
    add('mep', 'mep', rule.name || rule.kind,
      `五类硬点 · ${HARD_KIND_LABELS[rule.kind] || rule.kind}`, rule.unit || '点',
      qty, price, qty * price, qty * num(rule.hours));
  }
  for (const rule of book.moduleRules || []) {
    if (!mods.has(rule.module)) continue;
    const isHard = (rule.group || '机电与暖通') === '硬装工程';
    const sf = isHard ? styleFactor : 1;
    const price = num(rule.price);
    add(isHard ? 'hard' : 'mep', isHard ? 'build' : 'mep',
      rule.name || rule.module, rule.spec || '选装模块附加', rule.unit || '项',
      1, price * sf, price * sf, num(rule.hours));
  }
  if (book.commission) {
    const c = book.commission;
    const price = num(c.price);
    const hours = num(c.hoursBase) + num(c.hoursPerChair) * m.chairs;
    add('mep', 'commission', c.name || '系统联调与验收', c.spec || '联调/培训/验收', c.unit || '项',
      1, price, price, hours);
  }

  // ── 3. 家具与设备：按资产覆盖价（缺省分类兜底价）× 数量 ────────────────
  const catIndex = Object.keys(book.categoryPrices || {});
  const assetIds = Object.keys(m.itemsByAsset).sort((a, b) => {
    const ca = catIndex.indexOf(nm.categoryOf(a));
    const cb = catIndex.indexOf(nm.categoryOf(b));
    const ia = ca < 0 ? catIndex.length : ca;
    const ib = cb < 0 ? catIndex.length : cb;
    return ia - ib || (a < b ? -1 : a > b ? 1 : 0);
  });
  for (const id of assetIds) {
    const qty = m.itemsByAsset[id];
    const cat = nm.categoryOf(id);
    const price = priceOf(book, id, cat);
    const h = hoursOf(book, id, cat);
    add('furn', 'install', nm.nameOf(id), cat, '件', qty, price, qty * price, qty * h);
  }

  // ── 4. 设计与管理：按（硬装 + 机电）造价百分比 + 工时 ──────────────────
  const sumAmount = (list) => list.reduce((s, r) => s + r.amount, 0);
  const hardAmount = sumAmount(buckets.hard);
  const mepAmount = sumAmount(buckets.mep);
  const furnAmount = sumAmount(buckets.furn);
  const designBase = hardAmount + mepAmount;
  const designCfg = book.design || {};
  const designFee = toYuan(designBase * num(designCfg.feePct));
  const designHours = num(designCfg.hoursBase) + num(designCfg.hoursPerRoom) * m.roomCount
    + num(designCfg.hoursPerChair) * m.chairs;
  add('design', 'design', '方案设计费', `硬装+机电造价 ${round2(num(designCfg.feePct) * 100)}%`,
    '项', 1, designFee, designFee, designHours);
  const manageCfg = book.manage || {};
  const manageFee = toYuan(designBase * num(manageCfg.feePct));
  const manageHours = num(manageCfg.hoursBase) + num(manageCfg.hoursPerRoom) * m.roomCount;
  add('design', 'design', '项目管理费', `硬装+机电造价 ${round2(num(manageCfg.feePct) * 100)}%`,
    '项', 1, manageFee, manageFee, manageHours);

  // ── 5. 税金：前四组合计 × 税率 ──────────────────────────────────────────
  const preTax = hardAmount + mepAmount + furnAmount + sumAmount(buckets.design);
  const taxRate = num(book.taxRate);
  const taxAmount = toYuan(preTax * taxRate);
  add('tax', '', '增值税', `税率 ${round2(taxRate * 100)}%`, '项', 1, taxAmount, taxAmount, 0);

  // ── 组装 lines / groups ─────────────────────────────────────────────────
  const lines = [];
  const groupAgg = {};
  for (const g of GROUPS) groupAgg[g.id] = { amount: 0, hours: 0 };
  let no = 0;
  for (const g of GROUPS) {
    for (const rec of buckets[g.id]) {
      no += 1;
      lines.push({
        no,
        group: g.name,
        name: rec.name,
        spec: rec.spec,
        unit: rec.unit,
        qty: rec.qty,
        price: rec.price,
        amount: rec.amount,
        hours: rec.hours,
      });
      groupAgg[g.id].amount += rec.amount;
      groupAgg[g.id].hours += rec.hours;
    }
  }
  const total = preTax + taxAmount;
  const groups = GROUPS.map((g) => ({
    id: g.id,
    name: g.name,
    amount: groupAgg[g.id].amount,
    hours: round2(groupAgg[g.id].hours),
    share: total > 0 ? groupAgg[g.id].amount / total : 0,
  }));

  // ── 工时 / 工种 / 阶段 ──────────────────────────────────────────────────
  const tradeHours = Object.fromEntries(TRADES.map((t) => [t.id, 0]));
  let totalHours = 0;
  for (const g of GROUPS) {
    for (const rec of buckets[g.id]) {
      if (rec.trade && tradeHours[rec.trade] != null) tradeHours[rec.trade] += rec.hours;
      totalHours += rec.hours;
    }
  }
  totalHours = round2(totalHours);
  const byTrade = TRADES.map((t) => ({
    id: t.id,
    name: t.name,
    hours: round2(tradeHours[t.id]),
    share: totalHours > 0 ? tradeHours[t.id] / totalHours : 0,
  }));
  const crews = (book.labor && book.labor.crews) || {};
  const phases = PHASES.map((p) => {
    const hours = round2(tradeHours[p.trade]);
    const crew = Math.max(1, num(crews[p.crew], 1));
    return { id: p.id, name: p.name, days: ceilDays(hours / crew), hours, crew };
  });
  const calendarDays = phases.reduce((s, p) => s + p.days, 0);
  const peakCrew = phases.reduce((s, p) => Math.max(s, p.crew), 0);

  // ── 按房间归集（家具与设备明细；用于核对分布）──────────────────────────
  const roomName = {};
  for (const r of plan.rooms || []) if (r && r.id) roomName[r.id] = r.name || r.id;
  const roomAgg = new Map();
  for (const it of plan.items || []) {
    if (!it || !it.asset) continue;
    const roomId = it.room || 'corridor';
    if (!roomAgg.has(roomId)) roomAgg.set(roomId, { amount: 0, hours: 0, itemCount: 0 });
    const cat = nm.categoryOf(it.asset);
    const a = roomAgg.get(roomId);
    a.amount += priceOf(book, it.asset, cat);
    a.hours += hoursOf(book, it.asset, cat);
    a.itemCount += 1;
  }
  const byRoom = [];
  const seenRoom = new Set();
  const orderedRoomIds = [...(plan.rooms || []).map((r) => r && r.id).filter(Boolean),
    ...roomAgg.keys()];
  for (const rid of orderedRoomIds) {
    if (seenRoom.has(rid) || !roomAgg.has(rid)) continue;
    seenRoom.add(rid);
    const a = roomAgg.get(rid);
    byRoom.push({
      roomId: rid, name: roomName[rid] || rid,
      amount: toYuan(a.amount), hours: round2(a.hours), itemCount: a.itemCount,
    });
  }

  // ── 汇总 / 区间 / 指标 ─────────────────────────────────────────────────
  const subtotal = groups.filter((g) => g.id !== 'tax').reduce((s, g) => s + g.amount, 0);
  const rangePct = num(book.rangePct);
  const totalSafe = total > 0 ? total : 0;
  const perArea = m.area > 0 ? round2(totalSafe / m.area) : 0;
  const perChair = m.chairs > 0 ? round2(totalSafe / m.chairs) : 0;

  const config = {
    platform: String(plan.platform || ''),
    platformLabel: PLATFORM_LABELS[plan.platform] || String(plan.platform || ''),
    typeName: TYPE_LABELS[plan.type] || String(plan.type || ''),
    styleName: STYLE_LABELS[plan.style] || String(plan.style || ''),
    modules: [...mods],
    area: m.area,
    chairs: m.chairs,
    roomCount: m.roomCount,
  };

  const metrics = {
    area: m.area,
    usableArea: m.usableArea,
    perimeter: m.perimeter,
    partitionLen: m.partitionLen,
    ceilingArea: m.ceilingArea,
    points: { ...m.points },
    pointCount: m.pointCount,
    chairs: m.chairs,
    clinics: m.clinics,
    roomCount: m.roomCount,
    itemCount: m.itemCount,
    sharedItemCount: m.sharedItemCount,
    diffItemCount: m.diffItemCount,
    itemsByAsset: { ...m.itemsByAsset },
    itemsByCategory: { ...m.itemsByCategory },
    hardArea: m.hardArea,
    mepArea: m.mepArea,
    itemArea: m.itemArea,
    designArea: m.designArea,
  };

  return {
    kind: 'clinic-quote',
    version: 1,
    generatedAt,
    config,
    metrics,
    lines,
    groups,
    totals: {
      subtotal,
      tax: taxAmount,
      total: totalSafe,
      low: toYuan(totalSafe * (1 - rangePct)),
      high: toYuan(totalSafe * (1 + rangePct)),
      perArea,
      perChair,
      amountInWords: amountInWords(totalSafe),
      rangePct,
    },
    labor: {
      totalHours,
      byTrade,
      calendarDays,
      phases,
      peakCrew,
    },
    byRoom,
    priceBookVersion: book.version || '',
  };
}

// ── CSV（UTF-8 + BOM，Excel 中文不乱码）───────────────────────────────────
const CSV_COLS = 9;
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(cells) {
  const arr = Array.from({ length: CSV_COLS }, (_, i) => cells[i] == null ? '' : cells[i]);
  return arr.map(csvCell).join(',');
}

export function quoteToCSV(quote) {
  if (!quote || !Array.isArray(quote.lines)) return '\ufeff';
  const cfg = quote.config || {};
  const totals = quote.totals || {};
  const labor = quote.labor || {};
  const groups = Array.isArray(quote.groups) ? quote.groups : [];
  const rows = [];
  const cfgText = [
    `平台 ${cfg.platformLabel || cfg.platform || ''}`,
    cfg.typeName || '', cfg.styleName || '',
    `${cfg.area != null ? cfg.area : ''}㎡`,
    `${cfg.chairs != null ? cfg.chairs : ''} 椅`,
    `${cfg.roomCount != null ? cfg.roomCount : ''} 间`,
  ].filter(Boolean).join(' · ');
  rows.push(csvRow(['配置', cfgText]));
  rows.push(csvRow(['生成日期', quote.generatedAt || '']));
  rows.push(csvRow(['序号', '分组', '项目', '规格', '单位', '数量', '单价(元)', '合价(元)', '工时(人天)']));
  for (const line of quote.lines) {
    rows.push(csvRow([
      line.no, line.group, line.name, line.spec, line.unit,
      line.qty, line.price, line.amount, line.hours,
    ]));
  }
  rows.push(csvRow([]));
  for (const g of groups) rows.push(csvRow(['小计', g.name, '', '', '', '', '', g.amount, g.hours]));
  rows.push(csvRow(['', '税前合计', '', '', '', '', '', totals.subtotal, '']));
  rows.push(csvRow(['', '税金', '', '', '', '', '', totals.tax, '']));
  rows.push(csvRow(['', '总计', '', '', '', '', '', totals.total, '']));
  rows.push(csvRow(['', '单方造价（元/㎡）', totals.perArea]));
  rows.push(csvRow(['', '每椅造价（元/椅）', totals.perChair]));
  rows.push(csvRow(['', '总工时（人天）', labor.totalHours]));
  rows.push(csvRow(['', '工期（天）', labor.calendarDays]));
  rows.push(csvRow(['', '估价区间（元）', `${totals.low} ~ ${totals.high}`]));
  rows.push(csvRow(['', '金额大写', totals.amountInWords]));
  return '\ufeff' + rows.join('\r\n');
}

// ── 人民币大写 ────────────────────────────────────────────────────────────
const RMB_DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
const RMB_UNITS = ['', '拾', '佰', '仟'];
const RMB_BIG_UNITS = ['', '万', '亿', '万亿', '亿亿'];

function groupToWords(num4) {
  let out = '';
  let zero = false;
  for (let i = 3; i >= 0; i--) {
    const d = Math.floor(num4 / 10 ** i) % 10;
    if (d === 0) {
      if (out) zero = true;
    } else {
      if (zero) { out += '零'; zero = false; }
      out += RMB_DIGITS[d] + RMB_UNITS[i];
    }
  }
  return out;
}

function intToWords(intPart) {
  if (!Number.isFinite(intPart) || intPart <= 0) return '';
  const groups4 = [];
  let n = Math.floor(intPart);
  while (n > 0) {
    groups4.push(n % 10000);
    n = Math.floor(n / 10000);
  }
  let out = '';
  let pendingZero = false;
  for (let i = groups4.length - 1; i >= 0; i--) {
    const g = groups4[i];
    if (g === 0) {
      if (out) pendingZero = true;
      continue;
    }
    if (out && (pendingZero || g < 1000)) out += '零';
    pendingZero = false;
    out += groupToWords(g) + RMB_BIG_UNITS[i];
  }
  return out;
}

/**
 * 人民币大写：amountInWords(123456) → '人民币壹拾贰万叁仟肆佰伍拾陆元整'
 * 支持角分：1234.56 → …元伍角陆分；1.05 → …元零伍分；0.56 → 人民币伍角陆分
 */
export function amountInWords(yuan) {
  const raw = Number(yuan);
  if (!Number.isFinite(raw)) throw new TypeError(`amountInWords: 需要有限数值，收到 ${yuan}`);
  const negative = raw < 0;
  const cents = Math.round((Math.abs(raw) + Number.EPSILON) * 100);
  const intPart = Math.floor(cents / 100);
  const jiao = Math.floor((cents % 100) / 10);
  const fen = cents % 10;

  let body = '';
  if (intPart > 0) body += intToWords(intPart) + '元';
  else if (jiao === 0 && fen === 0) body = '零元';

  if (jiao === 0 && fen === 0) {
    body += '整';
  } else {
    if (jiao > 0) body += RMB_DIGITS[jiao] + '角';
    if (fen > 0) {
      if (jiao === 0 && intPart > 0) body += '零';
      body += RMB_DIGITS[fen] + '分';
    }
  }
  return (negative ? '负' : '') + '人民币' + body;
}
