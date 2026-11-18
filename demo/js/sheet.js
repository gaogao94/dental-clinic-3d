// 出图与报价浮层：SVG 图页预览 + 造价/工时侧栏 + Blob 下载 + 打印（浏览器端）
// 依赖纯模块 cad.js（Drawing/DXF/SVG）与 quote.js（Quote/CSV）；Drawing 惰性构建并按 plan 缓存。
import { buildDrawing, toDXF, toSVG } from './cad.js?v=20261113-8';
import { buildQuote, quoteToCSV } from './quote.js?v=20261113-8';

const $ = (id) => document.getElementById(id);

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n, d = 0) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtMoney = (n) => fmt(Math.round(Number(n) || 0));

// 图纸幅面（mm，纵向）；实际尺寸优先由图框 + 比例分母反推（cad.js 的 frame/scaleDen 才是真值）
const PAPER_MM = { A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420], A4: [210, 297], A5: [148, 210] };

function sheetPaperMm(sheet) {
  const f = (sheet && sheet.frame) || {};
  const den = Number(sheet && sheet.scaleDen) || 0;
  if (f.w > 0 && f.h > 0 && den > 0) {
    const w = Math.round((f.w / den) * 10) / 10;
    const h = Math.round((f.h / den) * 10) / 10;
    if (w >= 50 && h >= 50) return { w, h };
  }
  const base = PAPER_MM[String((sheet && sheet.paper) || '').toUpperCase().replace(/\s+/g, '')];
  const landscape = f.w && f.h ? f.w >= f.h : true;
  if (base) {
    return landscape
      ? { w: Math.max(base[0], base[1]), h: Math.min(base[0], base[1]) }
      : { w: Math.min(base[0], base[1]), h: Math.max(base[0], base[1]) };
  }
  return { w: 594, h: 420 };
}

export function createSheetPanel({ getPlan, getState, meta = {} } = {}) {
  void getState; // 预留：浮层只依赖 plan，不直接读 state
  const root = $('sheetPanel');
  const preview = $('sheetPreview');
  const pagesEl = $('sheetPages') || preview;
  const navEl = $('sheetNav');
  const side = $('sheetSide');
  const configEl = $('sheetConfig');
  const toggleBtn = $('toggleSheet');
  if (!root || !preview || !side) return null;

  const metaSafe = {
    nameOf: typeof meta.nameOf === 'function' ? meta.nameOf : (id) => id,
    categoryOf: typeof meta.categoryOf === 'function' ? meta.categoryOf : () => '',
  };

  let open = false;
  let lastError = null;
  let scrollQueued = false;
  let cache = freshCache(null);

  const planOf = () => (typeof getPlan === 'function' ? getPlan() : null);
  const isOpen = () => open;

  function freshCache(p) {
    return { plan: p, quote: null, drawing: null, pages: null, svg: '', dxf: null, csv: null, html: null };
  }

  // 纯模块调用统一兜底：失败不阻断浮层，错误记到 window.__sheetError（不污染 console）
  function guard(label, fn) {
    try {
      return fn();
    } catch (err) {
      lastError = label + ': ' + ((err && err.message) || err);
      window.__sheetError = lastError;
      return null;
    }
  }

  function ensureCache(p) {
    if (cache.plan !== p) cache = freshCache(p);
    return cache;
  }

  function quoteOf(p = planOf()) {
    if (!p) return null;
    const c = ensureCache(p);
    if (c.quote) return c.quote;
    c.quote = p.quote || guard('buildQuote', () => buildQuote(p, { meta: metaSafe }));
    return c.quote || null;
  }

  function drawingOf(p = planOf()) {
    if (!p) return null;
    const c = ensureCache(p);
    const q = quoteOf(p); // 平台变化时先重置缓存
    if (c.drawing) return c.drawing;
    const opts = q ? { boq: q, meta: metaSafe } : { meta: metaSafe };
    c.drawing = guard('buildDrawing', () => buildDrawing(p, opts));
    return c.drawing || null;
  }

  // 图页：优先按页取 SVG；若 cad.js 忽略 opts.sheet（返回整卷），回退为整卷单张
  function pagesOf(d) {
    if (!d) return [];
    const c = ensureCache(planOf());
    if (c.pages) return c.pages;
    const sheets = Array.isArray(d.sheets) ? d.sheets : [];
    const whole = guard('toSVG', () => toSVG(d)) || '';
    c.svg = whole;
    let pages = [];
    for (const s of sheets) {
      const svg = guard('toSVG', () => toSVG(d, { sheet: s.id }));
      if (svg) pages.push({ id: s.id, name: s.name || '', no: s.no || '', svg, sheet: s });
    }
    if (!pages.length || (whole && pages.every((pg) => pg.svg === whole))) {
      pages = whole ? [{ id: 'all', name: (d.project && d.project.title) || '出图与报价', no: '', svg: whole, sheet: sheets[0] || null }] : [];
    }
    c.pages = pages;
    return pages;
  }

  function svgOf(d = drawingOf()) {
    if (!d) return '';
    pagesOf(d);
    return cache.svg || '';
  }

  function dxfOf(d = drawingOf()) {
    if (!d) return '';
    const c = ensureCache(planOf());
    if (c.dxf == null) c.dxf = guard('toDXF', () => toDXF(d)) || '';
    return c.dxf;
  }

  function csvOf(q = quoteOf()) {
    if (!q) return '';
    const c = ensureCache(planOf());
    if (c.csv == null) c.csv = guard('quoteToCSV', () => quoteToCSV(q)) || '';
    return c.csv;
  }

  function configText(q, d) {
    const p = planOf() || {};
    const c = (q && q.config) || {};
    const proj = (d && d.project) || {};
    const platformLabel = c.platformLabel || proj.platformLabel || c.platform || p.platform || '';
    const typeName = c.typeName || proj.typeName || p.type || '';
    const styleName = c.styleName || proj.styleName || p.style || '';
    const area = c.area != null ? c.area : (proj.area != null ? proj.area : (p.stats && p.stats.area));
    const chairs = c.chairs != null ? c.chairs : (proj.chairs != null ? proj.chairs : (p.stats && p.stats.chairs));
    const parts = [];
    if (platformLabel) parts.push('平台 ' + platformLabel);
    if (typeName) parts.push(typeName);
    if (styleName) parts.push(styleName);
    if (area != null) parts.push(area + '㎡');
    if (chairs != null) parts.push(chairs + ' 椅');
    return parts.join(' · ');
  }

  function renderPreview(d, pages) {
    if (!d || !pages.length) {
      pagesEl.innerHTML = '<div class="preview-empty">—</div>';
      if (navEl) navEl.innerHTML = '';
      return;
    }
    pagesEl.innerHTML = pages.map((pg) => `
      <figure class="paper" data-sheet="${esc(pg.id)}">
        <figcaption class="paper-head"><span>${esc(pg.name)}</span><span class="paper-no">${esc(pg.no)}</span></figcaption>
        <div class="paper-svg">${pg.svg}</div>
      </figure>`).join('');
    renderNav(pages);
  }

  // 预览顶部图页锚点：点击滚动到对应图页，滚动时高亮当前页
  function renderNav(pages) {
    if (!navEl) return;
    navEl.innerHTML = pages.map((pg, i) => `<button type="button" class="preview-anchor${i === 0 ? ' active' : ''}" data-page="${esc(pg.id)}">${esc(pg.name)}</button>`).join('');
  }

  function scrollToPage(id) {
    const fig = pagesEl.querySelector(`figure.paper[data-sheet="${String(id).replace(/"/g, '\\"')}"]`);
    if (!fig) return;
    const navH = navEl ? navEl.offsetHeight : 0;
    const previewRect = preview.getBoundingClientRect();
    const figRect = fig.getBoundingClientRect();
    // 当前滚动位置 + 图页相对滚动视口的距离 = 图页在滚动内容里的绝对偏移；再让出吸顶锚点栏高度
    const top = preview.scrollTop + (figRect.top - previewRect.top) - navH - 6;
    preview.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    if (navEl) {
      navEl.querySelectorAll('.preview-anchor').forEach((b) => b.classList.toggle('active', b.dataset.page === id));
    }
  }

  function updateNavActive() {
    if (!navEl) return;
    const figs = pagesEl.querySelectorAll('figure.paper');
    const anchors = navEl.querySelectorAll('.preview-anchor');
    if (!figs.length || !anchors.length) return;
    const top = preview.getBoundingClientRect().top + (navEl.offsetHeight || 0) + 12;
    let idx = 0;
    figs.forEach((f, i) => { if (f.getBoundingClientRect().top <= top) idx = i; });
    anchors.forEach((b, i) => b.classList.toggle('active', i === idx));
  }

  function renderSide(q) {
    if (!q) {
      side.innerHTML = '<div class="side-empty">—</div>';
      return;
    }
    const t = q.totals || {};
    const labor = q.labor || {};
    const groups = Array.isArray(q.groups) ? q.groups : [];
    const phases = Array.isArray(labor.phases) ? labor.phases : [];
    const trades = Array.isArray(labor.byTrade) ? labor.byTrade : [];
    const share = (g) => Math.max(2, Math.min(100, Math.round((Number(g.share) || 0) * 100)));
    const fmtH = (n) => {
      const v = Number(n) || 0;
      return Number.isInteger(v) ? String(v) : v.toFixed(1);
    };
    side.innerHTML = `
      <section class="price-block">
        <div class="side-k">估算造价</div>
        <div class="price-v"><small>¥</small>${fmtMoney(t.total)}</div>
        <div class="price-range">${fmtMoney(t.low)} – ${fmtMoney(t.high)}</div>
      </section>
      <div class="side-pair">
        <div class="side-cell"><div class="side-k">单方造价</div><div class="side-v">${fmtMoney(t.perArea)}<small>元/㎡</small></div></div>
        <div class="side-cell"><div class="side-k">每椅造价</div><div class="side-v">${fmtMoney(t.perChair)}<small>元/椅</small></div></div>
      </div>
      <div class="side-sep"></div>
      <section class="side-groups">
        ${groups.map((g) => `<div class="group-row">
          <div class="group-top"><span class="group-name">${esc(g.name)}</span><span class="group-amt">${fmtMoney(g.amount)}</span></div>
          <div class="group-bar"><i style="width:${share(g)}%"></i></div>
        </div>`).join('')}
      </section>
      <div class="side-sep"></div>
      <div class="side-pair">
        <div class="side-cell"><div class="side-k">总工日</div><div class="side-v">${Math.round(Number(labor.totalHours) || 0)}<small>人天</small></div></div>
        <div class="side-cell"><div class="side-k">工期</div><div class="side-v">${Math.round(Number(labor.calendarDays) || 0)}<small>天</small></div></div>
      </div>
      <section class="side-phases">
        ${phases.map((ph) => `<div class="phase-row"><span class="phase-name">${esc(ph.name)}</span><span class="phase-days">${Math.round(Number(ph.days) || 0)} 天</span></div>`).join('')}
      </section>
      ${trades.length ? `<div class="side-sep"></div>
      <section class="side-trades">
        <div class="side-k">工种 · 人天</div>
        <div class="trade-grid">
          ${trades.map((tr) => `<div class="trade-cell"><span class="trade-name">${esc(tr.name)}</span><span class="trade-h">${fmtH(tr.hours)}</span></div>`).join('')}
        </div>
      </section>` : ''}`;
  }

  function render() {
    const p = planOf();
    if (!p) return;
    const q = quoteOf(p);
    const d = drawingOf(p);
    const pages = pagesOf(d);
    configEl.textContent = configText(q, d);
    renderPreview(d, pages);
    renderSide(q);
    updateNavActive();
  }

  function refresh() {
    if (!open) return;
    render();
  }

  function openPanel() {
    if (open) return;
    open = true;
    root.classList.remove('hidden');
    document.body.classList.add('sheet-open');
    if (toggleBtn) {
      toggleBtn.classList.add('active');
      toggleBtn.setAttribute('aria-expanded', 'true');
    }
    render();
    preview.scrollTop = 0;
    updateNavActive();
    try { root.focus({ preventScroll: true }); } catch { /* 老浏览器忽略 */ }
  }

  function closePanel() {
    if (!open) return;
    open = false;
    root.classList.add('hidden');
    document.body.classList.remove('sheet-open');
    if (toggleBtn) {
      toggleBtn.classList.remove('active');
      toggleBtn.setAttribute('aria-expanded', 'false');
    }
  }

  function toggle() {
    if (open) closePanel();
    else openPanel();
  }

  // ── 下载 ────────────────────────────────────────────────────────────────
  function saveFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }, 4000);
    return { filename, size: content.length, bytes: blob.size, mime };
  }

  function fileBase() {
    const p = planOf() || {};
    const c = (quoteOf(p) && quoteOf(p).config) || {};
    return {
      typeName: c.typeName || p.type || '',
      platform: c.platform || p.platform || '',
      styleName: c.styleName || p.style || '',
    };
  }

  function downloadDxf() {
    const s = dxfOf();
    if (!s) return null;
    const b = fileBase();
    return saveFile(`平面图_${b.typeName}_${b.platform}_${b.styleName}.dxf`, s, 'application/dxf');
  }

  function downloadSvg() {
    const s = svgOf();
    if (!s) return null;
    const b = fileBase();
    return saveFile(`平面图_${b.typeName}_${b.platform}_${b.styleName}.svg`, s, 'image/svg+xml');
  }

  function downloadCsv() {
    const s = csvOf();
    if (!s) return null;
    const b = fileBase();
    return saveFile(`估价单_${b.typeName}_${b.platform}.csv`, s, 'text/csv;charset=utf-8');
  }

  // ── 打印（PDF 出口）─────────────────────────────────────────────────────
  function printHtml() {
    const d = drawingOf();
    const pages = pagesOf(d);
    if (!pages.length) return '';
    const c = ensureCache(planOf());
    if (c.html) return c.html;
    const title = (d && d.project && d.project.title) || '出图与报价';
    const fallbackSheet = (d && Array.isArray(d.sheets) && d.sheets[0]) || null;
    // 图幅从 drawing.sheets[i].frame/scaleDen/paper 动态生成，不写死 A2（cad 换图幅时自动跟随）
    const sizes = pages.map((pg) => sheetPaperMm(pg.sheet || fallbackSheet));
    const uniq = [];
    const pageIdx = sizes.map((s) => {
      const k = s.w + 'x' + s.h;
      let i = uniq.findIndex((u) => u.k === k);
      if (i < 0) { uniq.push({ k, w: s.w, h: s.h }); i = uniq.length - 1; }
      return i;
    });
    const multi = uniq.length > 1;
    const pageCss = uniq.map((u, i) => `@page${multi ? ' pg' + i : ''}{size:${u.w}mm ${u.h}mm;margin:0}`).join('')
      + (multi ? uniq.map((u, i) => `.pgs${i}{page:pg${i}}`).join('') : '');
    const style = [
      pageCss,
      'html,body{margin:0;padding:0;background:#fff}',
      '.pg{page-break-after:always;break-after:page}',
      '.pg:last-child{page-break-after:auto;break-after:auto}',
      '.pg svg{display:block;width:100%;height:auto}',
    ].join('');
    c.html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>`
      + `<style>${style}</style></head><body>`
      + pages.map((pg, i) => `<div class="pg${multi ? ' pgs' + pageIdx[i] : ''}">${pg.svg}</div>`).join('\n')
      + '</body></html>';
    return c.html;
  }

  // 打印窗口可能被无头浏览器/弹窗拦截：返回 opened 标志与 HTML，绝不抛错
  function print() {
    const html = printHtml();
    let opened = false;
    if (!html) return { opened, html };
    try {
      const win = window.open('', '_blank');
      if (win && win.document) {
        opened = true;
        win.document.open();
        win.document.write(html);
        win.document.close();
        // 只触发一次，避免 load + 定时器双打印把无头浏览器卡住
        let printed = false;
        const trigger = () => {
          if (printed) return;
          printed = true;
          try { win.focus(); win.print(); } catch { /* 打印对话框不可用 */ }
        };
        const timer = setTimeout(trigger, 300);
        win.addEventListener('load', () => { clearTimeout(timer); setTimeout(trigger, 60); }, { once: true });
      }
    } catch (err) {
      lastError = 'print: ' + ((err && err.message) || err);
      window.__sheetError = lastError;
    }
    return { opened, html };
  }

  // ── 事件 ────────────────────────────────────────────────────────────────
  if (navEl) {
    navEl.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('[data-page]') : null;
      if (!b) return;
      scrollToPage(b.dataset.page);
    });
  }
  preview.addEventListener('scroll', () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; updateNavActive(); });
  }, { passive: true });

  root.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-dl]') : null;
    if (btn) {
      const kind = btn.dataset.dl;
      if (kind === 'close') closePanel();
      else if (kind === 'dxf') downloadDxf();
      else if (kind === 'svg') downloadSvg();
      else if (kind === 'csv') downloadCsv();
      else if (kind === 'print') print();
      return;
    }
    if (e.target === root) closePanel();
  });

  document.addEventListener('keydown', (e) => {
    if (!open || e.key !== 'Escape') return;
    e.stopPropagation();
    closePanel();
  });

  return {
    open: openPanel,
    close: closePanel,
    toggle,
    refresh,
    isOpen,
    getPlan: planOf,
    getQuote: () => quoteOf(),
    getDrawing: () => drawingOf(),
    quote: () => quoteOf(),
    drawing: () => drawingOf(),
    dxf: () => dxfOf(),
    svg: () => svgOf(),
    csv: () => csvOf(),
    downloadDxf,
    downloadSvg,
    downloadCsv,
    printHtml,
    print,
    fileNames() {
      const b = fileBase();
      return {
        dxf: `平面图_${b.typeName}_${b.platform}_${b.styleName}.dxf`,
        svg: `平面图_${b.typeName}_${b.platform}_${b.styleName}.svg`,
        csv: `估价单_${b.typeName}_${b.platform}.csv`,
      };
    },
    get lastError() { return lastError; },
  };
}
