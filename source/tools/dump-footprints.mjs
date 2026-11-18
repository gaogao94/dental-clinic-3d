// 生成 dental/server/public/demo/js/footprint.js：用无头 Chrome 从演示页读出每件资产的真实平面尺寸。
//
// 做法：在页面里遍历「3 平台 × 全部可用门店类型 × 5 风格 × 常用模块组合」，收集所有 buildPlan 用到的
// assetId，调用 window.__lib.ensure() 加载，然后取 lib.templates 里归一化后的 world bbox（size 为
// 归一化后尺寸），再按 asset-tuning 的 rotY 把包围盒转到「正面朝 +Z」，得到 plan.items[].rotY=0
// 时的世界平面尺寸 [w, d, h]（米）。
//
// 用法：node dental/tools/dump-footprints.mjs
// 依赖：本机有 Chrome（C:\Program Files\Google\Chrome\Application\chrome.exe）+ 本地演示模型
//      dental/demo/lod-models、dental/demo/extra/models、dental/models（默认加载 LOD）。
import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, newPage, connect, evaluate, waitFor, setViewport, createStaticServer } from './cdp_lite.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');                                  // dental/
const DEMO = path.resolve(ROOT, 'demo');                               // 本地演示（含 lod-models）
const OUT_JS = path.resolve(ROOT, 'server/public/demo/js/footprint.js');

const MODS = [
  [], ['imaging'], ['lab'], ['kids'], ['consult'], ['coffee'], ['sterile'],
  ['imaging', 'consult'], ['imaging', 'lab'], ['lab', 'kids'], ['consult', 'coffee'], ['coffee', 'kids'],
  ['imaging', 'coffee'], ['lab', 'consult'], ['kids', 'consult'], ['imaging', 'lab', 'consult'],
  ['imaging', 'coffee', 'kids'], ['lab', 'consult', 'sterile'], ['imaging', 'lab', 'coffee', 'kids'],
];

const server = await createStaticServer(ROOT, [
  // 演示页里模型路径（./lod-models、./extra/models、../models）都落到本地演示目录
  { prefix: '/demo/lod-models/', dir: path.join(DEMO, 'lod-models') },
  { prefix: '/demo/extra/models/', dir: path.join(DEMO, 'extra/models') },
  { prefix: '/models/', dir: path.join(ROOT, 'models') },
]);
console.log('[footprint] serve', server.url('/demo/index.html'));
const chrome = await launchChrome({ width: 1280, height: 900 });
try {
  const page = await newPage(chrome.port, server.url('/demo/index.html?shadow=0&dpr=1'));
  const cdp = await connect(page.webSocketDebuggerUrl);
  await setViewport(cdp, 1280, 900);
  await waitFor(cdp, 'window.__demoReady === true', { timeoutMs: 180000 });
  console.log('[footprint] page ready');
  const result = await evaluate(cdp, `(async () => {
    const { PLATFORMS, TYPES, STYLES } = await import('./js/config.js');
    const { buildPlan } = await import('./js/plan.js');
    const MODS = ${JSON.stringify(MODS)};
    const ids = new Set();
    for (const p of Object.keys(PLATFORMS)) {
      for (const t of TYPES) {
        if (!PLATFORMS[p].types.includes(t.id)) continue;
        for (const s of STYLES) for (const mods of MODS) {
          for (const id of buildPlan({ platform: p, type: t.id, style: s.id, modules: mods }).assetIds) ids.add(id);
        }
      }
    }
    await window.__lib.ensure([...ids], null, 8);
    const out = {}; const rot = {}; const missing = [];
    const r3 = (v) => Math.round(v * 1000) / 1000;
    for (const id of ids) {
      const t = window.__lib.templates.get(id);
      if (!t) { missing.push(id); continue; }
      const a = ((t.rotY || 0) * Math.PI) / 180;
      const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
      out[id] = [r3(t.size.x * c + t.size.z * s), r3(t.size.x * s + t.size.z * c), r3(t.size.y)];
      rot[id] = t.rotY || 0;
    }
    return { ids: ids.size, missing, footprints: out, tuningRotY: rot };
  })()`);
  if (!result?.footprints) throw new Error('no result');
  if (result.missing.length) throw new Error('missing assets: ' + result.missing.join(', '));
  console.log('[footprint] assets', result.ids);

  const ids = Object.keys(result.footprints).sort();
  const lines = [
    '// 资产平面尺寸（米）：[宽 w(x), 深 d(z), 高 h(y)]。',
    '// 已按 asset-tuning rotY 转正到「正面朝 +Z」，即 plan.items[].rotY=0 时的世界平面尺寸；',
    `// 由无头浏览器实测归一化 bbox 生成（dental/tools/dump-footprints.mjs，${ids.length} 件），勿手改。`,
    'export const FOOTPRINTS = {',
  ];
  for (const id of ids) {
    const [w, d, h] = result.footprints[id];
    lines.push(`  '${id}': [${w}, ${d}, ${h}],`);
  }
  lines.push('};', '');
  lines.push(
    '// 兜底：按 id 关键词估平面尺寸（米），仅用于未实测的资产',
    'export function guessFootprint(id) {',
    "  const s = String(id || '').toLowerCase();",
    '  let w = 0.8, d = 0.6;',
    "  if (/dental-chair|chair-/.test(s)) { w = 2.0; d = 1.15; }",
    "  else if (/desk|workstation|cart|trolley/.test(s)) { w = 1.4; d = 0.7; }",
    "  else if (/cabinet|locker|shelf|bookcase|wardrobe/.test(s)) { w = 1.2; d = 0.55; }",
    "  else if (/sofa|bench|armchair/.test(s)) { w = 1.8; d = 0.8; }",
    "  else if (/table/.test(s)) { w = 1.1; d = 0.7; }",
    "  else if (/monitor|screen|tv|display|viewer/.test(s)) { w = 0.6; d = 0.12; }",
    "  else if (/sink|toilet|vanity|mirror/.test(s)) { w = 0.7; d = 0.55; }",
    "  else if (/plant|planter/.test(s)) { w = 0.8; d = 0.8; }",
    "  else if (/bin|box|container|holder|dispenser|tray|rack|sign/.test(s)) { w = 0.4; d = 0.35; }",
    '  return [w, d, 0.9];',
    '}', '',
    'export function footprintOf(id) {',
    '  const f = FOOTPRINTS[id];',
    '  if (f) return { w: f[0], d: f[1], h: f[2], exact: true };',
    '  const [w, d, h] = guessFootprint(id);',
    '  return { w, d, h, exact: false };',
    '}', '',
  );
  const out = lines.join('\n');
  fs.writeFileSync(OUT_JS, out);
  fs.writeFileSync(OUT_JSON, JSON.stringify({ generatedBy: 'dental/tools/dump-footprints.mjs', count: ids.length, ...result }, null, 1));
  console.log('[footprint] wrote', OUT_JS, out.length, 'bytes');
  cdp.close();
} finally {
  chrome.close();
  await server.close();
}
process.exit(0);
