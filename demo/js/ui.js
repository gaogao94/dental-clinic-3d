// DOM 渲染层：所有面板、SVG 平台矩阵、图例、信息卡、加载进度
import {
  PLATFORMS, PLATFORM_ORDER, TYPES, TYPE_MAP, STYLES, VIEWS, HARD_KINDS,
  typesForPlatform, moduleState, combinationCount, DIFF_IDS,
} from './config.js';
import { buildPlan } from './plan.js';

const $ = (id) => document.getElementById(id);

export function renderPlatforms(state, onPick) {
  const el = $('platformSeg');
  el.innerHTML = PLATFORM_ORDER.map((p) => {
    const P = PLATFORMS[p];
    return `<button type="button" data-p="${p}" class="${state.platform === p ? 'active' : ''}">
      <b>${p}</b><small>${P.chairs} 椅 · ${P.area}㎡</small></button>`;
  }).join('');
  el.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => onPick(b.dataset.p)));
}

export function renderTypes(state, plan, onPick) {
  const el = $('typeList');
  const allowed = new Set(typesForPlatform(state.platform).map((t) => t.id));
  el.innerHTML = TYPES.map((t) => {
    const ok = allowed.has(t.id);
    const P = PLATFORMS[ok ? state.platform : t.min];
    const slots = P.slots;
    const active = state.type === t.id;
    const used = active ? moduleState(state.platform, t.id, state.modules).used : t.modules.length;
    return `<button type="button" class="type-card ${active ? 'active' : ''} ${ok ? '' : 'locked'}" data-type="${t.id}">
      <span class="row1"><span class="type-name">${t.name}</span><span class="type-badge">${t.min}</span></span>
      <span class="type-meta">${P.area}㎡ · ${P.chairs} 椅 · 模块 ${used}/${slots}</span>
      <span class="type-note">${t.note}</span>
    </button>`;
  }).join('');
  el.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => onPick(b.dataset.type)));
  $('typeHint').textContent = `${allowed.size}/5`;
  void plan;
}

export function renderModules(state, onToggle) {
  const el = $('moduleList');
  const ms = moduleState(state.platform, state.type, state.modules);
  el.innerHTML = ms.rows.map((m) => {
    const cls = ['module-row', m.on || m.mandated ? 'on' : '', m.mandated ? 'mandated' : '', m.disabled && !m.on ? 'disabled' : ''].join(' ');
    return `<button type="button" class="${cls}" data-mod="${m.id}">
      <span>${m.name}</span><span class="sw"><i></i></span></button>`;
  }).join('');
  el.querySelectorAll('[data-mod]').forEach((b) => b.addEventListener('click', () => onToggle(b.dataset.mod)));
  const hint = $('slotHint');
  hint.textContent = `${ms.used}/${ms.slots}`;
  hint.classList.toggle('full', ms.used >= ms.slots);
}

export function renderStyles(state, onPick) {
  const el = $('styleList');
  el.innerHTML = STYLES.map((s) => `
    <button type="button" class="style-card ${state.style === s.id ? 'active' : ''}" data-style="${s.id}" title="${s.name} ${s.temp}">
      <span class="style-chips">
        <i style="background:${s.wall}"></i><i style="background:${s.floor}"></i><i style="background:${s.wood}"></i><i style="background:${s.accent}"></i>
      </span>
      <span class="style-name">${s.name}</span>
    </button>`).join('');
  el.querySelectorAll('[data-style]').forEach((b) => b.addEventListener('click', () => onPick(b.dataset.style)));
}

export function renderViews(state, onPick) {
  const el = $('viewSeg');
  el.innerHTML = VIEWS.map((v) => `<button type="button" class="${state.view === v.id ? 'active' : ''}" data-view="${v.id}">${v.name}</button>`).join('');
  el.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => onPick(b.dataset.view)));
}

export function setViewActive(id) {
  document.querySelectorAll('#viewSeg [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === id));
}

export function renderMetrics(state, plan) {
  const el = $('metrics');
  const combos = combinationCount(state.platform);
  const fmt = (n) => n.toLocaleString('en-US');
  const quote = plan.quote;
  const cost = quote && quote.totals ? (Number(quote.totals.total) / 10000).toFixed(1) : '—';
  const hours = quote && quote.labor ? Math.round(Number(quote.labor.totalHours) || 0) : '—';
  el.innerHTML = `
    <div class="metric wide"><div class="v">${cost}<small>万</small></div><div class="k">估算造价</div></div>
    <div class="metric"><div class="v">${hours}<small>人天</small></div><div class="k">估算工时</div></div>
    <div class="metric"><div class="v">${plan.stats.area}<small>㎡</small></div><div class="k">建筑面积</div></div>
    <div class="metric"><div class="v">${plan.stats.clinics}</div><div class="k">诊室</div></div>
    <div class="metric"><div class="v">${plan.stats.chairs}</div><div class="k">椅位</div></div>
    <div class="metric"><div class="v">${plan.stats.roomCount}</div><div class="k">房间</div></div>
    <div class="metric"><div class="v">${plan.stats.reuse}<small>%</small></div><div class="k">平台件复用率</div></div>
    <div class="metric wide"><div class="v">${fmt(combos)}</div><div class="k">衍生组合数</div></div>`;
}

export function renderConfigList(plan) {
  const el = $('configList');
  const rows = [];
  for (const r of plan.rooms) {
    const n = plan.itemCounts[r.id] || 0;
    if (!n) continue;
    const cls = r.kind === 'clinic' ? 'clinic' : (r.kind === 'reception' || r.kind === 'waiting') ? 'front' : r.kind === 'corridor' ? 'corr' : '';
    rows.push(`<div class="config-row ${cls}"><span class="name-wrap"><i class="dot"></i><span class="name">${r.name}</span></span><span class="n">${n}</span></div>`);
  }
  el.innerHTML = rows.join('');
  $('itemTotal').textContent = `${plan.stats.itemCount} 件`;
}

export function renderMatrix(state, onPick) {
  const el = $('matrix');
  const avail = new Set(typesForPlatform(state.platform).map((t) => t.id));
  const cards = TYPES.map((t) => {
    const ok = avail.has(t.id);
    const platformId = ok ? state.platform : t.min;
    const plan = buildPlan({ platform: platformId, type: t.id, style: ok ? state.style : t.style, modules: [] });
    return `<button type="button" class="matrix-card ${state.type === t.id ? 'active' : ''} ${ok ? '' : 'locked'}" data-type="${t.id}" title="${t.name}">
      ${svgThumb(plan)}
      <span class="matrix-foot"><span class="matrix-name">${t.name}</span><span class="matrix-meta">${plan.stats.area}㎡·${plan.stats.chairs}椅</span></span>
    </button>`;
  }).join('');
  el.innerHTML = cards;
  el.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => onPick(b.dataset.type)));
  $('matrixHint').textContent = `${avail.size}/5`;
}

const SHORT = {
  clinic: '诊', steril: '消毒', toilet: '卫', office: '办', imaging: '影', lab: '技',
  consult: '咨', staff: '员', materials: '材', reception: '前台', waiting: '候诊',
};
const ROOM_FILL = {
  clinic: ['#d3e9e6', '#0e7168'],
  reception: ['#dbe7f7', '#2c5c96'],
  waiting: ['#e7f0fa', '#3a6d9e'],
  imaging: ['#f6ecd9', '#8a5a12'],
  lab: ['#f6ecd9', '#8a5a12'],
  consult: ['#f6ecd9', '#8a5a12'],
};
const ROOM_DEFAULT = ['#eef1f4', '#5c6672'];

function svgThumb(plan) {
  const { W, D } = plan.svg;
  const k = Math.max(W, D);
  const sw = k * 0.007;
  const parts = [];
  parts.push(`<rect x="0" y="0" width="${W}" height="${D}" fill="#ffffff"/>`);
  for (const c of plan.svg.corridors) {
    parts.push(`<rect x="${c.x}" y="${c.z}" width="${c.w}" height="${c.d}" fill="#eef1f3"/>`);
  }
  for (const r of plan.svg.rects) {
    const [fill, ink] = ROOM_FILL[r.kind] || ROOM_DEFAULT;
    const pad = k * 0.012;
    parts.push(`<rect x="${r.x + pad / 2}" y="${r.z + pad / 2}" width="${Math.max(0.05, r.w - pad)}" height="${Math.max(0.05, r.d - pad)}" fill="${fill}" stroke="#b6bfc9" stroke-width="${sw}"/>`);
    const label = SHORT[r.kind] || '';
    if (label && r.w > k * 0.055) {
      parts.push(`<text x="${r.x + r.w / 2}" y="${r.z + r.d / 2}" font-size="${k * 0.052}" fill="${ink}" text-anchor="middle" dominant-baseline="central" font-family="PingFang SC,Microsoft YaHei,sans-serif">${label}</text>`);
    }
    if (r.door) {
      const dz = r.door.side === 'north' ? r.z + r.d : r.z;
      const dw = Math.min(r.w * 0.55, k * 0.085);
      parts.push(`<line x1="${r.door.x - dw / 2}" y1="${dz}" x2="${r.door.x + dw / 2}" y2="${dz}" stroke="#ffffff" stroke-width="${sw * 3}" />`);
      parts.push(`<line x1="${r.door.x - dw / 2 + sw}" y1="${dz}" x2="${r.door.x + dw / 2 - sw}" y2="${dz}" stroke="#0d9488" stroke-width="${sw * 1.2}" stroke-linecap="round"/>`);
    }
  }
  // 诊椅
  for (const c of plan.svg.chairs) {
    parts.push(`<rect x="${c.x - k * 0.026}" y="${c.z - k * 0.055}" width="${k * 0.052}" height="${k * 0.11}" rx="${k * 0.02}" fill="#0d9488" opacity="0.85"/>`);
  }
  // 入口
  const ex = plan.entranceX, ew = plan.entranceW;
  parts.push(`<line x1="${ex - ew / 2}" y1="0" x2="${ex + ew / 2}" y2="0" stroke="#111827" stroke-width="${sw * 2.4}"/>`);
  return `<svg viewBox="${-k * 0.02} ${-k * 0.02} ${W + k * 0.04} ${D + k * 0.04}" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
}

export function renderLegends(plan, diffSet = new Set()) {
  const hard = $('legendHard');
  hard.innerHTML = HARD_KINDS.map((k) => `<span class="chip"><i style="background:${k.color}"></i>${k.name}</span>`).join('');
  const diffCount = plan.items.filter((i) => diffSet.has(i.asset)).length;
  const sharedCount = plan.items.length - diffCount;
  $('legendShared').innerHTML = `
    <span class="chip"><i style="background:#0d9488"></i>平台件 <b>${sharedCount}</b></span>
    <span class="chip"><i style="background:#d97706"></i>差异件 <b>${diffCount}</b></span>`;
}

export function updateToggles(state) {
  $('toggleHard').classList.toggle('active', state.hard);
  $('toggleShared').classList.toggle('active', state.shared);
  $('toggleCeiling').classList.toggle('active', state.ceiling);
  $('legendHard').classList.toggle('hidden', !state.hard);
  $('legendShared').classList.toggle('hidden', !state.shared);
}

export function showLoader(done, total) {
  const el = $('loader');
  el.classList.remove('hidden');
  $('loadCount').textContent = `加载 ${done}/${total}`;
  $('loadBar').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
}
export function hideLoader() { $('loader').classList.add('hidden'); }

export function showLoadError(n) {
  const el = $('loader');
  el.classList.remove('hidden');
  $('loadCount').textContent = `${n} 个模型加载失败，请按 Ctrl+F5 强制刷新`;
  $('loadBar').style.width = '100%';
  $('loadBar').style.background = '#c0392b';
}

export function showInfoCard(hit, lib, stageRect) {
  const el = $('infoCard');
  const info = lib.info(hit.assetId);
  const diff = DIFF_IDS.has(hit.assetId);
  el.innerHTML = `<div class="ic-name">${info.zh}</div>
    <div class="ic-meta"><span>${info.cat}</span><i></i><span class="tag ${diff ? 'diff' : 'shared'}">${diff ? '差异件' : '平台件'}</span></div>`;
  const x = Math.max(70, Math.min(stageRect.width - 70, hit.clientX - stageRect.left));
  const y = Math.max(70, Math.min(stageRect.height - 16, hit.clientY - stageRect.top));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.classList.remove('hidden');
}
export function hideInfoCard() { $('infoCard').classList.add('hidden'); }
