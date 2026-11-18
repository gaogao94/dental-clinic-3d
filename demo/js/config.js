// 平台 / 门店类型 / 风格 / 选装模块 / 硬点 数据定义
// 平台 = 汽车平台：固定的建筑带宽 + 硬点 + 模块槽位；门店类型 = 车型；风格 = 内饰。

export const PLATFORMS = {
  S: {
    id: 'S', label: 'S', area: 90, W: 9, D: 10, chairs: 2, slots: 1, connector: 1.6,
    bands: { front: 3.1, rowA: 3.0, corrA: 1.5, rowB: 2.4, corrB: 0, back: 0 },
    receptionRatio: 0.42,
    types: ['community', 'kids', 'ortho'],
  },
  M: {
    id: 'M', label: 'M', area: 150, W: 12, D: 12.5, chairs: 4, slots: 2, connector: 1.8,
    bands: { front: 4.2, rowA: 3.2, corrA: 1.8, rowB: 3.3, corrB: 0, back: 0 },
    receptionRatio: 0.42,
    types: ['community', 'kids', 'ortho', 'implant'],
  },
  L: {
    id: 'L', label: 'L', area: 240, W: 15, D: 16, chairs: 6, slots: 3, connector: 2.0,
    bands: { front: 4.0, rowA: 3.0, corrA: 1.7, rowB: 3.0, corrB: 1.7, back: 2.6 },
    receptionRatio: 0.40,
    types: ['community', 'kids', 'ortho', 'implant', 'aesthetic'],
  },
};
export const PLATFORM_ORDER = ['S', 'M', 'L'];

export const TYPES = [
  {
    id: 'community', name: '社区家庭店', short: '社区', min: 'S', style: 'calm',
    chair: 'dental-chair-adult', chairName: '标准成人牙椅',
    clinicName: '诊疗室', waitingName: '候诊区',
    note: '连排候诊 · 基础消毒',
    modules: [],
  },
  {
    id: 'kids', name: '儿童诊疗店', short: '儿童', min: 'S', style: 'kids',
    chair: 'dental-chair-child', chairName: '儿童牙椅',
    clinicName: '儿童诊疗室', waitingName: '儿童候诊区',
    note: '玩具柜 · 滑梯 · 地垫',
    modules: ['kids'],
  },
  {
    id: 'ortho', name: '正畸中心', short: '正畸', min: 'S', style: 'mono',
    chair: 'dental-chair-orthodontic', chairName: '正畸牙椅',
    clinicName: '正畸诊疗室', waitingName: '候诊区',
    note: '口扫 · 咨询室',
    modules: ['consult'],
  },
  {
    id: 'implant', name: '种植旗舰店', short: '种植', min: 'M', style: 'cream',
    chair: 'dental-chair-implant', chairName: '种植牙椅',
    clinicName: '种植诊疗室', waitingName: '候诊区',
    note: 'CBCT · 铅防护 · 种植机',
    modules: ['imaging', 'consult'],
  },
  {
    id: 'aesthetic', name: '美学体验店', short: '美学', min: 'L', style: 'wood',
    chair: 'dental-chair-deluxe', chairName: '高端牙椅',
    clinicName: '美学诊疗室', waitingName: '候诊区',
    note: '咖啡吧 · 照片墙 · 儿童角',
    modules: ['consult', 'coffee', 'kids'],
  },
];
export const TYPE_MAP = Object.fromEntries(TYPES.map((t) => [t.id, t]));

export const MODULES = [
  { id: 'imaging', name: '影像室', kind: 'room' },
  { id: 'lab', name: '技工室', kind: 'room' },
  { id: 'kids', name: '儿童区', kind: 'zone' },
  { id: 'consult', name: '咨询室', kind: 'room' },
  { id: 'coffee', name: '咖啡吧', kind: 'zone' },
  { id: 'sterile', name: '消毒升级', kind: 'equip' },
];
export const MODULE_MAP = Object.fromEntries(MODULES.map((m) => [m.id, m]));

export const STYLES = [
  {
    id: 'calm', name: '洁净蓝白', wall: '#eef3f7', floor: '#b3c3d3', wood: '#c9d4dd',
    accent: '#4a90c2', bg: '#e3eaf1', hemi: ['#f2f7fd', '#aab5c0'], sun: '#ffffff',
    temp: '冷白 5000K', exposure: 1.0,
    soft: { seat: 'waiting-bench-4seat', table: 'coffee-table-rect', art: 'wall-art' },
  },
  {
    id: 'kids', name: '儿童糖果', wall: '#fff6ef', floor: '#ddbd97', wood: '#e9c98e',
    accent: '#f2a65a', bg: '#f0e7dd', hemi: ['#fff7ee', '#c4ad95'], sun: '#fff6ea',
    temp: '中性 4500K', exposure: 1.04,
    soft: { seat: 'kids-waiting-bench', table: 'coffee-table-round', art: 'clinic-photo-wall' },
  },
  {
    id: 'mono', name: '极简黑白', wall: '#f4f4f4', floor: '#a8abad', wood: '#3d3f43',
    accent: '#2f6fed', bg: '#e4e5e7', hemi: ['#ffffff', '#9aa1a8'], sun: '#ffffff',
    temp: '冷白 5500K', exposure: 0.98,
    soft: { seat: 'waiting-sofa-3seat', table: 'coffee-table-round', art: 'clinic-photo-wall' },
  },
  {
    id: 'wood', name: '疗愈木', wall: '#f3ece2', floor: '#b99a72', wood: '#8a6242',
    accent: '#7d9b76', bg: '#e9e2d8', hemi: ['#fff4e6', '#a08a75'], sun: '#ffefda',
    temp: '暖白 3500K', exposure: 1.02,
    soft: { seat: 'waiting-bench-3seat', table: 'coffee-table-rect', art: 'wall-art' },
  },
  {
    id: 'cream', name: '暖奶油', wall: '#fbf5ec', floor: '#cdb59a', wood: '#c9a67e',
    accent: '#c98b6b', bg: '#ece4d9', hemi: ['#fff8ef', '#b39d87'], sun: '#fff0dc',
    temp: '暖白 3800K', exposure: 1.03,
    soft: { seat: 'waiting-sofa-modular', table: 'coffee-table-round', art: 'clinic-photo-wall' },
  },
];
export const STYLE_MAP = Object.fromEntries(STYLES.map((s) => [s.id, s]));

export const VIEWS = [
  { id: 'overview', name: '总览' },
  { id: 'reception', name: '前台' },
  { id: 'waiting', name: '候诊' },
  { id: 'clinic', name: '诊疗' },
  { id: 'steril', name: '消毒' },
];

export const HARD_KINDS = [
  { id: 'water', name: '水', color: '#3b82f6' },
  { id: 'power', name: '电', color: '#f59e0b' },
  { id: 'gas', name: '气', color: '#22c55e' },
  { id: 'drain', name: '排', color: '#a855f7' },
  { id: 'net', name: '网', color: '#ef4444' },
];

// 差异件（只服务个别门店类型）；其余为平台件
export const DIFF_IDS = new Set([
  'dental-chair-child', 'dental-chair-child-cartoon', 'dental-chair-orthodontic',
  'dental-chair-implant', 'dental-chair-deluxe',
  'cbct-machine', 'panoramic-xray', 'intraoral-xray-wall', 'imaging-positioning-chair',
  'lead-apron', 'lead-apron-rack', 'lead-collar', 'lead-shielding-screen',
  'lead-lined-door', 'radiation-warning-sign', 'dosimeter-badge-rack',
  'implant-motor', 'intraoral-scanner',
  'coffee-bar-counter', 'reception-pendant-light',
  'kids-waiting-bench', 'kids-waiting-sofa', 'kids-waiting-armchair', 'kids-table-set',
  'kids-play-carpet', 'kids-indoor-slide', 'kids-play-tent', 'kids-ball-pit',
  'toy-cabinet', 'picture-book-rack', 'reward-toy-cabinet', 'kids-sink', 'kids-tv',
  'kids-play-table', 'kids-play-chair', 'toy-shelf', 'kids-partition-shelf',
  'cartoon-decoration', 'teaching-tooth-model', 'brushing-teaching-board',
  'office-sofa', 'clinic-photo-wall', 'kids-step-stool',
]);

// 补充件（/demo/extra/models/<id>/model.glb）
export const EXTRA_IDS = new Set([
  'ceiling-cassette-ac', 'led-panel-light', 'reception-pendant-light', 'coffee-bar-counter',
  'lead-lined-door', 'waiting-area-rug', 'kids-play-tent', 'lab-fume-hood', 'clinic-entrance-door',
]);

export function typesForPlatform(platformId) {
  return PLATFORMS[platformId].types.map((id) => TYPE_MAP[id]);
}

export function moduleState(platformId, typeId, selectedModules) {
  const type = TYPE_MAP[typeId];
  const platform = PLATFORMS[platformId];
  const mandated = new Set(type.modules);
  const chosen = new Set([...type.modules, ...(selectedModules || [])].filter((m) => MODULE_MAP[m]));
  const free = platform.slots - mandated.size;
  let optionalCount = 0;
  for (const m of chosen) if (!mandated.has(m)) optionalCount++;
  const rows = MODULES.map((m) => {
    const isMandated = mandated.has(m.id);
    const isOn = chosen.has(m.id);
    const canToggle = !isMandated && (isOn || optionalCount < free);
    return { ...m, on: isOn, mandated: isMandated, disabled: !canToggle };
  });
  return { rows, free, used: mandated.size + optionalCount, slots: platform.slots, mandated, chosen };
}

// 衍生组合数 = 可用门店类型数 × 风格数 × Σ_{k=0..平台槽位} C(模块数, k)（随平台单调增）
export function combinationCount(platformId) {
  const platform = PLATFORMS[platformId];
  const n = MODULES.length;
  const C = (a, b) => {
    let r = 1;
    for (let i = 0; i < b; i++) r = (r * (a - i)) / (i + 1);
    return Math.round(r);
  };
  let sum = 0;
  for (let k = 0; k <= platform.slots; k++) sum += C(n, k);
  return platform.types.length * STYLES.length * sum;
}
