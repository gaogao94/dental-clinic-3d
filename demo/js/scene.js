// three.js 场景：建筑壳体 / 家具实例 / 房间标签 / 硬点 / 平台件描边 / 相机飞入
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HARD_KINDS, DIFF_IDS } from './config.js';

const WALL_H = 2.8;
const WALL_T = 0.12;
const DEG = Math.PI / 180;

export class Viewer {
  constructor(container, lib, { onPick, onLabelClick, shadows = true, pixelRatio = 1.5 } = {}) {
    this.container = container;
    this.lib = lib;
    this.onPick = onPick;
    this.onLabelClick = onLabelClick;
    this.plan = null;
    this.style = null;
    this.itemObjects = [];
    this.disposers = [];
    this.outlineGeoms = new Map();
    this.tween = null;
    this.hardVisible = false;
    this.outlineVisible = false;
    this.focusRoomId = null;
    this.ceilingEnabled = false;
    this.shadows = shadows;
    this._pixelRatio = pixelRatio;
    this._dirty = true;
    this._envReady = false;
    this._init();
  }

  _init() {
    const renderer = new THREE.WebGLRenderer({
      antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this._pixelRatio));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = this.shadows;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.id = 'view-canvas';
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 300);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minPolarAngle = 0.12;
    this.controls.screenSpacePanning = false;
    this.controls.addEventListener('change', () => { this._dirty = true; });

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x777777, 0.85);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.0);
    this.sun.castShadow = this.shadows;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun);
    this.sun.target = new THREE.Object3D();
    this.scene.add(this.sun.target);
    this.fill = new THREE.DirectionalLight(0xffffff, 0.32);
    this.fill.position.set(-8, 9, -4);
    this.scene.add(this.fill);

    this.site = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 160),
      new THREE.MeshStandardMaterial({ color: 0xa7afb8, roughness: 1, metalness: 0 }),
    );
    this.site.rotation.x = -Math.PI / 2;
    this.site.position.y = -0.02;
    this.site.receiveShadow = true;
    this.scene.add(this.site);

    this.shellGroup = new THREE.Group();
    this.itemsGroup = new THREE.Group();
    this.outlineGroup = new THREE.Group();
    this.hardGroup = new THREE.Group();
    this.ceilGroup = new THREE.Group();
    this.scene.add(this.shellGroup, this.itemsGroup, this.outlineGroup, this.hardGroup, this.ceilGroup);

    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'label-layer';
    this.container.appendChild(this.labelLayer);
    this.labels = [];

    this._bindPointer();
    this._bindResize();
    this._last = performance.now();
    this.fps = 0;
    this._frames = 0;
    this._fpsTime = this._last;
    this.frameMs = 0;
    window.__viewerReady = false;
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // RoomEnvironment 首次渲染很贵（软渲染尤甚），推迟到真正要出画面前
  _ensureEnv() {
    if (this._envReady) return;
    this._envReady = true;
    try {
      this.pmrem = new THREE.PMREMGenerator(this.renderer);
      this.envTex = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environment = this.envTex;
    } catch (e) { console.warn('env failed', e); }
  }

  _bindResize() {
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.container);
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._dirty = true;
  }

  _bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return;
      this.pick(e.clientX, e.clientY);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      const hit = this.raycast(e.clientX, e.clientY);
      el.style.cursor = hit ? 'pointer' : 'grab';
    });
  }

  _pointerNdc(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  raycast(clientX, clientY) {
    if (!this.itemObjects.length) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(this._pointerNdc(clientX, clientY), this.camera);
    const hits = ray.intersectObjects(this.itemObjects, true);
    for (const h of hits) {
      let o = h.object;
      while (o && !o.userData.assetId) o = o.parent;
      if (o) return { object: o, point: h.point, assetId: o.userData.assetId };
    }
    return null;
  }

  pick(clientX, clientY) {
    const hit = this.raycast(clientX, clientY);
    this.onPick?.(hit ? { ...hit, clientX, clientY } : null);
  }

  _clear(group) {
    while (group.children.length) group.remove(group.children[0]);
  }

  // ── 建场景 ────────────────────────────────────────────────────────────
  setPlan(plan, state) {
    this._ensureEnv();
    this.plan = plan;
    this.state = state;
    this.style = state.styleDef;
    this._buildShell(plan, this.style);
    this._buildItems(plan);
    this._buildCeiling(plan.ceilingFixtures || []);
    this._buildHardPoints(plan);
    this._buildLabels(plan);
    this._applyStyle(this.style);
    this._applyVisibility();
    if (this.focusRoomId && !plan.rooms.some((r) => r.id === this.focusRoomId)) this.focusRoomId = null;
    this._applyFocus();
    if (!this._initialPoseDone) {
      this.setOverview(true);
      this._initialPoseDone = true;
    }
    window.__viewerReady = true;
    this.requestRender();
  }

  requestRender() { this._dirty = true; }

  // 同步渲染一帧（用于加载完成后立刻出画，避免灰块）
  renderNow() {
    this._ensureEnv();
    this._updateLabels();
    const t0 = performance.now();
    this.renderer.render(this.scene, this.camera);
    this.frameMs = performance.now() - t0;
    window.__frameMs = this.frameMs;
    this._dirty = false;
  }

  _mat(color, extra = {}) {
    return new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.92, metalness: 0.02, ...extra });
  }

  _buildShell(plan, style) {
    for (const ch of this.shellGroup.children) {
      ch.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
    this._clear(this.shellGroup);
    for (const d of this.disposers) { try { d(); } catch {} }
    this.disposers = [];
    const P = plan;
    const wallMat = this._mat(shade(style.wall, -0.03));
    const floorMat = this._mat(style.floor, { roughness: 0.58 });
    const ceilMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(style.wall), roughness: 1, transparent: true, opacity: 0.2,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0xdfeef4, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.18,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const accentMat = this._mat(style.accent, { roughness: 0.75 });
    const skirtingMat = this._mat(style.wood, { roughness: 0.72 });
    const track = (mat) => { this.disposers.push(() => mat.dispose()); return mat; };
    [wallMat, floorMat, ceilMat, glassMat, accentMat, skirtingMat].forEach(track);

    // 地面
    const slab = new THREE.Mesh(new THREE.BoxGeometry(P.W + 0.4, 0.16, P.D + 0.4), floorMat);
    slab.position.set(P.W / 2, -0.08, P.D / 2);
    slab.receiveShadow = true;
    this.shellGroup.add(slab);
    // 走廊地坪
    const corrMat = track(this._mat(shade(style.floor, -0.1), { roughness: 0.5 }));
    for (const c of plan.svg.corridors) {
      if (c.d < 0.05) continue;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(c.w, c.d), corrMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(c.x + c.w / 2, 0.005, c.z + c.d / 2);
      m.receiveShadow = true;
      this.shellGroup.add(m);
    }
    // 天花（半透明，吊顶存在感）
    this.ceilingMesh = new THREE.Mesh(new THREE.PlaneGeometry(P.W, P.D), ceilMat);
    this.ceilingMesh.rotation.x = -Math.PI / 2;
    this.ceilingMesh.position.set(P.W / 2, WALL_H, P.D / 2);
    this.shellGroup.add(this.ceilingMesh);

    // 墙体（外墙 + 内墙分开，便于近景降成 1.2m 半墙）
    const boxesExt = [];
    const boxesInt = [];
    const solidBox = (cx, cz, len, y0, y1, alongZ, arr) => {
      const h = y1 - y0;
      const g = new THREE.BoxGeometry(alongZ ? WALL_T : len, h, alongZ ? len : WALL_T);
      g.translate(cx, y0 + h / 2, cz);
      arr.push(g);
    };
    const wallZ2 = (z, x1, x2, openings = [], interior = false) => {
      const arr = interior ? boxesInt : boxesExt;
      for (const s of splitSegments(x1, x2, openings)) {
        if (s.end - s.start <= 0.001) continue;
        solidBox((s.start + s.end) / 2, z, s.end - s.start, s.lintel ? s.h : 0, WALL_H, false, arr);
      }
    };
    const wallX2 = (x, z1, z2, openings = [], interior = false) => {
      const arr = interior ? boxesInt : boxesExt;
      for (const s of splitSegments(z1, z2, openings)) {
        if (s.end - s.start <= 0.001) continue;
        solidBox(x, (s.start + s.end) / 2, s.end - s.start, s.lintel ? s.h : 0, WALL_H, true, arr);
      }
    };

    const usableW = P.usableW;
    const rowARooms = P.rooms.filter((r) => r.zone === 'rowA');
    const rowBRooms = P.rooms.filter((r) => r.zone === 'rowB');
    const backRooms = P.rooms.filter((r) => r.zone === 'back');
    const doorOpen = (list) => list.map((r) => ({ at: r.door.x, w: r.door.w, h: 2.1 }));

    // 外墙
    const frontGlass = [
      { at: plan.entranceX - 2.7, w: 3.6, h: 2.45, glass: true },
      { at: plan.entranceX + 2.7, w: 3.6, h: 2.45, glass: true },
    ];
    const entranceOpen = [{ at: plan.entranceX, w: plan.entranceW, h: 2.45 }];
    wallZ2(0, 0, P.W, [...frontGlass, ...entranceOpen]);
    wallZ2(P.D, 0, P.W);
    wallX2(0, 0, P.D);
    wallX2(P.W, 0, P.D);
    // 内墙
    wallZ2(plan.frontD, 0, usableW, [], true);
    wallZ2(plan.corrAz, 0, usableW, doorOpen(rowARooms), true);
    wallZ2(plan.corrAz + plan.corrAd, 0, usableW, doorOpen(rowBRooms), true);
    if (plan.backd > 0) {
      wallZ2(plan.corrBz + plan.corrBd, 0, usableW, doorOpen(backRooms), true);
      wallZ2(plan.corrBz, 0, usableW, [], true);
    }
    for (const z of ['rowA', 'rowB', 'back']) {
      const list = P.rooms.filter((r) => r.zone === z);
      if (!list.length) continue;
      const z0 = list[0].z, z1 = z0 + list[0].d;
      for (let i = 1; i < list.length; i++) wallX2(list[i].x, z0, z1, [], true);
      wallX2(usableW, z0, z1, [], true);
    }

    // 外墙常显；总览用 0.72m 矮隔墙，近景用半透明内墙（不挡视线也不让挂墙物件悬空）
    const mergeAll = (arr) => mergeGeometries(arr, false);
    const extGeo = mergeAll(boxesExt);
    const intGeo = mergeAll(boxesInt);
    const intLowGeo = intGeo.clone();
    {
      const pos = intLowGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) pos.setY(i, Math.min(pos.getY(i), 0.72));
      pos.needsUpdate = true;
      intLowGeo.computeBoundingSphere();
      intLowGeo.computeBoundingBox();
    }
    this.wallExt = new THREE.Mesh(extGeo, wallMat);
    this.wallExt.castShadow = true; this.wallExt.receiveShadow = true;
    this.wallIntLow = new THREE.Mesh(intLowGeo, wallMat);
    this.wallIntLow.castShadow = true; this.wallIntLow.receiveShadow = true;
    this.wallGhost = new THREE.Mesh(intGeo, new THREE.MeshStandardMaterial({
      color: shade(style.wall, -0.06), roughness: 1, transparent: true, opacity: 0.09,
      depthWrite: false, side: THREE.DoubleSide,
    }));
    this.wallGhost.visible = false;
    boxesExt.forEach((b) => b.dispose());
    boxesInt.forEach((b) => b.dispose());
    this.shellGroup.add(this.wallExt, this.wallIntLow, this.wallGhost);

    // 玻璃幕墙
    const glassBoxes = [];
    for (const g of frontGlass) {
      const gm = new THREE.BoxGeometry(g.w, g.h, 0.04);
      gm.translate(g.at, g.h / 2, 0);
      glassBoxes.push(gm);
    }
    const glassMerged = mergeGeometries(glassBoxes, false);
    glassBoxes.forEach((g) => g.dispose());
    const glassMesh = new THREE.Mesh(glassMerged, glassMat);
    this.shellGroup.add(glassMesh);
    // 幕墙竖框
    const frameMat = track(new THREE.MeshStandardMaterial({ color: 0x59606a, roughness: 0.5, metalness: 0.6 }));
    const frameBoxes = [];
    const frameXs = [plan.entranceX - 4.5, plan.entranceX - 2.7, plan.entranceX - 0.9, plan.entranceX + 0.9, plan.entranceX + 2.7, plan.entranceX + 4.5];
    for (const fx of frameXs) {
      if (fx < 0.1 || fx > P.W - 0.1) continue;
      const g = new THREE.BoxGeometry(0.07, WALL_H, 0.07);
      g.translate(fx, WALL_H / 2, 0);
      frameBoxes.push(g);
    }
    const frameMesh = new THREE.Mesh(mergeGeometries(frameBoxes, false), frameMat);
    frameBoxes.forEach((g) => g.dispose());
    this.shellGroup.add(frameMesh);

    // 前台背景主题墙
    const accW = Math.min(plan.reception.w * 0.78, 3.6);
    const acc = new THREE.Mesh(new THREE.BoxGeometry(accW, 2.34, 0.05), accentMat);
    acc.position.set(plan.reception.x + plan.reception.w / 2, 1.25, plan.frontD - WALL_T / 2 - 0.03);
    acc.receiveShadow = true;
    this.shellGroup.add(acc);

    // 门框
    const doorFrameMat = track(new THREE.MeshStandardMaterial({ color: 0x8b929c, roughness: 0.6, metalness: 0.4 }));
    const doorGeos = [];
    const doorList = [...rowARooms, ...rowBRooms, ...backRooms];
    for (const r of doorList) {
      const fz = r.door.side === 'north' ? r.z + r.d : r.z;
      for (const dx of [-r.door.w / 2, r.door.w / 2]) {
        const g = new THREE.BoxGeometry(0.06, 2.1, 0.06);
        g.translate(r.door.x + dx, 1.05, fz);
        doorGeos.push(g);
      }
      const top = new THREE.BoxGeometry(r.door.w + 0.12, 0.06, 0.06);
      top.translate(r.door.x, 2.13, fz);
      doorGeos.push(top);
    }
    this.doorFrameMesh = new THREE.Mesh(mergeGeometries(doorGeos, false), doorFrameMat);
    doorGeos.forEach((g) => g.dispose());
    this.shellGroup.add(this.doorFrameMesh);

    // 踢脚线（木作色，风格可见）
    const skirtGeos = [];
    for (const r of P.rooms) {
      if (r.kind === 'corridor') continue;
      const t = 0.04, h = 0.075, o = WALL_T / 2 + t / 2;
      const add = (x, z, w, d) => {
        const g = new THREE.BoxGeometry(w, h, d);
        g.translate(x, h / 2, z);
        skirtGeos.push(g);
      };
      add(r.x + r.w / 2, r.z + o, r.w - 0.04, t);
      add(r.x + r.w / 2, r.z + r.d - o, r.w - 0.04, t);
      add(r.x + o, r.z + r.d / 2, t, r.d - 0.04);
      add(r.x + r.w - o, r.z + r.d / 2, t, r.d - 0.04);
    }
    const skirtMesh = new THREE.Mesh(mergeGeometries(skirtGeos, false), skirtingMat);
    skirtGeos.forEach((g) => g.dispose());
    skirtMesh.receiveShadow = true;
    this.shellGroup.add(skirtMesh);

    // 阳光：从相机侧（前左）打光，阴影落在远离相机一侧
    const cx = P.W / 2, cz = P.D / 2;
    this.sun.position.set(cx - P.W * 0.62, Math.max(P.W, P.D) * 1.15, cz - P.D * 0.5);
    this.sun.target.position.set(cx, 0, cz);
    this.sun.target.updateMatrixWorld();
    if (this.fill) this.fill.position.set(cx + P.W * 0.6, Math.max(P.W, P.D) * 0.75, cz + P.D * 0.7);
    const shadowR = Math.max(P.W, P.D) * 0.85;
    this.sun.shadow.camera.left = -shadowR;
    this.sun.shadow.camera.right = shadowR;
    this.sun.shadow.camera.top = shadowR;
    this.sun.shadow.camera.bottom = -shadowR;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = Math.max(P.W, P.D) * 4;
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  _buildItems(plan) {
    this._clear(this.itemsGroup);
    this.itemObjects = [];
    this.outlineLines = [];
    const roomMap = new Map(plan.rooms.map((r) => [r.id, r]));
    const fallbackRect = { x: 0, z: 0, w: plan.W, d: plan.D };
    for (const item of plan.items) {
      const obj = this.lib.instance(item.asset, { x: item.x, z: item.z, y: item.y, rotY: item.rotY });
      if (!obj) continue;
      // 房间边界钳制：家具不得穿墙/出楼板
      const room = item.clamp
        ? { x: item.clamp[0], z: item.clamp[1], w: item.clamp[2] - item.clamp[0], d: item.clamp[3] - item.clamp[1] }
        : (roomMap.get(item.room) || fallbackRect);
      const b = new THREE.Box3().setFromObject(obj);
      const m = 0.06;
      let dx = 0, dz = 0;
      const rx0 = room.x + m, rx1 = room.x + room.w - m;
      const rz0 = room.z + m, rz1 = room.z + room.d - m;
      if (b.min.x < rx0) dx = rx0 - b.min.x;
      else if (b.max.x > rx1) dx = rx1 - b.max.x;
      if (b.min.z < rz0) dz = rz0 - b.min.z;
      else if (b.max.z > rz1) dz = rz1 - b.max.z;
      obj.position.x += dx;
      obj.position.z += dz;
      obj.userData.room = item.room;
      this.itemsGroup.add(obj);
      this.itemObjects.push(obj);
      // 平台件 / 差异件描边
      const tpl = this.lib.templates.get(item.asset);
      if (tpl) {
        let geo = this.outlineGeoms.get(item.asset);
        if (!geo) {
          const bg = new THREE.BoxGeometry(tpl.size.x, tpl.size.y, tpl.size.z);
          bg.translate(0, tpl.size.y / 2, 0);
          geo = new THREE.EdgesGeometry(bg);
          bg.dispose();
          this.outlineGeoms.set(item.asset, geo);
        }
        if (!this._outlineMats) {
          this._outlineMats = {
            shared: new THREE.LineBasicMaterial({ color: 0x0ea5a5, transparent: true, opacity: 0.85 }),
            diff: new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.9 }),
          };
        }
        const diff = this.state && this.state.diffSet ? this.state.diffSet.has(item.asset) : DIFF_IDS.has(item.asset);
        const line = new THREE.LineSegments(geo, diff ? this._outlineMats.diff : this._outlineMats.shared);
        line.renderOrder = 5;
        line.visible = this.outlineVisible;
        obj.add(line);
        this.outlineLines.push(line);
      }
    }
    this.outlineGroup.visible = false;
  }

  // 程序化天花：LED 平板灯 + 方形空调风口（贴吊顶，不遮挡俯视）
  _buildCeiling(fixtures) {
    this._clear(this.ceilGroup);
    if (!this._ceilRes) {
      this._ceilRes = {
        ledGeo: new THREE.BoxGeometry(0.62, 0.025, 0.62),
        acGeo: new THREE.BoxGeometry(0.62, 0.04, 0.62),
        grille: new THREE.BoxGeometry(0.5, 0.015, 0.06),
        ledMat: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff3d8, emissiveIntensity: 1.5, roughness: 0.9 }),
        acMat: new THREE.MeshStandardMaterial({ color: 0xe3e8ed, roughness: 0.7, metalness: 0.05 }),
        grilleMat: new THREE.MeshStandardMaterial({ color: 0xb8c0c8, roughness: 0.8 }),
      };
    }
    const r = this._ceilRes;
    for (const f of fixtures) {
      if (f.kind === 'light') {
        const m = new THREE.Mesh(r.ledGeo, r.ledMat);
        m.position.set(f.x, 2.785, f.z);
        this.ceilGroup.add(m);
      } else {
        const m = new THREE.Mesh(r.acGeo, r.acMat);
        m.position.set(f.x, 2.79, f.z);
        this.ceilGroup.add(m);
        for (const dz of [-0.16, 0, 0.16]) {
          const g = new THREE.Mesh(r.grille, r.grilleMat);
          g.position.set(f.x, 2.768, f.z + dz);
          this.ceilGroup.add(g);
        }
      }
    }
    this.ceilGroup.visible = this.ceilingEnabled && !this.focusRoomId;
  }

  _buildHardPoints(plan) {
    this._clear(this.hardGroup);
    if (!this._hardMats) {
      this._hardMats = {};
      for (const k of HARD_KINDS) {
        this._hardMats[k.id] = new THREE.MeshBasicMaterial({ color: new THREE.Color(k.color) });
      }
      this._hardRing = new THREE.RingGeometry(0.055, 0.085, 20);
      this._hardDot = new THREE.CircleGeometry(0.035, 16);
    }
    for (const p of plan.hardPoints) {
      const ring = new THREE.Mesh(this._hardRing, this._hardMats[p.kind]);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p.x, 0.012, p.z);
      const dot = new THREE.Mesh(this._hardDot, this._hardMats[p.kind]);
      dot.rotation.x = -Math.PI / 2;
      dot.position.set(p.x, 0.014, p.z);
      this.hardGroup.add(ring, dot);
    }
    this.hardGroup.visible = this.hardVisible;
  }

  _buildLabels(plan) {
    for (const l of this.labels) l.el.remove();
    this.labels = [];
    for (const r of plan.rooms) {
      if (r.kind === 'corridor') continue;
      const el = document.createElement('button');
      el.className = 'room-label' + (r.kind === 'reception' || r.kind === 'waiting' ? ' front' : '');
      el.innerHTML = `<i></i><span>${r.name}</span>`;
      el.addEventListener('click', (e) => { e.stopPropagation(); this.onLabelClick?.(r); });
      this.labelLayer.appendChild(el);
      this.labels.push({ el, room: r, pos: new THREE.Vector3(r.x + r.w / 2, 2.62, r.z + r.d / 2) });
    }
  }

  _applyStyle(style) {
    this.renderer.toneMappingExposure = (style.exposure || 1) * 0.92;
    this.hemi.color = new THREE.Color(style.hemi[0]);
    this.hemi.groundColor = new THREE.Color(style.hemi[1]);
    this.hemi.intensity = 0.38;
    this.sun.color = new THREE.Color(style.sun);
    this.sun.intensity = 1.35;
    if (this.fill) { this.fill.color = new THREE.Color(style.sun); this.fill.intensity = 0.22; }
    this.scene.background = new THREE.Color(style.bg);
  }

  _applyVisibility() {
    this.hardGroup.visible = this.hardVisible;
    for (const line of this.outlineLines || []) line.visible = this.outlineVisible;
  }

  // 近景模式：内墙半透明、只保留当前房间家具、天花隐藏
  _applyFocus() {
    const focus = this.focusRoomId;
    const inFocus = !!focus;
    if (this.wallExt) this.wallExt.visible = true;
    if (this.wallIntLow) this.wallIntLow.visible = !inFocus;
    if (this.wallGhost) this.wallGhost.visible = inFocus;
    if (this.ceilingMesh) this.ceilingMesh.visible = !inFocus && this.ceilingEnabled;
    if (this.ceilGroup) this.ceilGroup.visible = !inFocus && this.ceilingEnabled;
    if (this.doorFrameMesh) this.doorFrameMesh.visible = !inFocus;
    for (const o of this.itemObjects || []) o.visible = !inFocus || o.userData.room === focus;
    this._dirty = true;
  }

  setCeiling(v) {
    this.ceilingEnabled = !!v;
    this._applyFocus();
  }

  setHardPoints(v) { this.hardVisible = v; this.hardGroup.visible = v; this._dirty = true; }
  setOutlines(v) {
    this.outlineVisible = v;
    for (const line of this.outlineLines || []) line.visible = v;
    this._dirty = true;
  }

  // ── 相机 ──────────────────────────────────────────────────────────────
  overviewPose() {
    const P = this.plan;
    const target = new THREE.Vector3(P.W / 2, 0.55, P.D * 0.5);
    const dir = new THREE.Vector3(0.42, 0.72, -1.0).normalize();
    const dist = Math.max(P.W, P.D) * 1.58;
    return { pos: target.clone().addScaledVector(dir, dist), target };
  }

  roomPose(room) {
    const r = Math.max(room.w, room.d);
    const cx = room.x + room.w / 2, cz = room.z + room.d / 2;
    const target = new THREE.Vector3(cx, 0.6, cz);
    const dir = new THREE.Vector3(0.18, 0.94, -0.72).normalize();
    const dist = Math.max(3.8, r * 1.5);
    return { pos: target.clone().addScaledVector(dir, dist), target };
  }

  flyTo(pose, ms = 600) {
    this.tween = {
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPos: pose.pos.clone(),
      toTarget: pose.target.clone(),
      start: performance.now(), dur: ms,
    };
    this.controls.enabled = false;
  }

  setOverview(instant = false) {
    this.focusRoomId = null;
    this._applyFocus();
    const pose = this.overviewPose();
    if (instant) {
      this.camera.position.copy(pose.pos);
      this.controls.target.copy(pose.target);
      this.controls.update();
      this._dirty = true;
    } else this.flyTo(pose, 650);
  }

  setView(id) {
    if (!this.plan) return;
    if (id === 'overview') return this.setOverview();
    const P = this.plan;
    let room = null;
    if (id === 'reception') room = P.reception;
    else if (id === 'waiting') room = P.waiting;
    else if (id === 'clinic') room = P.rooms.find((r) => r.kind === 'clinic');
    else if (id === 'steril') room = P.rooms.find((r) => r.kind === 'steril');
    if (!room) return this.setOverview();
    this.focusRoomId = room.id;
    this._applyFocus();
    this.flyTo(this.roomPose(room), 650);
  }

  focusRoom(room) {
    this.focusRoomId = room.id;
    this._applyFocus();
    this.flyTo(this.roomPose(room), 600);
  }

  // ── 主循环：按需渲染（脏标记），空闲时零 GPU/CPU 开销 ─────────────────
  _loop(now) {
    requestAnimationFrame(this._loop);
    const dt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;
    if (this.tween) {
      const t = Math.min(1, (now - this.tween.start) / this.tween.dur);
      const e = easeInOut(t);
      this.camera.position.lerpVectors(this.tween.fromPos, this.tween.toPos, e);
      this.controls.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, e);
      if (t >= 1) { this.tween = null; this.controls.enabled = true; }
      this._dirty = true;
    }
    if (this.controls.update()) this._dirty = true;
    this._clampTarget();
    if (!this._dirty) return;
    this._dirty = false;
    const t0 = performance.now();
    this._updateLabels();
    this.renderer.render(this.scene, this.camera);
    const cost = performance.now() - t0;
    this.frameMs = this.frameMs ? this.frameMs * 0.8 + cost * 0.2 : cost;
    window.__frameMs = this.frameMs;
    this._frames++;
    if (now - this._fpsTime >= 1000) {
      this.fps = (this._frames * 1000) / (now - this._fpsTime);
      window.__fps = this.fps;
      this._frames = 0; this._fpsTime = now;
    }
    void dt;
  }

  _clampTarget() {
    const P = this.plan;
    if (!P) return;
    const t = this.controls.target;
    const m = 3;
    t.x = clamp(t.x, -m, P.W + m);
    t.z = clamp(t.z, -m, P.D + m);
    t.y = clamp(t.y, 0.2, 3.2);
    const dist = this.camera.position.distanceTo(t);
    this.controls.minDistance = 1.6;
    this.controls.maxDistance = Math.max(P.W, P.D) * 2.8;
  }

  _updateLabels() {
    if (!this.plan) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const v = new THREE.Vector3();
    for (const l of this.labels) {
      if (this.focusRoomId && l.room.id !== this.focusRoomId) { l.el.style.display = 'none'; continue; }
      v.copy(l.pos).project(this.camera);
      const visible = v.z < 1 && v.z > -1 && Math.abs(v.x) < 1.25 && Math.abs(v.y) < 1.25;
      if (!visible) { l.el.style.display = 'none'; continue; }
      l.el.style.display = 'flex';
      const x = (v.x * 0.5 + 0.5) * w;
      const y = (-v.y * 0.5 + 0.5) * h;
      l.el.style.transform = `translate(-50%,-50%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
    }
  }
}

function splitSegments(a, b, openings) {
  if (!openings || !openings.length) return [{ start: a, end: b }];
  const sorted = [...openings].sort((p, q) => p.at - q.at);
  const out = [];
  let cur = a;
  for (const o of sorted) {
    const s = Math.max(a, o.at - o.w / 2), e = Math.min(b, o.at + o.w / 2);
    if (s > cur) out.push({ start: cur, end: s });
    out.push({ start: s, end: e, lintel: true, h: o.h || 2.1 });
    cur = e;
  }
  if (cur < b) out.push({ start: cur, end: b });
  return out;
}

function shade(hex, amt) {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, clamp(hsl.l + amt, 0, 1));
  return c;
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
