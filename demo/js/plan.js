// 布局引擎：platform + type + modules + style → 房间 / 家具 / 硬点（纯函数，结果缓存）
import {
  PLATFORMS, TYPE_MAP, STYLE_MAP, MODULE_MAP, EXTRA_IDS, DIFF_IDS, HARD_KINDS,
} from './config.js';

export const FACE = { '+z': 0, '+x': 90, '-z': 180, '-x': 270 };
const cache = new Map();

export function buildPlan(state) {
  const key = [state.platform, state.type, state.style, [...(state.modules || [])].sort().join('+')].join('|');
  if (cache.has(key)) return cache.get(key);
  const plan = compute(state);
  cache.set(key, plan);
  return plan;
}

const WANT = {
  clinic: 3.3, steril: 2.7, toilet: 1.7, office: 2.5, imaging: 2.7, lab: 2.7,
  consult: 2.5, staff: 2.5, materials: 2.2,
};

function compute(state) {
  const P = PLATFORMS[state.platform];
  const type = TYPE_MAP[state.type];
  const style = STYLE_MAP[state.style];
  const mods = new Set([...type.modules, ...(state.modules || [])]);

  const W = P.W, D = P.D, conn = P.connector, usableW = W - conn;
  const b = P.bands;
  const frontD = b.front;
  const rowAz = frontD, rowAd = b.rowA;
  const corrAz = rowAz + rowAd, corrAd = b.corrA;
  const rowBz = corrAz + corrAd, rowBd = b.rowB;
  const corrBz = rowBz + rowBd, corrBd = b.corrB;
  const backz = corrBz + corrBd, backd = b.back;

  const receptionW = usableW * P.receptionRatio;
  const waitingX0 = 0, waitingW = usableW - receptionW;
  const receptionX0 = usableW - receptionW;
  const entranceX = Math.min(Math.max(W * 0.5, 1.4), W - 1.4);
  const entranceW = 1.8;

  const rooms = [];
  const items = [];
  let curRoom = null;
  const add = (asset, x, z, rot, o = {}) => {
    items.push({
      asset, x: round(x), z: round(z), rotY: ((rot % 360) + 360) % 360,
      y: o.y || 0, room: o.room || curRoom, mount: o.mount || 'floor',
      fallback: o.fallback || null, clamp: o.clamp || null,
    });
  };

  // ── 前区：候诊（西）+ 前台（东，靠竖向通道） ────────────────────────────
  const waiting = {
    id: 'waiting', name: type.waitingName, kind: 'waiting', x: waitingX0, z: 0,
    w: waitingW, d: frontD, zone: 'front', door: null,
  };
  const reception = {
    id: 'reception', name: '前台接待区', kind: 'reception', x: receptionX0, z: 0,
    w: receptionW, d: frontD, zone: 'front', door: null,
  };
  rooms.push(waiting, reception);
  const corridor = {
    id: 'corridor', name: '公共走廊', kind: 'corridor', x: 0, z: corrAz,
    w: W, d: D - corrAz, zone: 'corr', door: null,
  };
  rooms.push(corridor);

  // ── 房间编排 ────────────────────────────────────────────────────────────
  const rowA = [], rowB = [], back = [];
  const chairCount = P.chairs;
  const nA = Math.min(chairCount, 4);
  for (let i = 0; i < nA; i++) {
    rowA.push({ kind: 'clinic', name: `${type.clinicName} ${i + 1}`, idx: i + 1 });
  }
  for (let i = nA; i < chairCount; i++) {
    rowB.push({ kind: 'clinic', name: `${type.clinicName} ${i + 1}`, idx: i + 1 });
  }
  const core = [
    { kind: 'steril', name: '消毒室' },
    { kind: 'toilet', name: '卫生间' },
  ];
  const features = [];
  if (mods.has('imaging')) features.push({ kind: 'imaging', name: '影像室' });
  if (mods.has('lab')) features.push({ kind: 'lab', name: '技工室' });
  if (mods.has('consult')) features.push({ kind: 'consult', name: '咨询室' });
  const extraRooms = backd > 0
    ? [{ kind: 'office', name: '办公' }, { kind: 'staff', name: '员工室' }, { kind: 'materials', name: '材料间' }]
    : [{ kind: 'office', name: '办公' }];

  // 特征房间优先塞进 rowA（小平台），塞不下再进 rowB / 后区
  const featA = [];
  while (features.length && rowA.length + featA.length < 3) featA.push(features.shift());
  rowA.push(...featA);
  rowB.push(...core, ...features);
  if (backd > 0) back.push(...extraRooms);
  else rowB.push(...extraRooms);

  const bands = [
    ['rowA', rowA, rowAz, rowAd, 'north'],
    ['rowB', rowB, rowBz, rowBd, 'south'],
    ['back', back, backz, backd, 'south'],
  ];
  for (const [zone, list, z0, d, doorSide] of bands) {
    if (!list.length || d <= 0) continue;
    const want = list.map((r) => WANT[r.kind] || 2.5);
    const totalW = want.reduce((a, v) => a + v, 0);
    const scale = usableW / totalW;
    let x = 0;
    list.forEach((r, i) => {
      const w = want[i] * scale;
      const room = {
        id: `${zone}-${i + 1}`, name: r.name, kind: r.kind, x, z: z0, w, d,
        zone, door: { side: doorSide, x: x + w / 2, w: 0.9 },
        chair: r.kind === 'clinic' ? type.chair : null, idx: r.idx,
      };
      rooms.push(room);
      x += w;
    });
  }

  // ── 摆家具 ──────────────────────────────────────────────────────────────
  curRoom = waiting.id;
  placeWaiting(waiting, {
    entranceX, style, type, mods, add,
  });
  curRoom = reception.id;
  placeReceptionItems(reception, { style, entranceX, mods, add });

  for (const room of rooms) {
    if (['clinic', 'steril', 'toilet', 'office', 'imaging', 'lab', 'consult', 'staff', 'materials'].includes(room.kind)) {
      curRoom = room.id;
      if (room.kind === 'clinic') placeClinic(room, { type, mods, style, add });
      else if (room.kind === 'steril') placeSteril(room, { mods, add });
      else if (room.kind === 'toilet') placeToilet(room, { add });
      else if (room.kind === 'office') placeOffice(room, { add });
      else if (room.kind === 'imaging') placeImaging(room, { type, add });
      else if (room.kind === 'lab') placeLab(room, { add });
      else if (room.kind === 'consult') placeConsult(room, { add });
      else if (room.kind === 'staff') placeStaff(room, { add });
      else if (room.kind === 'materials') placeMaterials(room, { add });
    }
  }

  // 入口 + 走廊 + 天花
  curRoom = waiting.id;
  placeEntrance({ entranceX, W, frontD, add });
  curRoom = corridor.id;
  placeCorridor({ rooms, corrAz, corrAd, corrBz, corrBd, usableW, W, D, add });
  curRoom = null;
  const ceilingFixtures = [];
  placeCeiling({ rooms, frontD, corrAz, corrAd, corrBz, corrBd, add, fixtures: ceilingFixtures });

  // ── 硬点（只与平台有关，换类型/风格不动） ──────────────────────────────
  const hardPoints = buildHardPoints(P);

  // ── 汇总 ────────────────────────────────────────────────────────────────
  const assetIds = [...new Set(items.map((i) => i.asset))];
  const sharedIds = assetIds.filter((id) => !DIFF_IDS.has(id));
  const diffIds = assetIds.filter((id) => DIFF_IDS.has(id));
  const itemCounts = {};
  for (const it of items) itemCounts[it.room] = (itemCounts[it.room] || 0) + 1;

  const realRooms = rooms.filter((r) => r.kind !== 'corridor');
  return {
    platform: P.id, type: type.id, style: style.id,
    modules: [...mods],
    W, D, conn, usableW, frontD, corrAz, corrAd, corrBz, corrBd, backd,
    waiting, reception, entranceX, entranceW,
    rooms, itemCounts,
    items, hardPoints, ceilingFixtures,
    assetIds, sharedIds, diffIds,
    stats: {
      area: P.area, chairs: P.chairs, clinics: chairCount,
      roomCount: realRooms.length,
      sharedTypes: sharedIds.length, totalTypes: assetIds.length,
      reuse: assetIds.length ? Math.round((sharedIds.length / assetIds.length) * 100) : 0,
      itemCount: items.length,
    },
    // SVG 平面缩略图数据
    svg: {
      W, D, entranceX, entranceW,
      rects: rooms.filter((r) => r.kind !== 'corridor'),
      chairs: items.filter((i) => i.asset.startsWith('dental-chair')).map((i) => ({ x: i.x, z: i.z })),
      corridors: [
        { x: 0, z: corrAz, w: W, d: corrAd },
        ...(corrAd > 0 ? [{ x: 0, z: corrBz, w: W, d: corrBd }] : []),
        { x: usableW, z: frontD, w: conn, d: D - frontD },
      ],
    },
  };
}

// ── 前台 ──────────────────────────────────────────────────────────────────
function placeReceptionItems(room, { style, add, mods }) {
  const { x, z, w, d } = room;
  const deskX = x + w * 0.48;
  const deskZ = z + d * 0.6;
  add('reception-desk-curved', deskX, deskZ, FACE['-z']);
  add('reception-back-cabinet', x + w * 0.5, z + d - 0.24, FACE['-z']);
  add('receptionist-chair', deskX + 0.6, deskZ + 0.62, FACE['-z']);
  add('monitor-27', deskX - 0.42, deskZ + 0.1, FACE['-z'], { y: 0.9 });
  add('pos-terminal', deskX + 0.62, deskZ + 0.12, FACE['-z'], { y: 0.9 });
  add('laser-printer', deskX + 1.0, deskZ + 0.16, FACE['-z'], { y: 0.9 });
  add('brochure-rack', deskX + 1.42, deskZ + 0.95, 200);
  add('reception-planter', x + 0.32, z + 0.4, 0);
  add('queue-display-screen', x + w * 0.5, z + d - 0.1, FACE['-z'], { y: 1.9 });
  add('reception-pendant-light', deskX, deskZ, 0, { y: 1.92, mount: 'ceiling' });
  add('umbrella-stand', x + 0.28, z + d * 0.55, 0);
  add('decorative-vase', deskX - 0.95, deskZ - 0.25, 0, { y: 0.9 });
}

// ── 候诊 ──────────────────────────────────────────────────────────────────
function placeWaiting(room, { style, type, mods, add }) {
  const { x, z, w, d } = room;
  const kidClinic = type.id === 'kids';
  const kidsCorner = mods.has('kids');
  const coffee = mods.has('coffee');

  if (kidClinic) {
    const cx = x + w * 0.45;
    add('kids-waiting-bench', cx, z + 0.55, FACE['+z']);
    add('kids-play-carpet', x + w * 0.5, z + d * 0.52, 0);
    add('kids-table-set', x + w * 0.5, z + d * 0.52, FACE['+z']);
    add('toy-cabinet', x + 0.4, z + d - 0.38, FACE['-z']);
    add('picture-book-rack', x + w - 0.45, z + d - 0.35, FACE['-z']);
    if (w > 4.6) add('kids-indoor-slide', x + w - 1.0, z + 0.6, FACE['+x']);
    if (w > 3.6) add('kids-play-tent', x + w - 1.1, z + d * 0.68, FACE['+x']);
    add('kids-tv', x + w * 0.5, z + d - 0.1, FACE['-z'], { y: 1.6 });
    add('kids-sink', x + w - 0.4, z + 0.42, 0);
    add('waiting-planter-large', x + 0.42, z + 0.42, 0);
    if (coffee) add('coffee-bar-counter', x + w * 0.5, z + d - 0.42, FACE['-z']);
    return;
  }

  const primaryX = x + w * (kidsCorner ? 0.68 : 0.5);
  add(style.soft.seat, primaryX, z + 0.55, FACE['+z']);
  add(style.soft.table, primaryX, z + d * 0.52, FACE['+z']);
  add('waiting-area-rug', primaryX, z + d * 0.45, 0);
  add('meeting-room-display', primaryX, z + d - 0.1, FACE['-z'], { y: 1.55 });
  add('magazine-rack', primaryX + 1.45, z + 0.42, FACE['+z']);
  add('water-dispenser-floor', x + 0.38, z + d - 0.35, FACE['-z']);
  add('waiting-planter-large', x + w - 0.42, z + 0.42, 0);
  if (w > 4.6) add('armchair-single', x + 0.5, z + d - 0.55, FACE['+x']);
  if (w > 5.6) add('waiting-sofa-2seat', x + w - 1.0, z + d * 0.55, FACE['-x']);
  if (w > 5.0 && !coffee) add('wall-art', x + w - 0.75, z + d - 0.08, FACE['-z'], { y: 1.75 });
  if (coffee) add('coffee-bar-counter', x + w - 1.35, z + d - 0.42, FACE['-z']);
  if (kidsCorner) {
    // 儿童角：靠西侧，与成人候诊并列
    add('kids-play-carpet', x + 1.05, z + d * 0.55, 0);
    add('toy-cabinet', x + 0.32, z + d * 0.55, FACE['+x']);
    add('kids-table-set', x + 1.05, z + d * 0.55, FACE['+z']);
    if (w > 5.8) add('kids-play-tent', x + 1.85, z + d * 0.62, FACE['+z']);
    add('picture-book-rack', x + 1.9, z + 0.42, FACE['+z']);
    add('kids-indoor-slide', x + 0.55, z + 0.55, FACE['+z']);
  }
}

// 墙侧工具：区分「门墙」与「远门墙」，家具只贴远门墙，门口留通道
function walls(room) {
  const doorN = room.door.side === 'north';
  const farZ = doorN ? room.z + 0.36 : room.z + room.d - 0.36;
  const farRot = doorN ? FACE['+z'] : FACE['-z'];
  const doorWallZ = doorN ? room.z + room.d : room.z;
  const doorWallRot = doorN ? FACE['-z'] : FACE['+z'];
  return { doorN, farZ, farRot, doorWallZ, doorWallRot };
}

// ── 诊疗室 ────────────────────────────────────────────────────────────────
function placeClinic(room, { type, mods, style, add }) {
  const { x, z, w, d } = room;
  const { doorN, farZ, farRot, doorWallZ, doorWallRot } = walls(room);
  const cx = x + w / 2;
  const chairZ = z + d * 0.5;
  const toDoor = doorN ? FACE['+z'] : FACE['-z'];
  const headZ = doorN ? chairZ - 0.74 : chairZ + 0.74;
  const inward = doorN ? FACE['-z'] : FACE['+z']; // 从远墙指向房间中心
  const chairX = cx + 0.05;

  add(type.chair, chairX, chairZ, toDoor);
  add('surgical-light', chairX + 0.5, headZ, 0);
  add('dentist-stool', chairX - 0.9, chairZ + 0.14, FACE['+x']);
  add('assistant-stool', chairX + 0.92, chairZ - 0.2, FACE['-x']);
  add('dental-cart', chairX + 1.14, chairZ + 0.52, FACE['-x']);
  add('chairside-monitor', chairX + 1.04, chairZ - 0.52, FACE['-x'], { y: 1.02 });
  add('sink-cabinet', x + 0.36, z + d * 0.22, FACE['+x']);
  add('dental-workstation-desk', cx, farZ, farRot);
  add('office-chair', cx, farZ + (doorN ? 0.6 : -0.6), inward);
  add('office-monitor', cx, farZ, farRot, { y: 0.76 });
  add('led-xray-viewer', cx, doorN ? z + 0.09 : z + d - 0.09, farRot, { y: 1.68 });
  add('hand-sanitizer-dispenser', cx + 1.12, doorWallZ + (doorN ? -0.12 : 0.12), doorWallRot, { y: 1.3 });
  add('medical-waste-bin', x + w - 0.32, z + 0.32, 0);
  if (w > 2.9) add('mobile-cabinet-two-drawer', x + w - 0.4, chairZ + 0.72, FACE['-x']);
  if (w > 2.9) add('medical-waste-bin', x + w - 0.4, chairZ + 0.72, FACE['-x'], { y: 0.9 });
  if (w > 3.05) add('cabinet-base-run', x + w - 0.4, z + d * 0.72, FACE['-x']);
  if (w > 3.1) add('upper-wall-cabinet', x + 0.14, z + d * 0.62, FACE['+x'], { y: 1.62 });
  if (type.id === 'implant') add('implant-motor', chairX + 1.14, chairZ + 0.52, FACE['-x'], { y: 0.88 });
  if (type.id === 'ortho') add('intraoral-scanner', chairX - 1.18, chairZ - 0.3, FACE['+x'], { y: 0.9 });
  if (type.id === 'aesthetic') add('wall-art', cx, farZ, farRot, { y: 1.95 });
  add('dental-computer-tower', cx + (doorN ? 0.5 : -0.5), farZ + (doorN ? 0.32 : -0.32), 0, { y: 0.08 });
}

// ── 消毒室 ────────────────────────────────────────────────────────────────
function placeSteril(room, { mods, add }) {
  const { x, z, w, d } = room;
  const { doorN, farZ, farRot } = walls(room);
  add('stainless-worktable', x + w * 0.5, farZ, farRot);
  add('autoclave-class-b', x + w * 0.5 - 0.4, farZ, farRot, { y: 0.85 });
  add('sealing-machine', x + w * 0.5 + 0.4, farZ, farRot, { y: 0.85 });
  add('cleaning-sink-double', x + 0.42, z + d * 0.42, FACE['+x']);
  add('washer-disinfector', x + w - 0.5, z + d * 0.38, FACE['-x']);
  add('drying-cabinet', x + w * 0.5, doorN ? z + d - 0.36 : z + 0.36, doorN ? FACE['-z'] : FACE['+z']);
  add('sterile-storage-cabinet', x + w - 0.34, farZ + (doorN ? 0.9 : -0.9), FACE['-x']);
  add('ultrasonic-cleaner', x + 0.34, doorN ? z + 0.34 : z + d - 0.34, doorN ? FACE['+z'] : FACE['-z']);
  add('contaminated-waste-bin', x + 0.3, z + 0.3, 0);
  if (mods.has('sterile')) add('autoclave-large', x + w * 0.5 + 0.95, farZ, farRot);
  add('instrument-basket-rack', x + w * 0.5 - 0.95, farZ, farRot, { y: 0.88 });
}

// ── 卫生间 ────────────────────────────────────────────────────────────────
function placeToilet(room, { add }) {
  const { x, z, w, d } = room;
  const { doorN, farZ, farRot } = walls(room);
  add('toilet-floor', x + w * 0.42, farZ, farRot);
  add('bathroom-vanity', x + w - 0.36, z + d * 0.35, FACE['-x']);
  add('bathroom-mirror', x + w - 0.1, z + d * 0.35, FACE['-x'], { y: 1.55 });
  add('hand-dryer', x + w * 0.12, doorN ? z + d - 0.12 : z + 0.12, doorN ? FACE['-z'] : FACE['+z'], { y: 1.2 });
  add('bathroom-trash-bin', x + 0.3, z + 0.3, 0);
  add('toilet-paper-holder', x + w * 0.1, farZ, farRot, { y: 0.78 });
  if (w > 2.1) add('baby-changing-station', x + w - 0.14, doorN ? z + d * 0.7 : z + d * 0.3, FACE['-x'], { y: 1.1 });
}

// ── 办公 ──────────────────────────────────────────────────────────────────
function placeOffice(room, { add }) {
  const { x, z, w, d } = room;
  const { farZ, farRot } = walls(room);
  add('office-desk', x + w * 0.5, farZ, farRot);
  add('office-chair', x + w * 0.5, farZ + (farRot === FACE['+z'] ? 0.62 : -0.62), farRot === FACE['+z'] ? FACE['-z'] : FACE['+z']);
  add('office-monitor', x + w * 0.5, farZ, farRot, { y: 0.76 });
  add('office-file-cabinet', x + 0.34, z + d * 0.3, FACE['+x']);
  add('bookcase', x + w - 0.3, z + d * 0.55, FACE['-x']);
  add('office-printer', x + w - 0.55, farZ + (farRot === FACE['+z'] ? 0.55 : -0.55), FACE['+x']);
  add('office-potted-plant', x + w - 0.42, z + 0.35, 0);
  add('wall-art', x + w * 0.5, farZ, farRot, { y: 1.75 });
}

// ── 影像室 ────────────────────────────────────────────────────────────────
function placeImaging(room, { type, add }) {
  const { x, z, w, d } = room;
  const { doorN, farZ, farRot, doorWallZ, doorWallRot } = walls(room);
  const machine = type.id === 'ortho' ? 'panoramic-xray' : 'cbct-machine';
  add(machine, x + w - 0.55, z + d * 0.48, FACE['-x']);
  add('office-desk', x + w * 0.4, farZ, farRot);
  add('monitor-27', x + w * 0.4, farZ, farRot, { y: 0.85 });
  add('lead-apron-rack', x + 0.34, z + d * 0.45, FACE['+x']);
  add('lead-shielding-screen', x + w * 0.55, z + d * 0.55, FACE['+z']);
  add('radiation-warning-sign', x + w * 0.5, doorWallZ + (doorN ? -0.14 : 0.14), doorWallRot, { y: 2.02 });
  add('lead-lined-door', x + w * 0.5, doorWallZ + (doorN ? -0.04 : 0.04), doorWallRot);
  if (w > 2.5) add('intraoral-xray-wall', x + 0.1, z + d * 0.2, FACE['+x'], { y: 1.6 });
}

// ── 技工室 ────────────────────────────────────────────────────────────────
function placeLab(room, { add }) {
  const { x, z, w, d } = room;
  const { doorN, farZ, farRot, doorWallZ, doorWallRot } = walls(room);
  add('lab-workbench', x + w * 0.5, farZ, farRot);
  add('plaster-mixer', x + w * 0.5 - 0.5, farZ, farRot, { y: 0.85 });
  add('curing-box', x + w * 0.5 + 0.1, farZ, farRot, { y: 0.85 });
  add('desktop-scanner', x + w * 0.5 + 0.58, farZ, farRot, { y: 0.85 });
  add('dust-extractor', x + 0.34, z + d * 0.4, FACE['+x']);
  add('resin-3d-printer', x + w - 0.44, z + d * 0.4, FACE['-x']);
  add('lab-material-cabinet', x + w - 0.32, farZ + (doorN ? 0.75 : -0.75), FACE['-x']);
  add('lab-fume-hood', x + 0.46, doorWallZ + (doorN ? -0.42 : 0.42), doorWallRot);
}

// ── 咨询室 ────────────────────────────────────────────────────────────────
function placeConsult(room, { add }) {
  const { x, z, w, d } = room;
  const { doorN, farZ, farRot } = walls(room);
  add('office-sofa', x + w * 0.5, farZ, farRot);
  add('office-coffee-table', x + w * 0.5, farZ + (doorN ? 1.05 : -1.05), 0);
  add('guest-chair', x + w * 0.5 - 0.72, farZ + (doorN ? 2.0 : -2.0), doorN ? FACE['-z'] : FACE['+z']);
  add('guest-chair', x + w * 0.5 + 0.72, farZ + (doorN ? 2.0 : -2.0), doorN ? FACE['-z'] : FACE['+z']);
  add('bookcase', x + 0.3, z + d * 0.45, FACE['+x']);
  add('wall-art', x + w * 0.5, doorN ? z + 0.1 : z + d - 0.1, doorN ? FACE['+z'] : FACE['-z'], { y: 1.7 });
  add('decorative-vase', x + w - 0.35, z + d * 0.3, 0);
}

// ── 员工室 ────────────────────────────────────────────────────────────────
function placeStaff(room, { add }) {
  const { x, z, w, d } = room;
  const { doorN, farZ, farRot } = walls(room);
  add('locker-3door', x + w * 0.2, farZ, farRot);
  add('staff-lounge-sofa', x + w * 0.64, farZ, farRot);
  add('locker-room-bench', x + w * 0.64, farZ + (doorN ? 1.0 : -1.0), 0);
  add('staff-break-table', x + w * 0.28, farZ + (doorN ? 1.35 : -1.35), 0);
  add('microwave', x + w * 0.28, farZ + (doorN ? 1.35 : -1.35), 0, { y: 0.75 });
  add('coffee-machine', x + w * 0.28, farZ + (doorN ? 1.35 : -1.35), 0, { y: 0.75 });
  add('refrigerator', x + w - 0.42, z + d * 0.32, FACE['-x']);
  add('staff-wall-clock', x + w * 0.5, doorN ? z + 0.1 : z + d - 0.1, doorN ? FACE['+z'] : FACE['-z'], { y: 2.1 });
}

// ── 材料间 ────────────────────────────────────────────────────────────────
function placeMaterials(room, { add }) {
  const { x, z, w, d } = room;
  const { farZ, farRot } = walls(room);
  add('heavy-duty-shelf', x + w * 0.35, farZ, farRot);
  add('medicine-cabinet', x + w - 0.32, farZ, farRot);
  add('packing-table', x + w * 0.5, z + d * 0.5, 0);
  add('material-supply-cart', x + 0.4, z + d * 0.3, 0);
}

// ── 入口 ──────────────────────────────────────────────────────────────────
function placeEntrance({ entranceX, W, frontD, add }) {
  const clamp = [0.1, 0.1, W - 0.1, frontD - 0.1];
  add('entrance-floor-mat', entranceX, 0.62, 0, { clamp });
  add('clinic-entrance-door', entranceX, 0.1, FACE['+z'], { clamp });
}

// ── 走廊 ──────────────────────────────────────────────────────────────────
function placeCorridor({ rooms, corrAz, corrAd, corrBz, corrBd, usableW, W, D, add }) {
  const cz = corrAz + corrAd * 0.5;
  add('fire-extinguisher', 0.35, corrAz + 0.3, 0);
  add('corridor-trash-bin', usableW - 0.5, corrAz + corrAd - 0.35, 0);
  add('corridor-planter', 0.45, corrAz + corrAd - 0.3, 0);
  add('corridor-planter', usableW - 0.45, corrAz + 0.32, 0);
  add('corridor-wall-clock', 0.7, corrAz - 0.06, FACE['+z'], { y: 2.25 });
  add('wall-art', usableW * 0.5, corrAz - 0.06, FACE['+z'], { y: 1.7 });
  add('wall-art', usableW * 0.72, corrAz - 0.06, FACE['+z'], { y: 1.7 });
  if (corrBd > 0) {
    add('corridor-planter', 0.45, corrBz + corrBd * 0.5, 0);
    add('wall-art', usableW * 0.7, corrBz - 0.06, FACE['+z'], { y: 1.7 });
    add('corridor-planter', usableW - 0.5, corrBz + corrBd * 0.5, 0);
  }
}

// ── 天花（程序化灯具/风口，不用 GLB，避免遮挡俯视视线） ───────────────────
function placeCeiling({ rooms, frontD, corrAz, corrAd, corrBz, corrBd, add, fixtures }) {
  const roomsWithCeiling = rooms.filter((r) => ['clinic', 'steril', 'office', 'imaging', 'lab', 'consult', 'staff', 'materials', 'toilet', 'reception', 'waiting'].includes(r.kind));
  for (const r of roomsWithCeiling) {
    const cx = r.x + r.w * 0.5, cz = r.z + r.d * 0.5;
    fixtures.push({ kind: 'light', x: round(cx), z: round(cz), room: r.id });
    if (['clinic', 'waiting', 'reception', 'imaging', 'lab', 'office', 'consult'].includes(r.kind) && r.w > 2.2) {
      fixtures.push({ kind: 'ac', x: round(r.x + r.w * 0.28), z: round(r.z + r.d * 0.22), room: r.id });
    }
  }
  fixtures.push({ kind: 'light', x: round(0.8), z: round(corrAz + corrAd * 0.5), room: 'corridor' });
  if (corrAd > 0) fixtures.push({ kind: 'light', x: round(0.8), z: round(corrBz + corrBd * 0.5), room: 'corridor' });
}

// ── 硬点 ──────────────────────────────────────────────────────────────────
function buildHardPoints(P) {
  const b = P.bands, usableW = P.W - P.connector;
  const rowAz = b.front, rowAzEnd = rowAz + b.rowA;
  const corrAEnd = rowAzEnd + b.corrA;
  const rowBz = corrAEnd, rowBzEnd = rowBz + b.rowB;
  const pts = [];
  const nA = Math.min(P.chairs, 4), nB = P.chairs - nA;
  const kinds = HARD_KINDS.map((k) => k.id);
  // 每个诊疗室槽位：椅位 5 点（水/电/气/排/网）+ 洗手台 2 点
  const clinicPoints = (cx, cz) => {
    const offs = [[-0.52, -0.42], [0.5, 0.38], [-0.38, 0.5], [0.46, -0.52], [0.72, 0.06]];
    kinds.forEach((k, i) => pts.push({ x: round(cx + offs[i][0]), z: round(cz + offs[i][1]), kind: k }));
    pts.push({ x: round(cx - 1.05), z: round(cz - 0.55), kind: 'water' });
    pts.push({ x: round(cx - 1.05), z: round(cz - 0.05), kind: 'drain' });
  };
  for (let i = 0; i < nA; i++) clinicPoints((i + 0.5) * usableW / nA, rowAz + b.rowA * 0.55);
  for (let i = 0; i < nB; i++) clinicPoints((i + 0.5) * usableW / nB, rowBz + b.rowB * 0.55);
  // 消毒室 4 点（水/电/排/气）—— 平台固定锚点
  const sz = rowBzEnd - b.rowB * 0.35;
  [['water', -0.5], ['power', 0.1], ['drain', 0.6], ['gas', 0.95]].forEach(([k, dx]) => {
    pts.push({ x: round(usableW * 0.18 + dx), z: round(sz), kind: k });
  });
  // 前台 2 点（电/网）
  pts.push({ x: round(usableW * 0.55), z: round(b.front * 0.55), kind: 'power' });
  pts.push({ x: round(usableW * 0.62), z: round(b.front * 0.5), kind: 'net' });
  return pts;
}

function round(v) { return Math.round(v * 1000) / 1000; }
