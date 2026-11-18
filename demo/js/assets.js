// 资产库：只加载一次 + clone 复用；运行时按 bbox 归一化（fit = 最长水平边）、底部贴地
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DEFAULT_TUNING, EXTRA_META } from './asset-tuning.js';
import { EXTRA_IDS } from './config.js';
import { MeshoptDecoder } from '../lib/meshopt_decoder.module.js';

const DEG = Math.PI / 180;
// 模型 URL 版本号：改过压缩/几何后必须递增，用于绕开浏览器对旧 GLB 的 immutable 缓存
const ASSET_VERSION = '20261113-3';
const vurl = (u) => u + (u.includes('?') ? '&' : '?') + 'v=' + ASSET_VERSION;

export class AssetLibrary {
  constructor() {
    this.meta = {};          // id → { zh, cat }
    this.tuning = { ...DEFAULT_TUNING };
    this.templates = new Map(); // id → { root, size, tris, fit }
    this.missing = new Set();
    this.pending = new Map();
    this.loader = new GLTFLoader();
    // gltfpack 压缩过的 GLB 需要 meshopt 解码器；没有它会在 parse 时直接报错
    this.loader.setMeshoptDecoder(MeshoptDecoder);
    this.tuningFetchedAt = 0;
    this.lodIds = null;
    this.hi = new URLSearchParams(location.search).get('hi') === '1';
    this.stats = { lod: 0, hi: 0 };
    // 远程模型源（GitHub Pages 等纯静态托管时从对象存储加载模型，?remote=1 / ?remote=0 可强制）
    this.remote = {};
    const qsRemote = new URLSearchParams(location.search).get('remote');
    const qsSrc = new URLSearchParams(location.search).get('src');
    // ?src=oss 强制使用阿里云 OSS 映射（remote-models-oss.json）
    this.remoteMode = qsRemote === '1' || qsSrc === 'oss'
      || (qsRemote !== '0' && /\.github\.io$/i.test(location.hostname));
    this.remoteSrc = qsSrc === 'oss' ? 'oss' : 'ous';
  }

  async init() {
    const jobs = [
      fetch('../inventory.json').then((r) => r.json()).catch(() => null),
      fetch('./extra/inventory-extra.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
      fetch('./lod-ids.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
    ];
    const [inv, extraInv, lodIds] = await Promise.all(jobs);
    if (inv?.items) for (const it of inv.items) this.meta[it.id] = { zh: it.zh, cat: it.category };
    if (extraInv?.items) for (const it of extraInv.items) this.meta[it.id] = { zh: it.zh, cat: it.category };
    for (const [id, m] of Object.entries(EXTRA_META)) if (!this.meta[id]) this.meta[id] = { ...m };
    if (Array.isArray(lodIds)) this.lodIds = new Set(lodIds);
    await this.loadRemote();
    await this.refreshTuning(true);
  }

  // 远程模型映射（对象存储 URL）；静态托管（github.io）默认启用
  async loadRemote() {
    if (!this.remoteMode) return;
    const file = this.remoteSrc === 'oss'
      ? './data/remote-models-oss.json'
      : './data/remote-models.json';
    try {
      const r = await fetch(file, { cache: 'no-store' });
      if (!r.ok) return;
      const data = await r.json();
      this.remote = data.models || {};
    } catch { /* 远程映射可选 */ }
  }

  // asset-tuning.json 可能分批写盘，配置变化时按节流重新拉取
  async refreshTuning(force = false) {
    const now = Date.now();
    if (!force && now - this.tuningFetchedAt < 4000) return;
    this.tuningFetchedAt = now;
    try {
      const r = await fetch('./data/asset-tuning.json', { cache: 'no-store' });
      if (!r.ok) return;
      const data = await r.json();
      for (const [id, t] of Object.entries(data)) {
        if (!t || typeof t !== 'object') continue;
        this.tuning[id] = { ...(this.tuning[id] || {}), ...t };
      }
    } catch { /* 标定文件尚未产出 */ }
  }

  // 默认用演示 LOD（≈30% 面数 / 512 贴图），?hi=1 用原始件；LOD 缺失自动回退
  pathOf(id) {
    const useLod = !this.hi && this.lodIds && this.lodIds.has(id);
    const r = this.remoteMode ? this.remote[id] : null;
    if (r) {
      const url = useLod ? (r.lod || r.full) : (r.full || r.lod);
      if (url) return vurl(url);
    }
    if (useLod) return vurl(`./lod-models/${id}/model.glb`);
    return vurl(this.hiPathOf(id));
  }

  hiPathOf(id) {
    const r = this.remoteMode ? this.remote[id] : null;
    if (r && r.full) return r.full;
    return EXTRA_IDS.has(id) ? `./extra/models/${id}/model.glb` : `../models/${id}/model.glb`;
  }

  info(id) {
    const m = this.meta[id] || {};
    return { zh: m.zh || id, cat: m.cat || '', z: m.zh, category: m.cat };
  }

  fitOf(id) {
    const t = this.tuning[id] || {};
    if (t.fit) return t.fit;
    return guessFit(id);
  }

  has(id) { return this.templates.has(id); }

  // 批量加载，返回 { loaded, total } 进度
  async ensure(ids, onProgress, concurrency = 8) {
    const need = [...new Set(ids)].filter((id) => !this.templates.has(id) && !this.missing.has(id));
    const total = ids.length;
    let done = total - need.length;
    onProgress?.(done, total);
    let cursor = 0;
    const worker = async () => {
      while (cursor < need.length) {
        const id = need[cursor++];
        try {
          if (this.pending.has(id)) await this.pending.get(id);
          else {
            const p = this.loadOne(id);
            this.pending.set(id, p);
            await p;
            this.pending.delete(id);
          }
        } catch {
          this.missing.add(id);
        }
        done++;
        onProgress?.(done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, need.length) }, worker));
    return { total, done };
  }

  async loadOne(id) {
    let gltf = null;
    let usedLod = false;
    const primary = this.pathOf(id);
    try {
      gltf = await this.loader.loadAsync(primary);
      usedLod = primary.includes('/lod-models/')
        || Boolean(this.remoteMode && this.remote[id] && primary === this.remote[id].lod);
    } catch (e) {
      const alt = vurl(this.hiPathOf(id));
      if (alt === primary) throw e;
      gltf = await this.loader.loadAsync(alt);
    }
    if (usedLod) this.stats.lod++; else this.stats.hi++;
    const src = gltf.scene;
    src.updateMatrixWorld(true);
    const group = this.mergeScene(src);
    // 归一化
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const t = this.tuning[id] || {};
    // 归一化：scaleBy:'h' 按高度；否则 fit = 最长水平边（缺省按类别兜底）
    const fit = t.fit || guessFit(id);
    const scale = (t.scaleBy === 'h' && t.h && size.y > 1e-6) ? (t.h / size.y) : (fit / Math.max(size.x, size.z, 1e-4));
    const scaleY = Number(t.scaleY) || 1;
    const root = new THREE.Group();
    group.scale.set(scale, scale * scaleY, scale);
    group.position.set(0, 0, 0);
    root.add(group);
    root.updateMatrixWorld(true);
    const box2 = new THREE.Box3().setFromObject(root);
    group.position.set(-(box2.min.x + box2.max.x) / 2, -box2.min.y + (t.yOffset || 0), -(box2.min.z + box2.max.z) / 2);
    root.updateMatrixWorld(true);
    const size2 = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
    let tris = 0;
    root.traverse((o) => { if (o.isMesh && o.geometry) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
    const big = Math.max(size2.x, size2.z) > 0.75;
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = big;
      o.receiveShadow = true;
      o.frustumCulled = true;
      if (Array.isArray(o.material)) for (const m of o.material) { m.envMapIntensity = 0.32; }
      else if (o.material) o.material.envMapIntensity = 0.32;
    });
    this.templates.set(id, { root, size: size2, tris, fit, rotY: t.rotY || 0, rotX: t.rotX || 0, lod: usedLod, hMeta: t.h });
    return id;
  }

  // 多材质合并：减少 draw call（同一材质一个 mesh）
  mergeScene(src) {
    const meshes = [];
    src.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o); });
    if (meshes.length <= 1) return src;
    const groups = new Map();
    for (const m of meshes) {
      m.updateWorldMatrix(true, false);
      const key = Array.isArray(m.material) ? 'multi' : m.material.uuid;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    if (groups.size === 1 && groups.has('multi')) return src;
    const root = new THREE.Group();
    for (const [, list] of groups) {
      const mat = Array.isArray(list[0].material) ? null : list[0].material;
      const geos = [];
      try {
        for (const m of list) {
          const g = m.geometry.clone();
          g.applyMatrix4(m.matrixWorld);
          geos.push(g);
        }
        const merged = mergeGeometries(geos, false);
        if (merged && mat) {
          const mesh = new THREE.Mesh(merged, mat);
          mesh.name = list[0].name;
          root.add(mesh);
          continue;
        }
      } catch { /* 合并失败则退回原网格 */ }
      for (const m of list) root.add(m);
    }
    return root;
  }

  // clone 复用（几何/材质共享）
  instance(id, { x = 0, z = 0, y = 0, rotY = 0 } = {}) {
    const tpl = this.templates.get(id);
    if (!tpl) return null;
    const obj = tpl.root.clone(true);
    obj.position.set(x, y, z);
    obj.rotation.y = ((tpl.rotY + rotY) * DEG);
    if (tpl.rotX) obj.rotation.x = tpl.rotX * DEG;
    obj.userData.assetId = id;
    return obj;
  }
}

// 缺标定时的类别兜底尺寸（米）
function guessFit(id) {
  const s = id.toLowerCase();
  if (/cabinet|locker|shelf|bookcase|wardrobe|credenza/.test(s)) return 1.2;
  if (/worktable|workbench|workstation|desk|packing-table|conference-table/.test(s)) return 1.4;
  if (/sofa|bench|armchair|chair-lounge/.test(s)) return 1.4;
  if (/chair|stool/.test(s)) return 0.5;
  if (/monitor|screen|tv|display|viewer|panel/.test(s)) return 0.6;
  if (/table/.test(s)) return 0.9;
  if (/bin|box|container|holder|dispenser|tray|rack\b/.test(s)) return 0.4;
  if (/plant|planter/.test(s)) return 1.0;
  return 0.8;
}
