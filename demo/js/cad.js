// CAD 出图引擎：plan → Drawing（平面布置图 / 机电点位图 / 工程量与估价表）→ DXF(R2007/AC1021) + SVG
// 纯 ESM 模块：不依赖 DOM / three / fetch；只 import ./footprint.js 与 ./config.js 的常量。
// 坐标约定：plan 用米、x 向东、z 向南；Drawing 全部为模型空间毫米（1:1），图框 = 图纸尺寸 × 比例分母。
// 契约：dental/plan/drawing-quote-contract.md §3。

import { footprintOf } from './footprint.js';
import { PLATFORMS, TYPE_MAP, STYLE_MAP, HARD_KINDS } from './config.js';

export const CAD_UNITS = 'mm';

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────
const PAPER = { A2: { w: 594, h: 420, label: 'A2' } };   // 图纸幅面（mm）
const MARGIN = { left: 25, right: 10, top: 10, bottom: 10 }; // 图框内边距（图纸 mm）
const SHEET_GAP = 2000;          // 模型空间整卷页间距（mm）
const WALL_T = 120;              // 墙厚（mm，中心线两侧各 60）
const TITLE_BLOCK = { w: 200, titleH: 16, rowH: 9 };     // 标题栏（图纸 mm）
const TITLE_H_MAX = 79;          // 标题栏最大高度（图纸 mm，含估价行）
const SCALE_CANDIDATES = [25, 50, 100, 150, 200];
const PROJECT_STAGE = '方案设计';

// 字号（模型毫米，契约 §3.1；家具名按 Lead 要求收到 180）
const TEXT = {
  roomName: 350, roomSub: 200, furniture: 180, dim: 250,
  frameTitle: 500, tableHead: 250, tableBody: 180, note: 200,
};
// 房间名 / 尺寸 / 面积的字号候选（放不下逐级缩，最低 220 / 160）
const NAME_H_CANDIDATES = [350, 300, 260, 220, 200, 180];
const SUB_H_CANDIDATES = [200, 180, 160];

// 图层（中文名 + ACI 颜色 + 线型）
const LAYER_DEFS = [
  { name: 'A-外墙', aci: 7, ltype: 'CONTINUOUS' },
  { name: 'A-内墙', aci: 7, ltype: 'CONTINUOUS' },
  { name: 'A-门', aci: 3, ltype: 'CONTINUOUS' },
  { name: 'A-家具', aci: 8, ltype: 'CONTINUOUS' },
  { name: 'A-文字', aci: 7, ltype: 'CONTINUOUS' },
  { name: 'A-标注', aci: 4, ltype: 'CONTINUOUS' },
  { name: 'M-给水', aci: 5, ltype: 'CONTINUOUS' },
  { name: 'M-排水', aci: 6, ltype: 'CONTINUOUS' },
  { name: 'E-强电', aci: 2, ltype: 'CONTINUOUS' },
  { name: 'E-弱电', aci: 1, ltype: 'CONTINUOUS' },
  { name: 'G-气', aci: 3, ltype: 'CONTINUOUS' },
  { name: 'A-图例', aci: 7, ltype: 'CONTINUOUS' },
  { name: 'TK-图框', aci: 7, ltype: 'CONTINUOUS' },
];
export const CAD_LAYERS = LAYER_DEFS.map((d) => d.name);
const LAYER_ORDER = CAD_LAYERS;
const LAYER_NAMES = new Set(CAD_LAYERS);

// 代码里用短名
const LN = {
  ext: 'A-外墙', int: 'A-内墙', door: 'A-门', furn: 'A-家具', text: 'A-文字', dim: 'A-标注',
  water: 'M-给水', drain: 'M-排水', power: 'E-强电', net: 'E-弱电', gas: 'G-气',
  legend: 'A-图例', frame: 'TK-图框',
};

// 硬点 kind → 图层 / 字符 / 类目名（取 config.HARD_KINDS 的名称与语义色）
const HARD_LAYER = { water: LN.water, drain: LN.drain, power: LN.power, net: LN.net, gas: LN.gas };
const HARD_LABEL = { water: '给水', drain: '排水', power: '强电', net: '弱电', gas: '燃气' };
const HARD_KIND = Object.fromEntries((Array.isArray(HARD_KINDS) ? HARD_KINDS : []).map((k) => [k.id, k]));

// SVG 呈现（与 DXF ACI 对应；白纸配色）
const SVG_LAYER = {
  'A-外墙': { color: '#1a1a1a', width: 0.36 },
  'A-内墙': { color: '#1a1a1a', width: 0.24 },
  'A-门': { color: '#1e8449', width: 0.18 },
  'A-家具': { color: '#7a7f87', width: 0.13 },
  'A-文字': { color: '#1a1a1a', width: 0.13 },
  'A-标注': { color: '#117a8b', width: 0.13 },
  'M-给水': { color: '#1f4e9c', width: 0.18 },
  'M-排水': { color: '#8e44ad', width: 0.18 },
  'E-强电': { color: '#b8860b', width: 0.18 },
  'E-弱电': { color: '#c0392b', width: 0.18 },
  'G-气': { color: '#1e8449', width: 0.18 },
  'A-图例': { color: '#1a1a1a', width: 0.13 },
  'TK-图框': { color: '#1a1a1a', width: 0.24 },
};

// 表格列（图纸 mm 宽度；name/spec 为 flex 列，按内框剩余宽度自适应）
const BOQ_COLS = [
  { key: 'no', label: '序号', w: 18, align: 'center' },
  { key: 'name', label: '项目', w: 90, align: 'left', flex: true },
  { key: 'spec', label: '规格', w: 80, align: 'left', flex: true },
  { key: 'unit', label: '单位', w: 18, align: 'center' },
  { key: 'qty', label: '数量', w: 24, align: 'right' },
  { key: 'price', label: '单价(元)', w: 34, align: 'right' },
  { key: 'amount', label: '合价(元)', w: 34, align: 'right' },
  { key: 'hours', label: '工时(人天)', w: 42, align: 'right' },
];
// 表页版式（图纸 mm；Lead 要求：正文 4.86/1.35 行距收紧，1:50 时正文字高恰为 180 模型 mm）
const BOQ_PAPER = {
  body: 3.6,      // 正文字高（图纸 mm）→ 1:50 时 = 180 模型 mm
  strong: 3.8,    // 分组/小计/表尾强调行字高（图纸 mm，与 4.86 行高匹配不压行）
  head: 5.0,      // 表头字高（图纸 mm）→ 1:50 时 = 250 模型 mm
  row: 4.7,       // 行高 = 1.31 × 正文（比 1.35 再紧一点，让 100+ 行清单落在 2 页内）
  headRow: 6.75,  // 表头行高 = 1.35 × 表头
  pad: 1.3,       // 单元格内边距（图纸 mm）
  note: 4.0,      // 表尾注释预留（图纸 mm）
  top: 10,        // 表格距内框上边（图纸 mm）
  bottom: 8,      // 表格距内框下边（图纸 mm）
  side: 8,        // 表格距内框左右边（图纸 mm）
};
const BOQ_NAME_MIN = 120;  // 项目列最小宽（图纸 mm）
// TTF 字高语义：DXF/AutoCAD 的 TEXT 高度是 cap height。实测 SimSun（C:\Windows\Fonts\simsun.ttc，
// unitsPerEm=256 / sCapHeight=175）：汉字 advance = 1.463 cap，西文/数字 = 0.731 cap。
// 宽度估算与 SVG 呈现必须用同一系数，否则 CAD 里会“压字”（Lead 反馈的实际问题）。
const FONT_CAP_TO_EM = 1.463;

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────
function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function r3(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}
function allFinite(list) {
  for (const v of list) if (!Number.isFinite(Number(v))) return false;
  return true;
}
// 数字 → 字符串（最多 3 位小数，去掉多余 0）
function nf(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1000) / 1000;
  return String(r);
}
// 千分位整数（金额）
function fmtMoney(v) {
  const n = Math.round(num(v));
  const neg = n < 0;
  const s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? '-' + s : s;
}
// 定点小数
function fmtFixed(v, digits = 2) {
  const n = num(v);
  return n.toFixed(digits);
}
function pad2(n) {
  return String(n).padStart(2, '0');
}
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function normalizeDate(v) {
  const s = String(v == null ? '' : v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : todayLocal();
}
function isCjk(ch) {
  return /[\u2e80-\uffff]/.test(ch);
}
// 单字符 advance（模型 mm）：h 为 DXF 字高（cap height），换算见 FONT_CAP_TO_EM
function charAdvance(ch, h) {
  return (isCjk(ch) ? 1 : 0.5) * FONT_CAP_TO_EM * h;
}
// 估算文字宽度（模型毫米）：汉字 1 em、西文 0.5 em（均按 TTF cap-height 语义换算）
function textWidth(str, h) {
  let w = 0;
  for (const ch of String(str == null ? '' : str)) w += charAdvance(ch, h);
  return w;
}
// 按列宽截断（省略号），不裁切行
function fitText(str, maxW, h) {
  const s = String(str == null ? '' : str);
  if (!s || maxW <= 0) return '';
  if (textWidth(s, h) <= maxW) return s;
  const ellW = charAdvance('…', h);
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charAdvance(ch, h);
    if (w + cw + ellW > maxW) break;
    out += ch;
    w += cw;
  }
  return out ? out + '…' : '';
}
// 按宽度自动收缩字号：返回候选里第一个放得下的字高，都放不下取最小值
function shrinkHeight(str, maxW, candidates) {
  for (const h of candidates) if (textWidth(str, h) <= maxW) return h;
  return candidates[candidates.length - 1];
}
// 页 1/2 文字「比例归一」：以 1:50 为基准，den>50 时字高按 den/50 放大，
// 保证同一张 A2 纸面观感一致（如 1:100 时 180 模型 → 360 模型 = 3.6mm 纸面）。
// 纸面下限 2.5mm（= 2.5 × den 模型 mm）。页 3 表格本身按纸面 mm，不参与此换算。
function textNorm(layout) {
  const den = Math.max(1, num(layout && layout.den, 50));
  return { den, k: Math.max(1, den / 50), floor: 2.5 * den };
}
function normH(nominalModel, tn) {
  return Math.max(num(nominalModel) * tn.k, tn.floor);
}
function normCandidates(list, tn) {
  const out = (list || []).map((h) => num(h) * tn.k);
  out.push(tn.floor);
  return out;
}
function escXml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

// ─────────────────────────────────────────────────────────────────────────────
// 图面模型构建器（实体工厂，坐标一律模型毫米）
// ─────────────────────────────────────────────────────────────────────────────
function makeSheet({ id, name, no, layout }) {
  const entities = [];
  const push = (e) => {
    entities.push(e);
    return e;
  };
  const api = {
    id, name, no,
    paper: PAPER.A2.label,
    scaleDen: layout.den,
    frame: { x: r3(layout.frame.x), y: r3(layout.frame.y), w: r3(layout.frame.w), h: r3(layout.frame.h) },
    inner: { x: r3(layout.inner.x), y: r3(layout.inner.y), w: r3(layout.inner.w), h: r3(layout.inner.h) },
    entities,
    add: push,
    line(layer, x1, y1, x2, y2) {
      if (!allFinite([x1, y1, x2, y2])) return;
      push({ t: 'line', layer, x1: r3(x1), y1: r3(y1), x2: r3(x2), y2: r3(y2) });
    },
    poly(layer, pts, closed) {
      const p = (Array.isArray(pts) ? pts : [])
        .filter((q) => q && allFinite([q[0], q[1]]))
        .map((q) => [r3(q[0]), r3(q[1])]);
      if (p.length < 2) return;
      const e = { t: 'poly', layer, pts: p };
      if (closed) e.closed = true;
      push(e);
    },
    circle(layer, x, y, r) {
      if (!allFinite([x, y, r]) || !(r > 0)) return;
      push({ t: 'circle', layer, x: r3(x), y: r3(y), r: r3(r) });
    },
    text(layer, x, y, h, str, align, anchor) {
      const s = String(str == null ? '' : str).replace(/[\r\n\t]+/g, ' ').trim();
      if (!s || !allFinite([x, y, h]) || !(h > 0)) return;
      push({
        t: 'text', layer, x: r3(x), y: r3(y), h: r3(h), text: s,
        align: align === 'center' || align === 'right' ? align : 'left',
        anchor: anchor === 'middle' ? 'middle' : 'base',
      });
    },
    solid(layer, pts) {
      const p = (Array.isArray(pts) ? pts : [])
        .filter((q) => q && allFinite([q[0], q[1]]))
        .map((q) => [r3(q[0]), r3(q[1])]);
      if (p.length < 3) return;
      while (p.length < 4) p.push(p[p.length - 1].slice());
      push({ t: 'solid', layer, pts: p.slice(0, 4) });
    },
    rect(layer, x, y, w, h) {
      if (!allFinite([x, y, w, h]) || !(w > 0) || !(h > 0)) return;
      api.poly(layer, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true);
    },
  };
  return api;
}

// ── 图纸页布局（frame/inner 为模型毫米；P() 把图纸 mm 换算成模型 mm）──────────
function sheetLayout(den, index) {
  const s = Math.max(1, num(den, 100));
  const pw = PAPER.A2.w;
  const ph = PAPER.A2.h;
  const frameW = pw * s;
  const frameH = ph * s;
  const frame = { x: num(index, 0) * (frameW + SHEET_GAP), y: 0, w: frameW, h: frameH };
  const inner = {
    x: frame.x + MARGIN.left * s,
    y: frame.y + MARGIN.bottom * s,
    w: (pw - MARGIN.left - MARGIN.right) * s,
    h: (ph - MARGIN.top - MARGIN.bottom) * s,
  };
  const P = (mm) => num(mm) * s;
  // 平面图/点位图绘图区（标题栏上方，含尺寸线余量）
  const plot = {
    x: inner.x + P(8),
    y: inner.y + P(TITLE_H_MAX + 6),
    w: inner.w - P(16),
    h: inner.h - P(TITLE_H_MAX + 14),
  };
  return { s, den: s, frame, inner, plot, P };
}

// 自适应比例分母：A2 绘图区放得下就取最小比例
function pickScaleDen(plan) {
  const fitW = PAPER.A2.w - MARGIN.left - MARGIN.right - 16;                 // 543
  const fitH = PAPER.A2.h - MARGIN.top - MARGIN.bottom - TITLE_H_MAX - 14;  // 307
  const W = Math.max(1, num(plan.W, 12));
  const D = Math.max(1, num(plan.D, 12));
  for (const den of SCALE_CANDIDATES) {
    if ((W * 1000) / den + 24 <= fitW && (D * 1000) / den + 24 <= fitH) return den;
  }
  return SCALE_CANDIDATES[SCALE_CANDIDATES.length - 1];
}

// 标题栏行数：有估价摘要时多一行
function titleBlockRows(project) {
  return project && project.quoteSummary ? 7 : 6;
}
function titleBlockPaperH(project) {
  return TITLE_BLOCK.titleH + titleBlockRows(project) * TITLE_BLOCK.rowH;
}

// ─────────────────────────────────────────────────────────────────────────────
// 图框 + 标题栏 + 指北针
// ─────────────────────────────────────────────────────────────────────────────
function titleBlockFields(project, no, den) {
  const q = project.quoteSummary;
  const rows = [
    [['项目名', '口腔诊所方案'], ['门店类型', project.typeName]],
    [['平台', `${project.platformLabel} 平台`], ['风格', project.styleName]],
    [['面积', `${fmtFixed(project.area, 0)} ㎡`], ['椅位', `${fmtFixed(project.chairs, 0)} 椅`]],
    [['房间数', `${fmtFixed(project.roomCount, 0)} 间`], ['家具', `${fmtFixed(project.itemCount, 0)} 件`]],
    [['图号', no], ['比例', `1:${den}`]],
    [['日期', project.date], ['阶段', project.stage]],
  ];
  if (q) rows.push([['估价（元）', fmtMoney(q.total)], ['工时（人天）', fmtFixed(q.hours, 1)]]);
  return rows;
}

function drawTitleBlock(sh, layout, project, meta) {
  const { P, inner } = layout;
  const L = LN.frame;
  const rows = titleBlockRows(project);
  const H = titleBlockPaperH(project);       // 70 / 79 图纸 mm
  const fieldH = rows * TITLE_BLOCK.rowH;    // 54 / 63
  const tbW = P(TITLE_BLOCK.w);
  const tbH = P(H);
  const tbX = inner.x + inner.w - tbW;
  const tbY = inner.y;
  const bx = (u) => tbX + P(u);
  const by = (v) => tbY + P(v);
  sh.rect(L, tbX, tbY, tbW, tbH);
  // 图名与字段区分隔
  sh.line(L, bx(0), by(fieldH), bx(TITLE_BLOCK.w), by(fieldH));
  // 字段行线
  for (let r = 1; r < rows; r++) {
    sh.line(L, bx(0), by(r * TITLE_BLOCK.rowH), bx(TITLE_BLOCK.w), by(r * TITLE_BLOCK.rowH));
  }
  // 两栏 + 标签/值分隔
  sh.line(L, bx(100), by(0), bx(100), by(fieldH));
  for (const u of [26, 126]) sh.line(L, bx(u), by(0), bx(u), by(fieldH));
  // 图名（500 起，格子放不下时 400/320）
  const titleMaxW = P(TITLE_BLOCK.w) - P(10);
  const titleH = shrinkHeight(meta.title, titleMaxW, [TEXT.frameTitle, 400, 320]);
  sh.text(L, bx(100), by(fieldH + TITLE_BLOCK.titleH / 2), titleH, meta.title, 'center', 'middle');
  // 字段内容（标题栏格子按图纸 mm，字段字号随之按比例缩放，A2 纸面观感一致）
  const data = titleBlockFields(project, meta.no, layout.den);
  const labelH = P(2.3);
  const valueH = P(3.0);
  for (let r = 0; r < data.length && r < rows; r++) {
    const vCenter = fieldH - (r + 0.5) * TITLE_BLOCK.rowH;
    for (let c = 0; c < 2; c++) {
      const pair = data[r][c] || ['', ''];
      const u = c === 0 ? 2 : 102;
      sh.text(L, bx(u), by(vCenter), labelH, pair[0], 'left', 'middle');
      const maxValueW = P(74) - P(2);
      sh.text(L, bx(u + 26), by(vCenter), valueH, fitText(pair[1], maxValueW, valueH), 'left', 'middle');
    }
  }
}

function drawCompass(sh, layout) {
  const { P, inner } = layout;
  const cx = inner.x + inner.w - P(34);
  const cy = inner.y + inner.h - P(30);
  const r = P(9);
  sh.circle(LN.frame, cx, cy, r);
  sh.solid(LN.frame, [
    [cx, cy + r * 0.82],
    [cx - r * 0.3, cy - r * 0.45],
    [cx + r * 0.3, cy - r * 0.45],
  ]);
  sh.text(LN.frame, cx, cy + r + P(3.5), P(2.6), 'N', 'center', 'middle');
}

function drawFrame(sh, layout, project, meta) {
  sh.rect(LN.frame, layout.frame.x, layout.frame.y, layout.frame.w, layout.frame.h);
  sh.rect(LN.frame, layout.inner.x, layout.inner.y, layout.inner.w, layout.inner.h);
  if (meta.compass) drawCompass(sh, layout);
  drawTitleBlock(sh, layout, project, meta);
  if (meta.note) {
    sh.text(LN.legend, layout.inner.x + layout.P(10), layout.inner.y + layout.P(5),
      layout.P(2.4), meta.note, 'left', 'middle');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 墙体真值（复刻 js/scene.js#_buildShell）
// ─────────────────────────────────────────────────────────────────────────────
function splitSegments(a, b, openings) {
  const list = (Array.isArray(openings) ? openings : [])
    .map((o) => ({ at: num(o.at), w: num(o.w) }))
    .filter((o) => Number.isFinite(o.at) && Number.isFinite(o.w) && o.w > 0)
    .sort((p, q) => p.at - q.at);
  if (!list.length) return [{ start: a, end: b, open: false }];
  const out = [];
  let cur = a;
  for (const o of list) {
    const s0 = Math.max(a, o.at - o.w / 2);
    const s1 = Math.min(b, o.at + o.w / 2);
    if (s1 <= s0) continue;
    if (s0 > cur) out.push({ start: cur, end: s0, open: false });
    out.push({ start: s0, end: s1, open: true });
    cur = Math.max(cur, s1);
  }
  if (cur < b) out.push({ start: cur, end: b, open: false });
  return out;
}

// 收集墙线段：{ o:'h'|'v', c: 中心线坐标, a..b: 范围, ext: 外墙? }
function wallSegments(plan) {
  const W = plan.W;
  const D = plan.D;
  const usableW = plan.usableW;
  const out = [];
  const addH = (z, x1, x2, openings, ext) => {
    for (const s of splitSegments(x1, x2, openings)) {
      if (!s.open && s.end - s.start > 0.002) out.push({ o: 'h', c: z, a: s.start, b: s.end, ext: !!ext });
    }
  };
  const addV = (x, z1, z2, openings, ext) => {
    for (const s of splitSegments(z1, z2, openings)) {
      if (!s.open && s.end - s.start > 0.002) out.push({ o: 'v', c: x, a: s.start, b: s.end, ext: !!ext });
    }
  };
  const rooms = plan.rooms || [];
  const doorOpen = (list) => list.map((r) => ({ at: r.door ? r.door.x : 0, w: r.door ? r.door.w : 0 }));

  // 外墙：前立面含玻璃带 + 入口洞
  const entranceX = plan.entranceX;
  const frontGlass = [
    { at: entranceX - 2.7, w: 3.6 },
    { at: entranceX + 2.7, w: 3.6 },
  ];
  const entranceOpen = [{ at: entranceX, w: plan.entranceW }];
  addH(0, 0, W, [...frontGlass, ...entranceOpen], true);
  addH(D, 0, W, [], true);
  addV(0, 0, D, [], true);
  addV(W, 0, D, [], true);

  // 内墙
  const rowARooms = rooms.filter((r) => r.zone === 'rowA');
  const rowBRooms = rooms.filter((r) => r.zone === 'rowB');
  const backRooms = rooms.filter((r) => r.zone === 'back');
  addH(plan.frontD, 0, usableW, [], false);
  addH(plan.corrAz, 0, usableW, doorOpen(rowARooms), false);
  addH(plan.corrAz + plan.corrAd, 0, usableW, doorOpen(rowBRooms), false);
  if (plan.backd > 0) {
    addH(plan.corrBz + plan.corrBd, 0, usableW, doorOpen(backRooms), false);
    addH(plan.corrBz, 0, usableW, [], false);
  }
  for (const zone of ['rowA', 'rowB', 'back']) {
    const list = rooms.filter((r) => r.zone === zone);
    if (!list.length) continue;
    const z0 = list[0].z;
    const z1 = z0 + list[0].d;
    for (let i = 1; i < list.length; i++) addV(list[i].x, z0, z1, [], false);
    addV(usableW, z0, z1, [], false);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 平面布置图（页 1）
// ─────────────────────────────────────────────────────────────────────────────
function planFrameOf(plan, layout) {
  const { plot } = layout;
  const pw = plan.W * 1000;
  const ph = plan.D * 1000;
  const ox = plot.x + (plot.w - pw) / 2;
  const oy = plot.y + (plot.h - ph) / 2;
  return {
    ox, oy, pw, ph,
    X: (x) => ox + num(x) * 1000,          // 米 → 模型毫米
    Y: (z) => oy + (plan.D - num(z)) * 1000,
  };
}

function drawPlanWalls(sh, plan, pf) {
  const half = WALL_T / 2;
  for (const s of wallSegments(plan)) {
    const layer = s.ext ? LN.ext : LN.int;
    if (s.o === 'h') {
      const y = pf.Y(s.c);
      const x1 = pf.X(s.a);
      const x2 = pf.X(s.b);
      sh.line(layer, x1, y - half, x2, y - half);
      sh.line(layer, x1, y + half, x2, y + half);
      sh.line(layer, x1, y - half, x1, y + half);
      sh.line(layer, x2, y - half, x2, y + half);
    } else {
      const x = pf.X(s.c);
      const y1 = pf.Y(s.a);
      const y2 = pf.Y(s.b);
      sh.line(layer, x - half, y1, x - half, y2);
      sh.line(layer, x + half, y1, x + half, y2);
      sh.line(layer, x - half, y1, x + half, y1);
      sh.line(layer, x - half, y2, x + half, y2);
    }
  }
}

// 前立面：玻璃带 + 幕墙竖框 + 入口推拉门 + 入口箭头/文字
function drawFacade(sh, plan, pf, layout, tn) {
  const { P } = layout;
  const T = tn || { den: 50, k: 1, floor: 125 };
  const yWall = pf.Y(0);
  const entranceX = plan.entranceX;
  const entranceW = plan.entranceW;
  // 玻璃带（双线）
  for (const g of [{ at: entranceX - 2.7, w: 3.6 }, { at: entranceX + 2.7, w: 3.6 }]) {
    const x1 = pf.X(g.at - g.w / 2);
    const x2 = pf.X(g.at + g.w / 2);
    if (x2 - x1 < 1) continue;
    sh.line(LN.ext, x1, yWall - 32, x2, yWall - 32);
    sh.line(LN.ext, x1, yWall + 32, x2, yWall + 32);
  }
  // 幕墙竖框（scene.js frameXs）
  for (const dx of [-4.5, -2.7, -0.9, 0.9, 2.7, 4.5]) {
    const fx = entranceX + dx;
    if (fx < 0.05 || fx > plan.W - 0.05) continue;
    const x = pf.X(fx);
    sh.line(LN.ext, x, yWall - WALL_T / 2, x, yWall + WALL_T / 2);
  }
  // 入口推拉门（两扇错位）
  const ex0 = pf.X(entranceX - entranceW / 2);
  const ex1 = pf.X(entranceX + entranceW / 2);
  const mid = (ex0 + ex1) / 2;
  const half = WALL_T / 2;
  sh.rect(LN.door, ex0, yWall - half, mid - ex0, half);   // 内侧扇
  sh.rect(LN.door, mid, yWall, ex1 - mid, half);          // 外侧扇
  // 入口箭头 + 文字（自室外指向室内）
  const ax = pf.X(entranceX);
  sh.line(LN.dim, ax, yWall + P(9), ax, yWall - P(7));
  const tipY = yWall - P(10);
  sh.solid(LN.dim, [
    [ax, tipY],
    [ax - P(2.4), tipY + P(4)],
    [ax + P(2.4), tipY + P(4)],
  ]);
  sh.text(LN.dim, ax, yWall + P(12.5), normH(TEXT.roomName, T), '入口', 'center', 'middle');
}

// 门扇 45° + 开启弧（弧用折线近似，步长 15°）
function drawDoors(sh, plan, pf) {
  for (const room of plan.rooms || []) {
    const dr = room.door;
    if (!dr || !Number.isFinite(num(dr.x)) || !(num(dr.w) > 0)) continue;
    const into = dr.side === 'north' ? 1 : -1;      // north → 洞口在 z+d 墙
    const sillZ = dr.side === 'north' ? room.z + room.d : room.z;
    const r = num(dr.w) * 1000;
    const hingeX = pf.X(num(dr.x) - num(dr.w) / 2);
    const hingeY = pf.Y(sillZ) + into * (WALL_T / 2);
    const a1 = into > 0 ? Math.PI / 4 : -Math.PI / 4;
    const tipX = hingeX + r * Math.cos(a1);
    const tipY = hingeY + r * Math.sin(a1);
    sh.line(LN.door, hingeX, hingeY, tipX, tipY);
    const steps = 3;
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const a = (a1 * i) / steps;
      pts.push([hingeX + r * Math.cos(a), hingeY + r * Math.sin(a)]);
    }
    sh.poly(LN.door, pts, false);
  }
}

// 计算单个房间的三行文字块（名称 / 净尺寸 / 面积），返回模型坐标与字高（家具标签避让共用）
// tn = 比例归一字高换算（1:50 时 k=1，与原先完全一致）
function roomLabelBlock(room, pf, tn) {
  const T = tn || { den: 50, k: 1, floor: 125 };
  const w = num(room.w);
  const d = num(room.d);
  if (!(w > 0) || !(d > 0)) return null;
  const cx = pf.X(num(room.x) + w / 2);
  const cy = pf.Y(num(room.z) + d / 2);
  const wMm = w * 1000;
  // 房间名：宽度上限 = min(净宽 - 300, 净宽 82%)；候选字高按比例归一 + 2.5mm 纸面下限
  const nameCands = normCandidates(NAME_H_CANDIDATES, T);
  const nameLimit = Math.min(wMm - 300, wMm * 0.82);
  let name = String(room.name == null ? '' : room.name);
  let nameH = Math.max(shrinkHeight(name, nameLimit, nameCands), T.floor);
  if (textWidth(name, nameH) > nameLimit) {
    const stripped = name.replace(/\s*\d+$/, '').trim();
    if (stripped && stripped !== name) {
      name = stripped;
      nameH = Math.max(shrinkHeight(name, nameLimit, nameCands), T.floor);
    }
  }
  // 极端窄房兜底：仍超出净宽就截断，绝不打到邻间
  if (textWidth(name, nameH) > wMm - 100) name = fitText(name, wMm - 100, nameH);
  if (!name) return null;
  // 尺寸 / 面积：同候选序列，两行取同字高（较小者），且不超过房间名字高（在窄房里保持文字层级），
  // 下限 2.5mm 纸面。说明：1:100 时房间名受净宽限制，尺寸/面积也随之收敛，不会大过房间名。
  const subCands = normCandidates(SUB_H_CANDIDATES, T);
  const subLimit = Math.max(600, Math.min(wMm - 220, wMm * 0.82));
  const dimsText = `${w.toFixed(2)}×${d.toFixed(2)}`;
  const areaText = `${(w * d).toFixed(1)}㎡`;
  const subH = Math.max(
    Math.min(shrinkHeight(dimsText, subLimit, subCands), shrinkHeight(areaText, subLimit, subCands), nameH),
    T.floor,
  );
  const nameG = nameH * FONT_CAP_TO_EM;
  const subG = subH * FONT_CAP_TO_EM;
  const roomD = d * 1000;
  let gap = Math.max(0.18 * nameG, 40 * T.k);
  let total = nameG + 2 * subG + 2 * gap;
  if (total > roomD - 200) {
    gap = Math.max(0, (roomD - 200 - nameG - 2 * subG) / 2);
    total = nameG + 2 * subG + 2 * gap;
  }
  const nameY = cy + total / 2 - nameG / 2;
  const dimsY = nameY - nameG / 2 - gap - subG / 2;
  const areaY = dimsY - subG / 2 - gap - subG / 2;
  // 逐行包围盒（家具标签避让用，比整体外接框更精确）
  const rowRect = (text, h, y) => {
    const wLine = textWidth(text, h);
    return { x0: cx - wLine / 2, x1: cx + wLine / 2, y0: y - (h * FONT_CAP_TO_EM) / 2, y1: y + (h * FONT_CAP_TO_EM) / 2 };
  };
  const rows = [rowRect(name, nameH, nameY), rowRect(dimsText, subH, dimsY), rowRect(areaText, subH, areaY)];
  const blockW = Math.max(textWidth(name, nameH), textWidth(dimsText, subH), textWidth(areaText, subH));
  return {
    cx, name, nameH, nameY, dimsText, dimsH: subH, dimsY, areaText, areaH: subH, areaY, rows,
    block: { x0: cx - blockW / 2, x1: cx + blockW / 2, y0: areaY - subG / 2, y1: nameY + nameG / 2 },
  };
}

function rectsIntersect(a, b) {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function drawRoomLabels(sh, plan, pf, blocks, tn) {
  const T = tn || { den: 50, k: 1, floor: 125 };
  for (const room of plan.rooms || []) {
    if (room.kind === 'corridor') continue;
    const b = blocks ? blocks.get(room.id) : roomLabelBlock(room, pf, T);
    if (!b) continue;
    sh.text(LN.text, b.cx, b.nameY, b.nameH, b.name, 'center', 'middle');
    sh.text(LN.text, b.cx, b.dimsY, b.dimsH, b.dimsText, 'center', 'middle');
    sh.text(LN.text, b.cx, b.areaY, b.areaH, b.areaText, 'center', 'middle');
  }
  // 走廊 / 竖向通道（字高按比例归一）
  if (num(plan.corrAd) > 0) {
    sh.text(LN.text, pf.X(Math.max(0.8, plan.usableW * 0.5)), pf.Y(plan.corrAz + plan.corrAd / 2) + 160 * T.k,
      normH(300, T), '公共走廊', 'center', 'middle');
  }
  if (num(plan.conn) > 0) {
    sh.text(LN.text, pf.X((plan.usableW + plan.W) / 2), pf.Y((plan.frontD + plan.D) / 2),
      normH(250, T), '通道', 'center', 'middle');
  }
}

// 家具名标签可用净宽（模型毫米）：优先用件自带的 clamp 区，其次所在房间
function roomWidthOf(plan, it) {
  if (Array.isArray(it.clamp) && it.clamp.length >= 4) {
    return Math.max(0, (num(it.clamp[2]) - num(it.clamp[0])) * 1000);
  }
  const room = (plan.rooms || []).find((r) => r.id === it.room);
  if (room && num(room.w) > 0) return num(room.w) * 1000;
  return plan.W * 1000;
}

function drawFurniture(sh, plan, pf, nameOf, labelBlocks, tn) {
  const T = tn || { den: 50, k: 1, floor: 125 };
  const placedLabels = new Map();   // roomId → [已放置标签矩形]
  for (const it of plan.items || []) {
    if (!it || it.mount === 'ceiling') continue;
    const fp = footprintOf(it.asset);
    const w = num(fp.w) * 1000;
    const d = num(fp.d) * 1000;
    if (!(w > 0) || !(d > 0)) continue;
    const rot = (num(it.rotY) * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const cx = pf.X(it.x);
    const cy = pf.Y(it.z);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => {
      const lx = (sx * w) / 2;
      const lz = (sz * d) / 2;
      const px = lx * cos + lz * sin;   // three.js 绕 Y 旋转
      const pz = -lx * sin + lz * cos;
      return [cx + px, cy - pz];        // 模型 Y 与 plan z 反向
    });
    sh.poly(LN.furn, corners, true);
    // 名称标签：只给 max(w,d) ≥ 1.6m 的大件（牙椅/接待台/长椅/沙发…）
    if (Math.max(w, d) < 1600) continue;
    const name = nameOf(it.asset);
    if (!name) continue;
    const room = (plan.rooms || []).find((r) => r.id === it.room);
    if (!room || room.kind === 'corridor') continue;     // 走廊/通道留白，不放标签
    const roomW = roomWidthOf(plan, it);
    // 字高按比例归一（1:50=180，1:100=360），但不超房间可用宽度的 85%，且不低于 2.5mm 纸面
    const perUnit = Math.max(1e-6, textWidth(name, 1));
    const labelBase = TEXT.furniture * T.k;
    const fitH = (roomW * 0.85) / perUnit;
    let labelH;
    if (fitH >= labelBase) {
      labelH = labelBase;
    } else {
      if (T.k <= 1) continue;                    // 1:50：保持原「宁缺不压字」判断，行为完全不变
      labelH = Math.max(T.floor, fitH);          // 1:100：允许缩到房间放得下（不低于 2.5mm 纸面）
    }
    const labelW = textWidth(name, labelH);
    if (labelW > roomW - 100) continue;          // 真放不下 → 宁缺不压字
    const labelG = labelH * FONT_CAP_TO_EM;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of corners) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
    // 标签放在「朝向房间内侧」的一边：件在房间上半（贴远墙）→ 放下方，反之放上方
    const roomCenterY = pf.Y(num(room.z) + num(room.d) / 2);
    const itemCenterY = (minY + maxY) / 2;
    const below = itemCenterY >= roomCenterY;
    const offset = 80 * T.k + labelG / 2;
    const clampM = 120 * T.k;
    let lx = (minX + maxX) / 2;
    let ly = below ? minY - offset : maxY + offset;
    // clamp 到房间内
    const roomX0 = pf.X(num(room.x));
    const roomX1 = pf.X(num(room.x) + num(room.w));
    const roomY0 = pf.Y(num(room.z) + num(room.d));
    const roomY1 = pf.Y(num(room.z));
    const halfW = labelW / 2;
    const halfH = labelG / 2;
    if (roomX1 - roomX0 < labelW + 2 * clampM) continue;
    lx = Math.min(Math.max(lx, roomX0 + halfW + clampM), roomX1 - halfW - clampM);
    if (roomY1 - roomY0 < labelG + 2 * clampM) continue;
    ly = Math.min(Math.max(ly, roomY0 + halfH + clampM), roomY1 - halfH - clampM);
    // 与房间名/尺寸/面积逐行文字框冲突时跳过；每间诊室最多 2 个标签、其它房间最多 4 个
    const lb = labelBlocks && labelBlocks.get(room.id);
    const rect = { x0: lx - halfW, x1: lx + halfW, y0: ly - halfH, y1: ly + halfH };
    if (lb && (lb.rows || [lb.block]).some((r) => r && rectsIntersect(rect, r))) continue;
    const placed = placedLabels.get(room.id) || [];
    if (placed.length >= (room.kind === 'clinic' ? 2 : 4)) continue;
    const clash = placed.some((r) => rectsIntersect(rect, {
      x0: r.x0 - 60 * T.k, x1: r.x1 + 60 * T.k, y0: r.y0 - 60 * T.k, y1: r.y1 + 60 * T.k,
    }));
    if (clash) continue;
    placed.push(rect);
    placedLabels.set(room.id, placed);
    sh.text(LN.text, lx, ly, labelH, name, 'center', 'middle');
  }
}

// 尺寸标注工具
function dimArrow(sh, x, y, dx, dy, size) {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const bx = x - ux * size;
  const by = y - uy * size;
  const px = -uy * size * 0.3;
  const py = ux * size * 0.3;
  sh.solid(LN.dim, [[x, y], [bx + px, by + py], [bx - px, by - py]]);
}

function dimHorizontal(sh, layout, x1, x2, yRef, yDim, label, hText) {
  const { P } = layout;
  const h = Math.max(1, num(hText, TEXT.dim));
  const g = h * FONT_CAP_TO_EM;
  sh.line(LN.dim, x1, yRef, x1, yDim - P(3));
  sh.line(LN.dim, x2, yRef, x2, yDim - P(3));
  sh.line(LN.dim, x1, yDim, x2, yDim);
  dimArrow(sh, x1, yDim, -1, 0, P(2.5));
  dimArrow(sh, x2, yDim, 1, 0, P(2.5));
  sh.text(LN.dim, (x1 + x2) / 2, yDim + g / 2 + P(1.2), h, label, 'center', 'middle');
}

function dimVertical(sh, layout, y1, y2, xRef, xDim, label, textSide, hText) {
  const { P } = layout;
  const h = Math.max(1, num(hText, TEXT.dim));
  sh.line(LN.dim, xRef, y1, xDim + (textSide > 0 ? -P(3) : P(3)), y1);
  sh.line(LN.dim, xRef, y2, xDim + (textSide > 0 ? -P(3) : P(3)), y2);
  sh.line(LN.dim, xDim, y1, xDim, y2);
  dimArrow(sh, xDim, y1, 0, 1, P(2.5));
  dimArrow(sh, xDim, y2, 0, -1, P(2.5));
  if (textSide > 0) {
    sh.text(LN.dim, xDim + P(3.4), (y1 + y2) / 2, h, label, 'left', 'middle');
  } else {
    sh.text(LN.dim, xDim - P(3.4), (y1 + y2) / 2, h, label, 'right', 'middle');
  }
}

function drawDimensions(sh, plan, pf, layout, tn) {
  const { P } = layout;
  const T = tn || { den: 50, k: 1, floor: 125 };
  const hDim = normH(TEXT.dim, T);
  const ox = pf.ox;
  const oy = pf.oy;
  // 底部总体 W
  dimHorizontal(sh, layout, ox, ox + plan.W * 1000, oy - WALL_T / 2, oy - P(9),
    `${Math.round(plan.W * 1000)}`, hDim);
  // 左侧总体 D
  dimVertical(sh, layout, pf.Y(0), pf.Y(plan.D), ox - WALL_T / 2, ox - P(9),
    `${Math.round(plan.D * 1000)}`, -1, hDim);
  // 走廊净宽 corrAd（右侧）
  if (num(plan.corrAd) > 0) {
    const xRef = ox + plan.W * 1000;
    dimVertical(sh, layout, pf.Y(plan.corrAz), pf.Y(plan.corrAz + plan.corrAd), xRef, xRef + P(9),
      `${Math.round(plan.corrAd * 1000)}`, 1, hDim);
  }
}

function buildPlanSheet(plan, project, layout, opts) {
  const sh = makeSheet({ id: 'plan', name: '平面布置图', no: 'ADS-01-01', layout });
  drawFrame(sh, layout, project, {
    title: '平面布置图',
    no: sh.no,
    compass: true,
    note: '单位：mm',
  });
  const pf = planFrameOf(plan, layout);
  const tn = textNorm(layout);            // 页 1/2 文字比例归一（1:50 时 k=1 不变）
  drawPlanWalls(sh, plan, pf);
  drawFacade(sh, plan, pf, layout, tn);
  drawDoors(sh, plan, pf);
  const nameOf = (id) => {
    const m = opts && opts.meta;
    if (m && typeof m.nameOf === 'function') {
      const n = m.nameOf(id);
      if (n) return String(n);
    }
    return String(id || '');
  };
  // 房间名/尺寸/面积文字块先算出来，供房间标签绘制与家具标签避让共用
  const labelBlocks = new Map();
  for (const room of plan.rooms || []) {
    if (room.kind === 'corridor') continue;
    const b = roomLabelBlock(room, pf, tn);
    if (b) labelBlocks.set(room.id, b);
  }
  drawFurniture(sh, plan, pf, nameOf, labelBlocks, tn);
  drawRoomLabels(sh, plan, pf, labelBlocks, tn);
  drawDimensions(sh, plan, pf, layout, tn);
  return sh;
}

// ─────────────────────────────────────────────────────────────────────────────
// 机电点位图（页 2）
// ─────────────────────────────────────────────────────────────────────────────
// 硬点符号确定性去重叠（不引入随机）：
//   1) 按 (x,z[,kind]) 排序后顺序放置；
//   2) 若与已放符号圆心距 < minDist，则以原始点位为中心、80mm 为步距逐圈搜索（每圈 24 个方向，15° 一步），
//      取第一个满足 minDist 的位置（保持紧凑、不跨房乱飞）；
//   3) 仍找不到才退回原位（兜底，正常不会发生）。
// 结果保证任意两符号圆心距 ≥ minDist（模型 mm）。图例计数与颜色/图层仍用原始点位统计。
function layoutHardPoints(points, minDist) {
  const need = num(minDist, 420) / 1000;   // 模型毫米 → 米
  const step = 0.08;                        // 每圈步距 80 模型 mm
  const list = (Array.isArray(points) ? points : [])
    .filter((p) => p && Number.isFinite(num(p.x)) && Number.isFinite(num(p.z)))
    .map((p, i) => ({ x: num(p.x), z: num(p.z), kind: String(p.kind || ''), i }))
    .sort((a, b) => (a.x - b.x) || (a.z - b.z) || (a.kind < b.kind ? -1 : (a.kind > b.kind ? 1 : 0)) || (a.i - b.i));
  const placed = [];
  const freeAt = (x, z) => {
    for (const p of placed) if (Math.hypot(p.x - x, p.z - z) < need) return false;
    return true;
  };
  for (const p of list) {
    if (freeAt(p.x, p.z)) {
      placed.push({ x: p.x, z: p.z, kind: p.kind });
      continue;
    }
    let hit = null;
    for (let ring = 1; ring <= 40 && !hit; ring++) {
      const r = step * ring;
      for (let a = 0; a < 24; a++) {
        const ang = (a * 15 * Math.PI) / 180;
        const x = p.x + r * Math.cos(ang);
        const z = p.z + r * Math.sin(ang);
        if (freeAt(x, z)) {
          hit = { x, z };
          break;
        }
      }
    }
    placed.push(hit ? { x: hit.x, z: hit.z, kind: p.kind } : { x: p.x, z: p.z, kind: p.kind });
  }
  return placed;
}

function drawMepLegend(sh, layout, project, counts, tn) {
  const { P, inner } = layout;
  const T = tn || { den: 50, k: 1, floor: 125 };
  const symR = Math.max(180 * T.k, T.floor * 0.5);
  const symH = normH(180, T);
  const rowsData = [];
  for (const id of ['water', 'power', 'gas', 'drain', 'net']) {
    const k = HARD_KIND[id] || {};
    rowsData.push({ kind: id, name: HARD_LABEL[id] || k.name || id, char: k.name || HARD_LABEL[id] || '', count: num(counts[id], 0) });
  }
  const total = rowsData.reduce((a, r) => a + r.count, 0);
  rowsData.push({ kind: '', name: '合计', char: '', count: total });
  const W = 100;
  const headH = 10;
  const rowH = 9;
  const H = headH + rowsData.length * rowH;
  const x0 = inner.x + inner.w - P(8 + W);
  const y0 = inner.y + P(titleBlockPaperH(project) + 8);
  const bx = (u) => x0 + P(u);
  const by = (v) => y0 + P(v);
  sh.rect(LN.legend, x0, y0, P(W), P(H));
  // 列线
  sh.line(LN.legend, bx(34), by(0), bx(34), by(H));
  sh.line(LN.legend, bx(66), by(0), bx(66), by(H));
  // 表头
  sh.line(LN.legend, bx(0), by(H - headH), bx(W), by(H - headH));
  const headY = H - headH / 2;
  const headTextH = P(3.0);
  const bodyTextH = P(2.5);
  sh.text(LN.legend, bx(17), by(headY), headTextH, '类目', 'center', 'middle');
  sh.text(LN.legend, bx(50), by(headY), headTextH, '符号', 'center', 'middle');
  sh.text(LN.legend, bx(83), by(headY), headTextH, '数量', 'center', 'middle');
  // 行
  rowsData.forEach((r, i) => {
    const vCenter = H - headH - (i + 0.5) * rowH;
    if (i < rowsData.length - 1) {
      sh.line(LN.legend, bx(0), by(H - headH - (i + 1) * rowH), bx(W), by(H - headH - (i + 1) * rowH));
    }
    sh.text(LN.legend, bx(2), by(vCenter), bodyTextH, r.name, 'left', 'middle');
    if (r.kind) {
      // 图例符号与点位符号同尺寸（r=180×k / 字 180×k），颜色与图层沿用硬点五类
      const layer = HARD_LAYER[r.kind] || LN.legend;
      sh.circle(layer, bx(50), by(vCenter), symR);
      sh.text(layer, bx(50), by(vCenter), symH, r.char, 'center', 'middle');
    }
    sh.text(LN.legend, bx(96), by(vCenter), bodyTextH, String(r.count), 'right', 'middle');
  });
}

function buildMepSheet(plan, project, layout, opts) {
  const sh = makeSheet({ id: 'mep', name: '机电点位图', no: 'ADS-02-01', layout });
  drawFrame(sh, layout, project, {
    title: '机电点位图',
    no: sh.no,
    compass: false,
    note: '单位：mm',
  });
  const pf = planFrameOf(plan, layout);
  const tn = textNorm(layout);   // 页 2 文字/符号比例归一（1:50 时 k=1 不变）
  // 墙线单线：与平面布置图同一套墙段（外墙 4 边 + 入口洞 + 内墙 + 走廊/通道隔墙）
  for (const s of wallSegments(plan)) {
    const layer = s.ext ? LN.ext : LN.int;
    if (s.o === 'h') sh.line(layer, pf.X(s.a), pf.Y(s.c), pf.X(s.b), pf.Y(s.c));
    else sh.line(layer, pf.X(s.c), pf.Y(s.a), pf.X(s.c), pf.Y(s.b));
  }
  // 房间名：统一放在房间上沿内侧（room.z + 300），不再画房间轮廓
  const nameCands = normCandidates([250, 220, 200, 180], tn);
  for (const room of plan.rooms || []) {
    if (room.kind === 'corridor') continue;
    const w = num(room.w);
    const d = num(room.d);
    if (!(w > 0) || !(d > 0)) continue;
    const cx = pf.X(num(room.x) + w / 2);
    const cy = pf.Y(num(room.z) + 0.3);
    const nameLimit = Math.min(w * 1000 - 200, w * 1000 * 0.9);
    let nameH = Math.max(shrinkHeight(room.name, nameLimit, nameCands), tn.floor);
    if (textWidth(room.name, nameH) > w * 1000 - 100) nameH = tn.floor;
    sh.text(LN.text, cx, cy, nameH, room.name, 'center', 'middle');
  }
  // 五类硬点：符号 r=180×k（1:100 时 r=360，纸面 ⌀7.2mm 不变）、圈内字 180×k；
  // 去重叠圆心距 = 2r + 60（1:50 时正好 420，与上一轮一致；1:100 时 780，纸面间距保持不变）
  const symR = Math.max(180 * tn.k, tn.floor * 0.5);
  const symH = normH(180, tn);
  const minDist = 2 * symR + 60;
  const counts = { water: 0, power: 0, gas: 0, drain: 0, net: 0 };
  for (const p of plan.hardPoints || []) {
    if (p && Object.prototype.hasOwnProperty.call(counts, String(p.kind))) counts[String(p.kind)] += 1;
  }
  const pts = layoutHardPoints(plan.hardPoints || [], minDist);
  for (const p of pts) {
    const layer = HARD_LAYER[p.kind];
    if (!layer) continue;
    const x = pf.X(p.x);
    const y = pf.Y(p.z);
    sh.circle(layer, x, y, symR);
    const k = HARD_KIND[p.kind] || {};
    sh.text(layer, x, y, symH, k.name || HARD_LABEL[p.kind] || '', 'center', 'middle');
  }
  drawMepLegend(sh, layout, project, counts, tn);
  void opts;
  return sh;
}

// ─────────────────────────────────────────────────────────────────────────────
// 工程量与估价表（页 3，仅在 opts.boq 存在时生成）
// ─────────────────────────────────────────────────────────────────────────────
function isTaxName(name) {
  return /税/.test(String(name || ''));
}

function boqGroupKey(line) {
  const g = line && (line.group != null ? line.group : line.groupName);
  const s = String(g == null ? '' : g).trim();
  return s || '工程量清单';
}

function buildBoqRows(boq) {
  const q = boq && typeof boq === 'object' ? boq : {};
  const lines = (Array.isArray(q.lines) ? q.lines : []).filter((l) => l && typeof l === 'object');
  const groups = (Array.isArray(q.groups) ? q.groups : []).filter((g) => g && typeof g === 'object');
  const groupNames = [];
  for (const g of groups) {
    const n = String(g.name != null ? g.name : (g.id || '')).trim();
    if (n && !groupNames.includes(n)) groupNames.push(n);
  }
  for (const l of lines) {
    const n = boqGroupKey(l);
    if (n && !groupNames.includes(n)) groupNames.push(n);
  }
  const rows = [];
  let seq = 0;
  for (const gname of groupNames) {
    if (isTaxName(gname)) continue;                       // 税金在表尾单列
    const gl = lines.filter((l) => boqGroupKey(l) === gname);
    const g = groups.find((x) => String(x.name != null ? x.name : (x.id || '')).trim() === gname) || {};
    const amount = num(g.amount, gl.reduce((a, l) => a + num(l.amount), 0));
    const hours = num(g.hours, gl.reduce((a, l) => a + num(l.hours), 0));
    if (!gl.length && !amount && !hours) continue;
    rows.push({ kind: 'group', name: gname });
    for (const l of gl) {
      seq += 1;
      rows.push({
        kind: 'line', no: String(seq),
        name: String(l.name != null ? l.name : (l.item || '')),
        spec: String(l.spec != null ? l.spec : (l.note || '')),
        unit: String(l.unit != null ? l.unit : ''),
        qty: num(l.qty), price: num(l.price), amount: num(l.amount), hours: num(l.hours),
      });
    }
    rows.push({ kind: 'subtotal', amount, hours });
  }
  return { rows, groups, lines };
}

function buildBoqTailRows(boq) {
  const q = boq && typeof boq === 'object' ? boq : {};
  const totals = q.totals && typeof q.totals === 'object' ? q.totals : {};
  const labor = q.labor && typeof q.labor === 'object' ? q.labor : {};
  const rows = [];
  rows.push({ kind: 'tail', label: '合计（不含税）', value: fmtMoney(totals.subtotal) });
  rows.push({ kind: 'tail', label: '税金', value: fmtMoney(totals.tax) });
  rows.push({ kind: 'tail', label: '总计', value: fmtMoney(totals.total), strong: true });
  rows.push({
    kind: 'pair',
    left: { label: '单方造价（元/㎡）', value: fmtMoney(totals.perArea) },
    right: { label: '每椅造价（元/椅）', value: fmtMoney(totals.perChair) },
  });
  rows.push({
    kind: 'pair',
    left: { label: '总工时（人天）', value: fmtFixed(labor.totalHours, 1) },
    right: { label: '工期（天）', value: fmtFixed(labor.calendarDays, 0) },
  });
  rows.push({
    kind: 'words', label: '金额大写',
    value: String(totals.amountInWords != null && totals.amountInWords !== '' ? totals.amountInWords : '—'),
  });
  return rows;
}

// 分页：不裁切任何行；分组标题不落单在页末
function paginateBoq(rows, capacity) {
  const cap = Math.max(4, Math.floor(num(capacity, 40)));
  const pages = [];
  let idx = 0;
  let guard = 0;
  while (idx < rows.length && guard++ < 1000) {
    const pageRows = [];
    while (pageRows.length < cap && idx < rows.length) {
      pageRows.push(rows[idx]);
      idx += 1;
    }
    // 页末若是分组标题（后面还有行），挪到下一页，避免孤行
    if (pageRows.length && pageRows[pageRows.length - 1].kind === 'group' && idx < rows.length) {
      idx -= 1;
      pageRows.pop();
      if (!pageRows.length) {
        pageRows.push(rows[idx]);
        idx += 1;
      }
    }
    if (!pageRows.length) break;
    pages.push(pageRows);
  }
  return pages;
}

// 表页版式：表宽铺满内框（内框宽 - 两侧 8mm），项目/规格列按剩余空间自适应；
// 表格底边在与标题栏 x 区间相交时停到标题栏上沿以上，避免与标题栏重叠。
// 所有表格尺寸按「图纸 mm × 比例」，M(1:50) / L(1:100) 在 A2 纸面观感一致（1:50 时正文 = 180 模型 mm）。
function boqTableLayout(layout, allRows, project) {
  const { P, inner, s } = layout;
  const bodyH = P(BOQ_PAPER.body);        // 正文字高（模型 mm）
  const strongH = P(BOQ_PAPER.strong);    // 强调行字高（模型 mm）
  const headH = P(BOQ_PAPER.head);        // 表头字高（模型 mm）
  const rowH = P(BOQ_PAPER.row);          // 行高
  const headRowH = P(BOQ_PAPER.headRow);  // 表头行高
  const pad = P(BOQ_PAPER.pad);           // 单元格内边距（模型 mm）
  // 表宽：内框宽 - 两侧边距
  const tableWPaper = inner.w / s - BOQ_PAPER.side * 2;
  // 规格列自适应：按全部行的规格文字估算（模型 mm → 图纸 mm）
  let specModel = 0;
  for (const r of allRows || []) {
    if (r.kind !== 'line') continue;
    specModel = Math.max(specModel, textWidth(r.spec, bodyH));
  }
  const fixed = BOQ_COLS.filter((c) => !c.flex).reduce((a, c) => a + c.w, 0);
  const flexTotal = tableWPaper - fixed;
  const specContent = Math.ceil(specModel / Math.max(1, s) + BOQ_PAPER.pad * 2);
  let specW = Math.max(specContent, flexTotal * 0.42);
  specW = Math.min(specW, flexTotal * 0.72, flexTotal - BOQ_NAME_MIN);
  let nameW = flexTotal - specW;
  if (nameW < BOQ_NAME_MIN) {
    nameW = BOQ_NAME_MIN;
    specW = flexTotal - nameW;
  }
  const widths = BOQ_COLS.map((c) => ({
    ...c,
    w: c.key === 'spec' ? specW : (c.key === 'name' ? nameW : c.w),
  }));
  const tableW = widths.reduce((a, c) => a + c.w, 0) * s;
  const tableLeft = inner.x + P(BOQ_PAPER.side);
  const tableTop = inner.y + inner.h - P(BOQ_PAPER.top);
  // 表格与标题栏 x 区间相交 → 底边停到标题栏上沿以上
  const tbHPaper = titleBlockPaperH(project || {});
  const tableBottomLimit = inner.y + P(Math.max(BOQ_PAPER.bottom, tbHPaper + BOQ_PAPER.side));
  let cursor = tableLeft;
  const cols = widths.map((c) => {
    const col = { ...c, x0: cursor, x1: cursor + P(c.w), wPx: P(c.w) };
    cursor = col.x1;
    return col;
  });
  // 每列表头字号自适应（防止 1:50 时表头超出列宽）
  const colHeadH = {};
  for (const c of cols) {
    colHeadH[c.key] = shrinkHeight(c.label, c.wPx - pad * 2, [headH, headH * 0.9, headH * 0.8]);
  }
  // 行容量（图纸 mm 空间计算，与比例无关）
  const availPaper = (tableTop - tableBottomLimit) / s;
  const capacity = Math.max(4, Math.floor((availPaper - BOQ_PAPER.headRow - BOQ_PAPER.note) / BOQ_PAPER.row));
  return {
    cols, tableLeft, tableW, tableTop, tableBottomLimit,
    rowH, headRowH, bodyH, strongH, headH, pad, capacity, P, s, colHeadH,
  };
}

function drawBoqTable(sh, layout, table, pageRows, info) {
  const { cols, tableLeft, tableW, tableTop, rowH, headRowH, bodyH, strongH, headH, pad, P, colHeadH } = table;
  const col = (key) => cols.find((c) => c.key === key);
  const headerBottom = tableTop - headRowH;
  const contentBottom = headerBottom - pageRows.length * rowH;
  // 表尾（合计/税金/…）行不画竖向列线，读起来更清爽
  const firstTail = pageRows.findIndex((r) => r.kind === 'tail' || r.kind === 'pair' || r.kind === 'words');
  const colBottom = firstTail >= 0 ? headerBottom - firstTail * rowH : contentBottom;
  // 表格外框 + 表头分隔 + 列标题
  sh.rect(LN.frame, tableLeft, contentBottom, tableW, tableTop - contentBottom);
  sh.line(LN.frame, tableLeft, headerBottom, tableLeft + tableW, headerBottom);
  const headY = headerBottom + headRowH / 2;
  for (const c of cols) {
    sh.text(LN.frame, (c.x0 + c.x1) / 2, headY, colHeadH[c.key] || headH, c.label, 'center', 'middle');
  }
  for (let i = 1; i < cols.length; i++) {
    sh.line(LN.frame, cols[i].x0, headerBottom, cols[i].x0, colBottom);
  }
  // 行
  pageRows.forEach((row, i) => {
    const yTop = headerBottom - i * rowH;
    const yBottom = yTop - rowH;
    const yMid = (yTop + yBottom) / 2;
    sh.line(LN.frame, tableLeft, yBottom, tableLeft + tableW, yBottom);
    const cellText = (key, value, h) => {
      const cc = col(key);
      if (!cc) return;
      const maxW = cc.wPx - pad * 2;
      const s4 = fitText(String(value == null ? '' : value), maxW, h);
      if (!s4) return;
      let x = cc.x0 + pad;
      let align = 'left';
      if (cc.align === 'right') { x = cc.x1 - pad; align = 'right'; }
      else if (cc.align === 'center') { x = (cc.x0 + cc.x1) / 2; align = 'center'; }
      sh.text(LN.text, x, yMid, h, s4, align, 'middle');
    };
    if (row.kind === 'group') {
      // 分组底纹（A-家具 ACI8 = 灰，打印为浅灰）
      sh.solid(LN.furn, [
        [tableLeft, yBottom],
        [tableLeft + tableW, yBottom],
        [tableLeft + tableW, yTop],
        [tableLeft, yTop],
      ]);
      sh.text(LN.text, tableLeft + pad, yMid, strongH, fitText(row.name, tableW - pad * 2, strongH), 'left', 'middle');
    } else if (row.kind === 'line') {
      cellText('no', row.no, bodyH);
      cellText('name', row.name, bodyH);
      cellText('spec', row.spec, bodyH);
      cellText('unit', row.unit, bodyH);
      cellText('qty', fmtFixed(row.qty, 2), bodyH);
      cellText('price', fmtMoney(row.price), bodyH);
      cellText('amount', fmtMoney(row.amount), bodyH);
      cellText('hours', fmtFixed(row.hours, 2), bodyH);
    } else if (row.kind === 'subtotal') {
      sh.text(LN.text, col('name').x1 - pad, yMid, strongH, '小计', 'right', 'middle');
      sh.text(LN.text, col('amount').x1 - pad, yMid, strongH, fmtMoney(row.amount), 'right', 'middle');
      sh.text(LN.text, col('hours').x1 - pad, yMid, strongH, fmtFixed(row.hours, 2), 'right', 'middle');
    } else if (row.kind === 'tail') {
      sh.text(LN.text, tableLeft + pad, yMid, strongH, row.label, 'left', 'middle');
      sh.text(LN.text, tableLeft + tableW - pad, yMid, strongH, row.value, 'right', 'middle');
    } else if (row.kind === 'pair') {
      const mid = tableLeft + tableW / 2;
      const pairs = [
        { label: row.left.label, value: row.left.value, lx: tableLeft + pad, vx: mid - pad },
        { label: row.right.label, value: row.right.value, lx: mid + pad * 2, vx: tableLeft + tableW - pad },
      ];
      for (const p of pairs) {
        sh.text(LN.text, p.lx, yMid, bodyH, p.label, 'left', 'middle');
        sh.text(LN.text, p.vx, yMid, strongH, p.value, 'right', 'middle');
      }
    } else if (row.kind === 'words') {
      sh.text(LN.text, tableLeft + pad, yMid, strongH, row.label, 'left', 'middle');
      const x = tableLeft + P(38);
      const maxW = tableLeft + tableW - pad - x;
      sh.text(LN.text, x, yMid, bodyH, fitText(row.value, maxW, bodyH), 'left', 'middle');
    }
  });
  // 页脚：金额口径 + 页码
  const footY = contentBottom - P(BOQ_PAPER.note * 0.55);
  sh.text(LN.legend, tableLeft, footY, P(2.6), '金额单位：元（含税）', 'left', 'middle');
  if (info && info.total > 1) {
    sh.text(LN.legend, tableLeft + tableW, footY, P(2.6), `第 ${info.page} 页 / 共 ${info.total} 页`, 'right', 'middle');
  }
}

function buildBoqSheets(plan, project, layout, startIndex, opts) {
  const boq = opts.boq;
  const { rows } = buildBoqRows(boq);
  const tailRows = buildBoqTailRows(boq);
  const capacity = boqTableLayout(layout, rows, project).capacity;
  const pages = paginateBoq(rows, capacity);
  const tail = tailRows.slice();
  if (!pages.length) pages.push([]);
  const last = pages[pages.length - 1];
  if (last.length + tail.length <= capacity) {
    for (const r of tail) last.push(r);
  } else {
    pages.push(tail);
  }
  const sheets = [];
  const total = pages.length;
  pages.forEach((pageRows, i) => {
    const layoutI = sheetLayout(layout.den, startIndex + i);
    const table = boqTableLayout(layoutI, rows, project);
    const id = i === 0 ? 'boq' : `boq-${i + 1}`;
    const name = i === 0 ? '工程量与估价表' : `工程量与估价表（续 ${i + 1}）`;
    const no = `ADS-03-${pad2(i + 1)}`;
    const sh = makeSheet({ id, name, no, layout: layoutI });
    drawFrame(sh, layoutI, project, { title: '工程量与估价表', no, compass: false, note: '单位：mm' });
    drawBoqTable(sh, layoutI, table, pageRows, { page: i + 1, total });
    sheets.push(sh);
  });
  void plan;
  return sheets;
}

// ─────────────────────────────────────────────────────────────────────────────
// 公开：buildDrawing
// ─────────────────────────────────────────────────────────────────────────────
function normalizePlan(plan) {
  const W = Math.max(1, num(plan.W, 12));
  const D = Math.max(1, num(plan.D, 12));
  const conn = num(plan.conn, 0);
  return {
    W, D, conn,
    usableW: num(plan.usableW, W - conn),
    frontD: num(plan.frontD, Math.min(D, 4)),
    corrAz: num(plan.corrAz, D * 0.65),
    corrAd: num(plan.corrAd, 0),
    corrBz: num(plan.corrBz, D),
    corrBd: num(plan.corrBd, 0),
    backd: num(plan.backd, 0),
    entranceX: num(plan.entranceX, W / 2),
    entranceW: Math.max(0.4, num(plan.entranceW, 1.8)),
    rooms: Array.isArray(plan.rooms) ? plan.rooms : [],
    items: Array.isArray(plan.items) ? plan.items : [],
    hardPoints: Array.isArray(plan.hardPoints) ? plan.hardPoints : [],
    stats: plan.stats && typeof plan.stats === 'object' ? plan.stats : {},
    platform: plan.platform,
    type: plan.type,
    style: plan.style,
  };
}

function makeProject(plan, opts) {
  const P = PLATFORMS[plan.platform] || {};
  const T = TYPE_MAP[plan.type] || {};
  const S = STYLE_MAP[plan.style] || {};
  const stats = plan.stats || {};
  const project = {
    title: '口腔诊所平面布置图',
    platform: plan.platform != null ? String(plan.platform) : '',
    platformLabel: P.label != null ? String(P.label) : String(plan.platform == null ? '' : plan.platform),
    typeName: T.name != null ? String(T.name) : String(plan.type == null ? '' : plan.type),
    styleName: S.name != null ? String(S.name) : String(plan.style == null ? '' : plan.style),
    area: num(stats.area),
    chairs: num(stats.chairs),
    clinics: num(stats.clinics),
    roomCount: num(stats.roomCount),
    itemCount: num(stats.itemCount, Array.isArray(plan.items) ? plan.items.length : 0),
    date: normalizeDate(opts && opts.date),
    stage: PROJECT_STAGE,
  };
  const boq = opts && opts.boq;
  if (boq && typeof boq === 'object' && boq.totals) {
    const totals = boq.totals || {};
    const labor = boq.labor || {};
    project.quoteSummary = {
      subtotal: num(totals.subtotal),
      tax: num(totals.tax),
      total: num(totals.total),
      perArea: num(totals.perArea),
      perChair: num(totals.perChair),
      low: num(totals.low),
      high: num(totals.high),
      hours: num(labor.totalHours),
      calendarDays: num(labor.calendarDays),
      amountInWords: String(totals.amountInWords == null ? '' : totals.amountInWords),
    };
  }
  return project;
}

export function buildDrawing(plan, opts = {}) {
  if (!plan || typeof plan !== 'object') throw new TypeError('buildDrawing(plan): 需要 plan 对象');
  const p = normalizePlan(plan);
  const project = makeProject(plan, opts);
  const den = pickScaleDen(p);
  const sheets = [];
  sheets.push(buildPlanSheet(p, project, sheetLayout(den, 0), opts));
  sheets.push(buildMepSheet(p, project, sheetLayout(den, 1), opts));
  if (opts && opts.boq) {
    const boqSheets = buildBoqSheets(p, project, sheetLayout(den, 2), 2, opts);
    for (const s of boqSheets) sheets.push(s);
  }
  return { kind: 'cad-drawing', version: 1, units: CAD_UNITS, project, sheets };
}

// ─────────────────────────────────────────────────────────────────────────────
// DXF 输出（R2007 / AC1021，UTF-8，1:1 模型毫米）
// ─────────────────────────────────────────────────────────────────────────────
const DXF_OWNER_MODEL = '1F';     // *Model_Space BLOCK_RECORD handle
const DXF_HANDLES = {
  tableLtype: '2', tableLayer: '3', tableStyle: '4', tableBlockRec: '5',
  ltypeContinuous: '6', ltypeDashed: '7',
  styleStandard: '8', styleCN: '9',
  blockModel: '50', blockModelEnd: '51', blockPaper: '52', blockPaperEnd: '53',
};
const DXF_LAYER_HANDLE_BASE = 0x30;

function dxfLayerHandle(name) {
  const i = Math.max(0, LAYER_DEFS.findIndex((d) => d.name === name));
  return (DXF_LAYER_HANDLE_BASE + (name === '0' ? 0 : i + 1)).toString(16).toUpperCase();
}
function dxfLayerOf(layer) {
  return LAYER_NAMES.has(layer) ? layer : '0';
}

// 实体线宽（DXF 370，单位 0.01mm）：平面墙 0.35、点位图墙线 0.18、家具 0.13
const DXF_LW = {
  'A-外墙': 35, 'A-内墙': 35, 'A-门': 18, 'A-家具': 13, 'A-文字': 13, 'A-标注': 13,
  'M-给水': 18, 'M-排水': 18, 'E-强电': 18, 'E-弱电': 18, 'G-气': 18,
  'A-图例': 13, 'TK-图框': 25,
};

function dxfEntityTags(e, handle, ctx) {
  const out = [];
  const p = (code, value) => {
    out.push(String(code));
    out.push(String(value));
  };
  const layer = dxfLayerOf(e.layer);
  const thinWalls = !!(ctx && ctx.thinWalls);
  const lineweight = thinWalls && (layer === LN.ext || layer === LN.int)
    ? 18
    : (DXF_LW[layer] || 13);
  const base = (type) => {
    p(0, type);
    p(5, handle);
    p(330, DXF_OWNER_MODEL);
    p(100, 'AcDbEntity');
    p(8, layer);
    p(370, lineweight);
  };
  switch (e && e.t) {
    case 'line':
      base('LINE');
      p(100, 'AcDbLine');
      p(10, nf(e.x1)); p(20, nf(e.y1)); p(30, '0.0');
      p(11, nf(e.x2)); p(21, nf(e.y2)); p(31, '0.0');
      break;
    case 'poly': {
      const pts = Array.isArray(e.pts) ? e.pts : [];
      if (pts.length < 2) return null;
      base('LWPOLYLINE');
      p(100, 'AcDbPolyline');
      p(90, pts.length);
      p(70, e.closed ? 1 : 0);
      for (const q of pts) {
        p(10, nf(q[0]));
        p(20, nf(q[1]));
      }
      break;
    }
    case 'circle':
      if (!(num(e.r) > 0)) return null;
      base('CIRCLE');
      p(100, 'AcDbCircle');
      p(10, nf(e.x)); p(20, nf(e.y)); p(30, '0.0');
      p(40, nf(e.r));
      break;
    case 'text': {
      const text = String(e.text == null ? '' : e.text).trim();
      if (!text) return null;
      const halign = e.align === 'center' ? 1 : (e.align === 'right' ? 2 : 0);
      const valign = e.anchor === 'middle' ? 2 : 0;
      base('TEXT');
      p(100, 'AcDbText');
      p(10, nf(e.x)); p(20, nf(e.y)); p(30, '0.0');
      p(40, nf(e.h));
      p(1, text);
      p(50, '0.0');
      p(41, '1.0');
      p(51, '0.0');
      p(7, 'CN');
      p(71, 0);
      p(72, halign);
      p(11, nf(e.x)); p(21, nf(e.y)); p(31, '0.0');
      p(100, 'AcDbText');
      p(73, valign);
      break;
    }
    case 'solid': {
      const pts = Array.isArray(e.pts) ? e.pts : [];
      if (pts.length < 3) return null;
      const q = pts.slice(0, 4);
      while (q.length < 4) q.push(q[q.length - 1]);
      base('SOLID');
      p(100, 'AcDbTrace');
      // DXF SOLID 顶点顺序为 0,1,3,2
      const order = [q[0], q[1], q[3], q[2]];
      const codes = [[10, 20, 30], [11, 21, 31], [12, 22, 32], [13, 23, 33]];
      codes.forEach((codes3, i) => {
        p(codes3[0], nf(order[i][0]));
        p(codes3[1], nf(order[i][1]));
        p(codes3[2], '0.0');
      });
      break;
    }
    default:
      return null;
  }
  return out;
}

export function toDXF(drawing) {
  if (!drawing || !Array.isArray(drawing.sheets)) throw new TypeError('toDXF(drawing): 无效 Drawing');
  const sheets = drawing.sheets;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let totalEnt = 0;
  for (const sh of sheets) {
    const f = sh.frame || {};
    minX = Math.min(minX, num(f.x));
    minY = Math.min(minY, num(f.y));
    maxX = Math.max(maxX, num(f.x) + num(f.w));
    maxY = Math.max(maxY, num(f.y) + num(f.h));
    totalEnt += Array.isArray(sh.entities) ? sh.entities.length : 0;
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 59400; maxY = 42000; }
  let handle = 0x100;
  const nextHandle = () => (handle++).toString(16).toUpperCase();
  const seed = (0x100 + totalEnt + 0x10).toString(16).toUpperCase();
  const out = [];
  const p = (code, value) => {
    out.push(String(code));
    out.push(String(value));
  };

  // ── HEADER ──
  p(0, 'SECTION'); p(2, 'HEADER');
  p(9, '$ACADVER'); p(1, 'AC1021');
  p(9, '$DWGCODEPAGE'); p(3, 'ANSI_936');
  p(9, '$INSBASE'); p(10, '0.0'); p(20, '0.0'); p(30, '0.0');
  p(9, '$EXTMIN'); p(10, nf(minX)); p(20, nf(minY)); p(30, '0.0');
  p(9, '$EXTMAX'); p(10, nf(maxX)); p(20, nf(maxY)); p(30, '0.0');
  p(9, '$LIMMIN'); p(10, nf(minX)); p(20, nf(minY));
  p(9, '$LIMMAX'); p(10, nf(maxX)); p(20, nf(maxY));
  p(9, '$INSUNITS'); p(70, 4);
  p(9, '$MEASUREMENT'); p(70, 1);
  p(9, '$LTSCALE'); p(40, '1.0');
  p(9, '$CELTSCALE'); p(40, '1.0');
  p(9, '$TEXTSIZE'); p(40, '250.0');
  p(9, '$TEXTSTYLE'); p(7, 'CN');
  p(9, '$CLAYER'); p(8, '0');
  p(9, '$DIMSCALE'); p(40, '1.0');
  p(9, '$HANDSEED'); p(5, seed);
  p(0, 'ENDSEC');

  // ── TABLES ──
  p(0, 'SECTION'); p(2, 'TABLES');
  // LTYPE
  p(0, 'TABLE'); p(2, 'LTYPE'); p(5, DXF_HANDLES.tableLtype); p(330, '0');
  p(100, 'AcDbSymbolTable'); p(70, 2);
  p(0, 'LTYPE'); p(5, DXF_HANDLES.ltypeContinuous); p(330, DXF_HANDLES.tableLtype);
  p(100, 'AcDbSymbolTableRecord'); p(100, 'AcDbLinetypeTableRecord');
  p(2, 'CONTINUOUS'); p(70, 0); p(3, 'Solid line'); p(72, 65); p(73, 0); p(40, '0.0');
  p(0, 'LTYPE'); p(5, DXF_HANDLES.ltypeDashed); p(330, DXF_HANDLES.tableLtype);
  p(100, 'AcDbSymbolTableRecord'); p(100, 'AcDbLinetypeTableRecord');
  p(2, 'DASHED'); p(70, 0); p(3, 'Dashed __ __ __'); p(72, 65); p(73, 2); p(40, '0.75');
  p(49, '0.5'); p(74, 0); p(49, '-0.25'); p(74, 0);
  p(0, 'ENDTAB');
  // LAYER
  p(0, 'TABLE'); p(2, 'LAYER'); p(5, DXF_HANDLES.tableLayer); p(330, '0');
  p(100, 'AcDbSymbolTable'); p(70, LAYER_DEFS.length + 1);
  p(0, 'LAYER'); p(5, dxfLayerHandle('0')); p(330, DXF_HANDLES.tableLayer);
  p(100, 'AcDbSymbolTableRecord'); p(100, 'AcDbLayerTableRecord');
  p(2, '0'); p(70, 0); p(62, 7); p(6, 'CONTINUOUS');
  for (const d of LAYER_DEFS) {
    p(0, 'LAYER'); p(5, dxfLayerHandle(d.name)); p(330, DXF_HANDLES.tableLayer);
    p(100, 'AcDbSymbolTableRecord'); p(100, 'AcDbLayerTableRecord');
    p(2, d.name); p(70, 0); p(62, d.aci); p(6, d.ltype);
  }
  p(0, 'ENDTAB');
  // STYLE
  p(0, 'TABLE'); p(2, 'STYLE'); p(5, DXF_HANDLES.tableStyle); p(330, '0');
  p(100, 'AcDbSymbolTable'); p(70, 2);
  for (const st of [{ h: DXF_HANDLES.styleStandard, name: 'STANDARD' }, { h: DXF_HANDLES.styleCN, name: 'CN' }]) {
    p(0, 'STYLE'); p(5, st.h); p(330, DXF_HANDLES.tableStyle);
    p(100, 'AcDbSymbolTableRecord'); p(100, 'AcDbTextStyleTableRecord');
    p(2, st.name); p(70, 0); p(40, '0.0'); p(41, '1.0'); p(50, '0.0'); p(71, 0); p(42, '2.5');
    p(3, 'simsun.ttc'); p(4, '');
  }
  p(0, 'ENDTAB');
  // BLOCK_RECORD
  p(0, 'TABLE'); p(2, 'BLOCK_RECORD'); p(5, DXF_HANDLES.tableBlockRec); p(330, '0');
  p(100, 'AcDbSymbolTable'); p(70, 2);
  for (const br of [{ h: DXF_OWNER_MODEL, name: '*Model_Space' }, { h: '1B', name: '*Paper_Space' }]) {
    p(0, 'BLOCK_RECORD'); p(5, br.h); p(330, DXF_HANDLES.tableBlockRec);
    p(100, 'AcDbSymbolTableRecord'); p(100, 'AcDbBlockTableRecord');
    p(2, br.name);
  }
  p(0, 'ENDTAB');
  p(0, 'ENDSEC');

  // ── BLOCKS（只放 *Model_Space / *Paper_Space 空块）──
  p(0, 'SECTION'); p(2, 'BLOCKS');
  const blockDefs = [
    { begin: DXF_HANDLES.blockModel, end: DXF_HANDLES.blockModelEnd, rec: DXF_OWNER_MODEL, name: '*Model_Space' },
    { begin: DXF_HANDLES.blockPaper, end: DXF_HANDLES.blockPaperEnd, rec: '1B', name: '*Paper_Space' },
  ];
  for (const b of blockDefs) {
    p(0, 'BLOCK'); p(5, b.begin); p(330, b.rec);
    p(100, 'AcDbEntity'); p(8, '0'); p(100, 'AcDbBlockBegin');
    p(2, b.name); p(70, 0); p(10, '0.0'); p(20, '0.0'); p(30, '0.0');
    p(3, b.name); p(1, '');
    p(0, 'ENDBLK'); p(5, b.end); p(330, b.rec);
    p(100, 'AcDbEntity'); p(8, '0'); p(100, 'AcDbBlockEnd');
  }
  p(0, 'ENDSEC');

  // ── ENTITIES ──
  p(0, 'SECTION'); p(2, 'ENTITIES');
  for (const sh of sheets) {
    const ctx = { thinWalls: sh.id === 'mep' };   // 点位图墙线 0.18，平面图 0.35
    for (const e of sh.entities || []) {
      const tags = dxfEntityTags(e, nextHandle(), ctx);
      if (tags) for (const t of tags) out.push(t);
    }
  }
  p(0, 'ENDSEC');
  p(0, 'EOF');
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// SVG 输出（整卷 / 单页）
// ─────────────────────────────────────────────────────────────────────────────
function selectSheets(drawing, sel) {
  const sheets = Array.isArray(drawing.sheets) ? drawing.sheets : [];
  // null / '' / 'all' → 整卷（默认）
  if (sel == null || sel === '') return sheets;
  const key = String(sel);
  if (key.toLowerCase() === 'all') return sheets;
  if (typeof sel === 'number' && Number.isInteger(sel)) {
    const s = sheets[sel];
    return s ? [s] : [];
  }
  const byId = sheets.filter((s) => String(s.id) === key);
  if (byId.length) return byId;
  const byNo = sheets.filter((s) => String(s.no) === key);
  if (byNo.length) return byNo;
  return sheets.filter((s) => String(s.name) === key);
}

function svgNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n * 1000) / 1000);
}

function svgEntity(e, layerStyle) {
  const y = (v) => -Number(v);
  const color = layerStyle.color;
  switch (e.t) {
    case 'line':
      return `<line x1="${svgNum(e.x1)}" y1="${svgNum(y(e.y1))}" x2="${svgNum(e.x2)}" y2="${svgNum(y(e.y2))}"/>`;
    case 'poly': {
      const pts = (e.pts || []).map((q) => `${svgNum(q[0])},${svgNum(y(q[1]))}`).join(' ');
      return e.closed
        ? `<polygon points="${pts}"/>`
        : `<polyline points="${pts}" fill="none"/>`;
    }
    case 'circle':
      return `<circle cx="${svgNum(e.x)}" cy="${svgNum(y(e.y))}" r="${svgNum(e.r)}" fill="#ffffff"/>`;
    case 'text': {
      const anchor = e.align === 'center' ? 'middle' : (e.align === 'right' ? 'end' : 'start');
      const baseline = e.anchor === 'middle' ? ' dominant-baseline="central"' : '';
      // font-size 用 em 尺寸：与 DXF 的 cap-height 字高语义对齐（见 FONT_CAP_TO_EM）
      const fontSize = svgNum(e.h * FONT_CAP_TO_EM);
      return `<text x="${svgNum(e.x)}" y="${svgNum(y(e.y))}" font-size="${fontSize}"`
        + ` text-anchor="${anchor}"${baseline} fill="${color}" stroke="none">${escXml(e.text)}</text>`;
    }
    case 'solid': {
      const pts = (e.pts || []).map((q) => `${svgNum(q[0])},${svgNum(y(q[1]))}`).join(' ');
      const opacity = layerStyle.opacity != null ? layerStyle.opacity : 1;
      return `<polygon points="${pts}" fill="${color}" fill-opacity="${opacity}" stroke="none"/>`;
    }
    default:
      return '';
  }
}

function sheetSvg(sh, s) {
  const out = [];
  const f = sh.frame || { x: 0, y: 0, w: 594 * s, h: 420 * s };
  out.push(`<g id="sheet-${escXml(sh.id)}" data-sheet-id="${escXml(sh.id)}" data-sheet-name="${escXml(sh.name)}" data-sheet-no="${escXml(sh.no)}" data-scale-den="${svgNum(sh.scaleDen)}">`);
  out.push(`<rect x="${svgNum(f.x)}" y="${svgNum(-(num(f.y) + num(f.h)))}" width="${svgNum(f.w)}" height="${svgNum(f.h)}" fill="#ffffff" stroke="#c9ced6" stroke-width="${svgNum(0.1 * s)}"/>`);
  const byLayer = new Map();
  for (const e of sh.entities || []) {
    const l = e && e.layer ? e.layer : '0';
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l).push(e);
  }
  const extra = [...byLayer.keys()].filter((l) => !LAYER_ORDER.includes(l));
  const isMep = sh.id === 'mep';
  for (const layer of [...LAYER_ORDER.filter((l) => byLayer.has(l)), ...extra]) {
    const st = SVG_LAYER[layer] || { color: '#333333', width: 0.18 };
    // 点位图墙线更细（0.18 图纸 mm）
    const wPaper = isMep && (layer === 'A-外墙' || layer === 'A-内墙') ? 0.18 : st.width;
    const style = { color: st.color, opacity: layer === 'A-家具' ? 0.32 : 1 };
    const attrs = [
      `data-layer="${escXml(layer)}"`,
      `stroke="${st.color}"`,
      'fill="none"',
      `stroke-width="${svgNum(wPaper * s)}"`,
    ];
    attrs.push('stroke-linecap="round"', 'stroke-linejoin="round"');
    out.push(`<g class="layer" ${attrs.join(' ')}>`);
    for (const e of byLayer.get(layer)) {
      const line = svgEntity(e, style);
      if (line) out.push(line);
    }
    out.push('</g>');
  }
  out.push('</g>');
  return out.join('\n');
}

export function toSVG(drawing, opts = {}) {
  if (!drawing || !Array.isArray(drawing.sheets)) throw new TypeError('toSVG(drawing): 无效 Drawing');
  const sheets = selectSheets(drawing, opts ? opts.sheet : undefined);
  const s = sheets.length ? Math.max(1, num(sheets[0].scaleDen, 100)) : 100;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sh of sheets) {
    const f = sh.frame || {};
    minX = Math.min(minX, num(f.x));
    maxX = Math.max(maxX, num(f.x) + num(f.w));
    minY = Math.min(minY, -(num(f.y) + num(f.h)));
    maxY = Math.max(maxY, -num(f.y));
  }
  if (!Number.isFinite(minX)) { minX = 0; maxX = 594 * s; minY = -420 * s; maxY = 0; }
  const vbW = Math.max(1, maxX - minX);
  const vbH = Math.max(1, maxY - minY);
  const paperW = vbW / s;
  const paperH = vbH / s;
  const totalEnt = sheets.reduce((a, sh) => a + (Array.isArray(sh.entities) ? sh.entities.length : 0), 0);
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${svgNum(minX)} ${svgNum(minY)} ${svgNum(vbW)} ${svgNum(vbH)}"`
    + ` width="${svgNum(paperW)}mm" height="${svgNum(paperH)}mm"`
    + ` data-units="mm" data-scale-den="${svgNum(s)}" data-sheets="${sheets.length}" data-entities="${totalEnt}">`);
  out.push(`<rect x="${svgNum(minX)}" y="${svgNum(minY)}" width="${svgNum(vbW)}" height="${svgNum(vbH)}" fill="#ffffff"/>`);
  out.push('<g font-family="SimSun, Songti SC, Noto Serif CJK SC, serif">');
  for (const sh of sheets) out.push(sheetSvg(sh, s));
  out.push('</g>');
  out.push('</svg>');
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 统计
// ─────────────────────────────────────────────────────────────────────────────
export function drawingStats(drawing) {
  const sheets = drawing && Array.isArray(drawing.sheets) ? drawing.sheets : [];
  const byLayer = {};
  let entities = 0;
  for (const sh of sheets) {
    for (const e of sh.entities || []) {
      entities += 1;
      const l = e && e.layer ? String(e.layer) : '0';
      byLayer[l] = (byLayer[l] || 0) + 1;
    }
  }
  const layerNames = Object.keys(byLayer).sort();
  return {
    sheets: sheets.length,
    entities,
    layers: layerNames.length,
    layerNames,
    byLayer,
  };
}
