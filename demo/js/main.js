// 应用主控：状态 → plan → 资产加载 → 场景重建 → UI
import * as THREE from 'three';
import {
  PLATFORMS, TYPES, TYPE_MAP, STYLE_MAP, DIFF_IDS, moduleState, typesForPlatform,
} from './config.js?v=20261113-8';
import { buildPlan } from './plan.js?v=20261113-8';
import { AssetLibrary } from './assets.js?v=20261113-8';
import { Viewer } from './scene.js?v=20261113-8';
import * as ui from './ui.js?v=20261113-8';
import { buildQuote } from './quote.js?v=20261113-8';
import { createSheetPanel } from './sheet.js?v=20261113-8';

const stage = document.getElementById('stage');
const state = {
  platform: 'M', type: 'community', style: 'calm',
  modules: [], hard: false, shared: false, ceiling: false, view: 'overview',
};

let lib, viewer, plan, sheet;
let busy = false;
let queued = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

boot();

async function boot() {
  try {
    const qs = new URLSearchParams(location.search);
    lib = new AssetLibrary();
    await lib.init();
    viewer = new Viewer(stage, lib, {
      shadows: qs.get('shadow') !== '0',
      pixelRatio: Number(qs.get('dpr') || 1.5),
      onPick: (hit) => {
        if (!hit) return ui.hideInfoCard();
        ui.showInfoCard(hit, lib, stage.getBoundingClientRect());
      },
      onLabelClick: (room) => {
        state.view = null;
        ui.setViewActive(null);
        viewer.focusRoom(room);
      },
    });
    sheet = createSheetPanel({
      getPlan: () => plan,
      getState: () => state,
      meta: quoteMeta(),
    });
    bindEvents();
    await apply({ initial: true });
    window.__demoReady = true;
    window.demo = {
      get state() { return { ...state, modules: [...state.modules] }; },
      get plan() {
        return plan && {
          assetIds: plan.assetIds, missing: [...lib.missing], stats: plan.stats,
          rooms: plan.rooms.length, items: plan.items.length, hardPoints: plan.hardPoints.length,
          reuse: plan.stats.reuse, lod: lib.stats,
        };
      },
      set(partial) { Object.assign(state, partial); return apply({}); },
      async setAndWait(partial) { Object.assign(state, partial); await apply({}); return this.plan; },
      pick(assetId) {
        const obj = viewer.itemObjects.find((o) => o.userData.assetId === assetId);
        if (!obj) return false;
        const v = obj.getWorldPosition(new THREE.Vector3()).project(viewer.camera);
        const r = stage.getBoundingClientRect();
        const hit = {
          assetId, clientX: r.left + (v.x * 0.5 + 0.5) * r.width,
          clientY: r.top + (-v.y * 0.5 + 0.5) * r.height,
        };
        ui.showInfoCard(hit, lib, r);
        return true;
      },
      clearInfo() { ui.hideInfoCard(); },
      view(id) { state.view = id; viewer.setView(id); ui.setViewActive(id); },
      drawing() { return sheet ? sheet.getDrawing() : null; },
      quote() { return (plan && plan.quote) || (sheet && sheet.getQuote()) || null; },
      csv() { return sheet ? sheet.csv() : ''; },
      dxf() { return sheet ? sheet.dxf() : ''; },
      svg() { return sheet ? sheet.svg() : ''; },
      openSheet() { if (sheet) sheet.open(); return !!sheet; },
      closeSheet() { if (sheet) sheet.close(); return !!sheet; },
      print() { return sheet ? sheet.print() : null; },
      printHtml() { return sheet ? sheet.printHtml() : ''; },
      async render() {
        viewer.requestRender();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      },
      info() {
        return {
          ready: !!window.__demoReady, busy: !!window.__busy, fps: viewer?.fps,
          frameMs: viewer ? Math.round(viewer.frameMs) : null,
          missing: lib ? [...lib.missing] : [], loaded: lib ? lib.templates.size : 0,
          lod: lib ? lib.stats : null,
          drawCalls: viewer?.renderer?.info?.render?.calls,
          triangles: viewer?.renderer?.info?.render?.triangles,
          error: window.__lastError || null,
        };
      },
    };
    // THREE 用于点了物件后的投影定位
    window.__THREE = THREE;
    window.__viewer = viewer;
    window.__lib = lib;
  } catch (err) {
    console.error(err);
    window.__lastError = String(err && err.stack || err);
  }
}

function quoteMeta() {
  return {
    nameOf: (id) => lib.info(id).zh,
    categoryOf: (id) => lib.info(id).category,
  };
}

function normalizeState() {
  const P = PLATFORMS[state.platform];
  if (!P.types.includes(state.type)) {
    state.type = P.types[0];
    state.style = TYPE_MAP[state.type].style;
    state.modules = [];
  }
  const t = TYPE_MAP[state.type];
  const mandated = new Set(t.modules);
  const slots = P.slots - mandated.size;
  const optional = (state.modules || []).filter((m) => !mandated.has(m));
  state.modules = [...mandated, ...optional.slice(0, Math.max(0, slots))];
}

async function apply({ initial = false } = {}) {
  if (busy) { queued = true; return; }
  busy = true; window.__busy = true;
  try {
    normalizeState();
    const oldPlatform = plan?.platform;
    await lib.refreshTuning();
    plan = buildPlan({ platform: state.platform, type: state.type, style: state.style, modules: state.modules });
    // 平台件 / 差异件：5 类门店默认配置都用到的算平台件
    const cls = classifyPlatform(state.platform, state.style);
    plan.diffSet = new Set(plan.assetIds.filter((id) => cls.isDiff(id)));
    plan.stats.reuse = cls.reuse;
    plan.stats.sharedTypes = cls.shared;
    plan.stats.totalTypes = cls.total;
    // 估价：plan.quote 供指标卡与出图浮层使用；失败时不影响 3D 主流程
    plan.quote = null;
    try {
      plan.quote = buildQuote(plan, { meta: quoteMeta() });
      delete window.__quoteError;
    } catch (err) {
      window.__quoteError = String((err && err.stack) || err);
    }
    window.__state = JSON.parse(JSON.stringify(state));
    // 先把 UI 与加载态画出来
    renderAll();
    const preloaded = plan.assetIds.every((id) => lib.has(id) || lib.missing.has(id));
    if (preloaded && !initial) {
      viewer.setPlan(plan, withPlan(stateWithStyle()));
      viewer.renderNow();
    } else {
      ui.showLoader(0, plan.assetIds.length);
      await nextFrame();
      await lib.ensure(plan.assetIds, (done, total) => {
        ui.showLoader(done, total);
      });
      const failed = plan.assetIds.filter((id) => lib.missing.has(id));
      if (failed.length) {
        console.error('[clinic-3d] 模型加载失败', failed);
        window.__loadErrors = failed;
        ui.showLoadError(failed.length);
      } else {
        ui.hideLoader();
      }
      viewer.setPlan(plan, withPlan(stateWithStyle()));
      viewer.renderNow();
    }
    if (initial) {
      viewer.setOverview(true);
    } else if (oldPlatform && oldPlatform !== state.platform) {
      viewer.setOverview();
    }
    renderAll();
    ui.updateToggles(state);
    ui.hideInfoCard();
    viewer.setCeiling(state.ceiling);
    if (sheet) sheet.refresh();
    window.__lastError = null;
  } catch (err) {
    console.error(err);
    window.__lastError = String((err && err.stack) || err);
  } finally {
    busy = false; window.__busy = false;
    if (queued) { queued = false; apply({}); }
  }
}

function stateWithStyle() {
  return { ...state, styleDef: STYLE_MAP[state.style] };
}

function withPlan(s) {
  s.diffSet = plan?.diffSet;
  return s;
}

// 平台件复用率：5 类门店默认配置都用到的资产 = 平台件；否则为差异件
const usageCache = new Map();
function classifyPlatform(platform, style) {
  const key = 'all|' + style;
  if (usageCache.has(key)) return usageCache.get(key);
  const usage = new Map();
  for (const t of TYPES) {
    const p = buildPlan({ platform: t.min, type: t.id, style, modules: [] });
    for (const id of p.assetIds) usage.set(id, (usage.get(id) || 0) + 1);
  }
  const diffSet = new Set();
  const allTypes = new Set(TYPES.map((t) => t.id));
  for (const [id, n] of usage) if (n < allTypes.size) diffSet.add(id);
  const total = usage.size;
  const shared = total - diffSet.size;
  const res = {
    diffSet, total, shared, usage,
    reuse: total ? Math.round((shared / total) * 100) : 0,
    isDiff: (id) => !usage.has(id) || usage.get(id) < allTypes.size,
  };
  usageCache.set(key, res);
  return res;
}

function renderAll() {
  if (!plan) return;
  ui.renderPlatforms(state, setPlatform);
  ui.renderTypes(state, plan, setType);
  ui.renderModules(state, toggleModule);
  ui.renderStyles(state, setStyle);
  ui.renderViews(state, setView);
  ui.renderMetrics(state, plan);
  ui.renderConfigList(plan);
  ui.renderMatrix(state, setType);
  ui.renderLegends(plan, plan.diffSet);
  ui.updateToggles(state);
}

function bindEvents() {
  const sheetToggle = document.getElementById('toggleSheet');
  if (sheetToggle) sheetToggle.addEventListener('click', () => { if (sheet) sheet.toggle(); });
  document.getElementById('toggleHard').addEventListener('click', () => {
    state.hard = !state.hard;
    viewer.setHardPoints(state.hard);
    ui.updateToggles(state);
  });
  document.getElementById('toggleShared').addEventListener('click', () => {
    state.shared = !state.shared;
    viewer.setOutlines(state.shared);
    ui.updateToggles(state);
  });
  document.getElementById('toggleCeiling').addEventListener('click', () => {
    state.ceiling = !state.ceiling;
    viewer.setCeiling(state.ceiling);
    ui.updateToggles(state);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') ui.hideInfoCard();
  });
  stage.addEventListener('pointerdown', (e) => {
    if (e.target === stage || e.target.tagName === 'CANVAS') {
      if (!viewer.raycast(e.clientX, e.clientY)) ui.hideInfoCard();
    }
  });
}

function setPlatform(p) {
  if (state.platform === p) return;
  state.platform = p;
  const allowed = typesForPlatform(p).map((t) => t.id);
  if (!allowed.includes(state.type)) {
    state.type = allowed[0];
    state.style = TYPE_MAP[state.type].style;
    state.modules = [];
  }
  state.view = 'overview';
  ui.setViewActive('overview');
  apply({});
}

function setType(typeId) {
  const t = TYPE_MAP[typeId];
  if (!t) return;
  const allowed = new Set(typesForPlatform(state.platform).map((x) => x.id));
  if (!allowed.has(typeId)) state.platform = t.min;
  if (state.type !== typeId) {
    state.type = typeId;
    state.style = t.style;
    state.modules = [];
  }
  state.view = 'overview';
  ui.setViewActive('overview');
  apply({});
}

function setStyle(styleId) {
  if (state.style === styleId) return;
  state.style = styleId;
  apply({});
}

function toggleModule(id) {
  const ms = moduleState(state.platform, state.type, state.modules);
  const row = ms.rows.find((r) => r.id === id);
  if (!row || row.disabled || row.mandated) return;
  if (row.on) state.modules = state.modules.filter((m) => m !== id);
  else state.modules = [...state.modules, id];
  apply({});
}

function setView(id) {
  state.view = id;
  ui.setViewActive(id);
  viewer.setView(id);
  ui.hideInfoCard();
}

window.__demoState = state;
