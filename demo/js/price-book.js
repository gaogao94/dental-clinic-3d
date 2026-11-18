// 价格库：造价估算用的单价 / 工效 / 费用参数（纯数据，商务可直接改数）
//
// 使用方式：只改数字，不要改 key（键名被 js/quote.js 引用，改了会算不出来）。
// 口径：金额单位 = 人民币元（含税，增值税见 taxRate）；工时单位 = 人天；面积 = ㎡；长度 = m。
// 改完刷新页面即生效；node 测试（dental/tools/verify-drawing-quote.mjs）不用重启。
//
// 结构速查：
//   styleFactor     风格系数（只乘硬装工程组）
//   areaRules       硬装按面积/长度计量（qty: area/usableArea/ceilingArea/partitionArea/extWallArea/intWallArea/perimeter）
//   countRules      硬装/机电按件数计量（qty: doors/glassArea/lightCount/acCount）
//   pointRules      机电五类硬点（水/电/气/排/网，按点位数量）
//   moduleRules     选装模块附加工程（影像=铅防护 / 技工=排风 / 消毒升级）
//   commission      系统联调与验收
//   itemPrices      家具与设备：按 asset id 的覆盖价（其余走 categoryPrices 分类兜底价）
//   categoryPrices  inventory.json 全 13 个分类的兜底单价
//   itemHours       单件安装工时覆盖（人天/件）；categoryHours 为分类兜底工效
//   assetCategories 资产 id → inventory 分类（浏览器端 meta.categoryOf 优先，node 端兜底）
//   design/manage   设计费 / 项目管理费（按 硬装+机电 造价百分比 + 工时）
//   labor.crews     各班组人数（工期 = ceil(工时 / 班组人数)，总工期 = 各阶段天数相加）

export const PRICE_BOOK = {
  version: '2026.11',
  currency: 'CNY',

  // 增值税率：税金 = 前四组合计 × taxRate；区间 = 总计 ×(1 ∓ rangePct)
  // 6% 为综合口径；装饰工程可按项目税务方案调整（简易计税约 3%、一般计税约 9%），由商务确定后直接改此数值。
  taxRate: 0.06,
  rangePct: 0.08,

  // 建筑构造参数（与 js/scene.js#_buildShell 一致，勿随意改）
  wallHeight: 2.8,        // 墙高（m），用于墙面/隔墙面积
  doorHeight: 2.1,        // 内门洞高（m）
  facade: {
    glassW: 3.6,          // 入口两侧玻璃带单条宽（m）
    glassOffset: 2.7,     // 玻璃带中心距入口中心（m）
    glassH: 2.45,         // 玻璃带高（m）
    entranceH: 2.45,      // 入口洞高（m，扣减外墙内表面积用）
  },

  // 兜底分类（meta.categoryOf 与 assetCategories 都查不到时用它）
  defaultCategory: '小型器械/耗材',

  // 风格系数：只作用「硬装工程」组
  styleFactor: { calm: 1.0, kids: 1.08, mono: 1.12, wood: 1.15, cream: 1.1 },

  // ── 一、硬装工程：面积 / 长度规则 ────────────────────────────────────────
  areaRules: [
    { id: 'floor', name: '地面工程（自流平+地胶/瓷砖）', group: '硬装工程', unit: '㎡', price: 215, hours: 0.05, qty: 'area' },
    { id: 'ceiling', name: '天花吊顶（矿棉板/铝扣板+龙骨）', group: '硬装工程', unit: '㎡', price: 152, hours: 0.055, qty: 'ceilingArea' },
    { id: 'wall-finish', name: '墙面涂装（外墙内表面批腻子+乳胶漆）', group: '硬装工程', unit: '㎡', price: 74, hours: 0.03, qty: 'extWallArea' },
    { id: 'partition', name: '隔墙系统（轻钢龙骨双面石膏板+隔音）', group: '硬装工程', unit: '㎡', price: 185, hours: 0.07, qty: 'partitionArea' },
    { id: 'partition-finish', name: '隔墙面层处理（双面批腻子+涂料）', group: '硬装工程', unit: '㎡', price: 44, hours: 0.025, qty: 'intWallArea' },
    { id: 'skirting', name: '踢脚线/收口/门套', group: '硬装工程', unit: 'm', price: 38, hours: 0.01, qty: 'perimeter' },
  ],

  // 按件数计量：门/幕墙（硬装）、灯具/空调（机电）
  countRules: [
    { id: 'door', name: '门窗工程（诊室门/入口感应门/五金）', group: '硬装工程', unit: '樘', price: 1700, hours: 0.3, qty: 'doors' },
    { id: 'curtain-wall', name: '入口玻璃幕墙（12mm 钢化+竖框）', group: '硬装工程', unit: '㎡', price: 880, hours: 0.06, qty: 'glassArea' },
    { id: 'lighting', name: 'LED 平板灯/线条灯', group: '机电与暖通', unit: '套', price: 330, hours: 0.08, qty: 'lightCount' },
    { id: 'ac', name: '天花嵌入式空调（风机盘管）', group: '机电与暖通', unit: '台', price: 2300, hours: 0.4, qty: 'acCount' },
  ],

  // ── 二、机电与暖通 ──────────────────────────────────────────────────────
  // 口腔诊所气路 = 压缩空气 + 负压吸引管路，单价按点偏高
  pointRules: [
    { kind: 'water', name: '给水管路及点位（PPR）', group: '机电与暖通', unit: '点', price: 900, hours: 0.4 },
    { kind: 'power', name: '强电回路及点位（含配电箱）', group: '机电与暖通', unit: '点', price: 640, hours: 0.3 },
    { kind: 'gas', name: '气路工程（压缩空气+负压吸引管路）', group: '机电与暖通', unit: '点', price: 2000, hours: 0.5 },
    { kind: 'drain', name: '排水管路及点位（PVC）', group: '机电与暖通', unit: '点', price: 850, hours: 0.4 },
    { kind: 'net', name: '弱电网络点位（网线+面板）', group: '机电与暖通', unit: '点', price: 350, hours: 0.15 },
  ],

  // 选装模块附加工程（module = js/config.js 的 module id）
  // 注：consult 含咨询室隔音+洽谈软装，并覆盖「加建咨询室使影像室净宽变窄、口内 X 光机减配」的差额，
  //     保证「加模块后总价不降」；下调此值会导致含影像的 L 平台组合加 consult 后总价反而下降。
  moduleRules: [
    { module: 'imaging', name: '铅防护工程（含铅玻璃观察窗+硫酸钡墙体+铅门+防护屏）', group: '机电与暖通', unit: '项', price: 55000, hours: 6 },
    { module: 'lab', name: '技工室排风工程（局部排风+活性炭）', group: '机电与暖通', unit: '项', price: 14000, hours: 3 },
    { module: 'sterile', name: '消毒升级（大容量灭菌+软化供水）', group: '机电与暖通', unit: '项', price: 22000, hours: 2 },
    { module: 'consult', name: '咨询室专项（隔断/软装/家具包）', group: '硬装工程', unit: '项', price: 36000, hours: 3 },
    { module: 'coffee', name: '咖啡吧水电改造（给排水+专线）', group: '机电与暖通', unit: '项', price: 10000, hours: 1.5 },
    { module: 'kids', name: '儿童区安全防护（软包/防撞/圆角）', group: '硬装工程', unit: '项', price: 8000, hours: 1.5 },
  ],

  // 系统联调与验收（固定价 + 按椅位增加工时）
  commission: { name: '系统联调与验收', group: '机电与暖通', unit: '项', price: 5500, hoursBase: 2, hoursPerChair: 0.5 },

  // ── 三、家具与设备：资产覆盖价（元/件，含税含就位安装）──────────────────
  // 其余未列资产走 categoryPrices 兜底；新增资产请同时补 assetCategories。
  itemPrices: {
    // —— 诊疗室（牙椅 7 种 + 诊室常规配置）——
    'dental-chair-adult': 65000,
    'dental-chair-deluxe': 168000,
    'dental-chair-left-hand': 68000,
    'dental-chair-orthodontic': 88000,
    'dental-chair-implant': 128000,
    'dental-chair-child': 58000,
    'dental-chair-child-cartoon': 62000,
    'dentist-stool': 1300,
    'assistant-stool': 1100,
    'mobile-cabinet-two-drawer': 900,
    'dental-cart': 2300,
    'cabinet-base-run': 1900,
    'upper-wall-cabinet': 1600,
    'sink-cabinet': 1800,
    'chairside-monitor': 3000,
    'dental-computer-tower': 2400,
    'dental-workstation-desk': 6500,
    'office-chair': 1300,
    'office-monitor': 950,
    'led-xray-viewer': 800,
    'surgical-light': 12000,
    'implant-motor': 48000,
    'intraoral-scanner': 130000,
    'ultrasonic-scaler': 6800,
    'intraoral-camera': 6800,
    'curing-light': 2800,
    'apex-locator': 4800,
    'endo-motor': 5200,
    'medical-waste-bin': 220,
    'hand-sanitizer-dispenser': 160,
    // —— 消毒供应室 ——
    'autoclave-class-b': 42000,
    'autoclave-class-n': 18000,
    'autoclave-large': 110000,
    'washer-disinfector': 85000,
    'ultrasonic-cleaner': 12000,
    'cleaning-sink-double': 8000,
    'drying-cabinet': 4500,
    'sealing-machine': 3200,
    'sterile-storage-cabinet': 3600,
    'stainless-worktable': 2600,
    'instrument-basket-rack': 400,
    'contaminated-waste-bin': 300,
    // —— 影像室 ——
    'cbct-machine': 300000,
    'panoramic-xray': 180000,
    'intraoral-xray-wall': 35000,
    'lead-apron-rack': 3200,
    'lead-shielding-screen': 8000,
    'lead-lined-door': 7500,
    'radiation-warning-sign': 1000,
    'lead-apron': 2800,
    'imaging-positioning-chair': 12000,
    'intraoral-sensor': 9000,
    // —— 技工室 ——
    'lab-workbench': 15000,
    'lab-material-cabinet': 2400,
    'curing-box': 2000,
    'dust-extractor': 4200,
    'desktop-scanner': 5800,
    'plaster-mixer': 2600,
    'resin-3d-printer': 45000,
    'lab-fume-hood': 16000,
    'dental-lab-motor': 6800,
    // —— 前台接待 ——
    'reception-desk-curved': 28000,
    'reception-desk-straight': 7200,
    'reception-back-cabinet': 6200,
    'receptionist-chair': 1100,
    'monitor-27': 1400,
    'monitor-24': 1200,
    'pos-terminal': 3200,
    'laser-printer': 2200,
    'brochure-rack': 550,
    'queue-display-screen': 4200,
    'reception-planter': 380,
    'reception-pendant-light': 2200,
    'umbrella-stand': 150,
    'decorative-vase': 220,
    // —— 候诊区 ——
    'waiting-bench-4seat': 6000,
    'waiting-bench-3seat': 5400,
    'waiting-sofa-modular': 7800,
    'waiting-sofa-2seat': 3600,
    'waiting-sofa-3seat': 4800,
    'armchair-single': 2300,
    'coffee-table-rect': 1600,
    'coffee-table-round': 1400,
    'waiting-area-rug': 2000,
    'meeting-room-display': 4500,
    'magazine-rack': 700,
    'water-dispenser-floor': 1100,
    'waiting-planter-large': 700,
    'wall-art': 500,
    // —— 儿童区 ——
    'kids-waiting-bench': 4200,
    'kids-play-carpet': 2000,
    'kids-table-set': 2800,
    'toy-cabinet': 1600,
    'picture-book-rack': 1000,
    'kids-indoor-slide': 4200,
    'kids-play-tent': 3200,
    'kids-tv': 3400,
    'kids-sink': 2600,
    'coffee-bar-counter': 16000,
    // —— 卫生间 ——
    'toilet-floor': 2600,
    'bathroom-vanity': 3000,
    'bathroom-mirror': 850,
    'hand-dryer': 1500,
    'bathroom-trash-bin': 200,
    'toilet-paper-holder': 160,
    'baby-changing-station': 2600,
    // —— 办公/院长室 ——
    'office-desk': 3000,
    'office-file-cabinet': 1200,
    'bookcase': 1400,
    'guest-chair': 1000,
    'office-sofa': 4600,
    'office-coffee-table': 2000,
    'office-potted-plant': 320,
    'office-printer': 1800,
    // —— 员工区 ——
    'locker-3door': 2400,
    'locker-room-bench': 1600,
    'staff-lounge-sofa': 4200,
    'staff-break-table': 1800,
    'microwave': 700,
    'coffee-machine': 4200,
    'refrigerator': 3600,
    'staff-wall-clock': 170,
    // —— 材料/药房 ——
    'heavy-duty-shelf': 2400,
    'medicine-cabinet': 4200,
    'packing-table': 2000,
    'material-supply-cart': 1600,
    // —— 公共/走廊 ——
    'corridor-planter': 380,
    'corridor-trash-bin': 270,
    'corridor-wall-clock': 240,
    'fire-extinguisher': 220,
    'entrance-floor-mat': 650,
    'clinic-entrance-door': 10500,
  },

  // 分类兜底单价（元/件）：inventory.json 的 13 个分类，分类名原样
  categoryPrices: {
    '前台接待': 3200,
    '候诊区': 1800,
    '诊疗室': 4500,
    '消毒供应室': 5200,
    '影像室': 15000,
    '技工室': 4800,
    '儿童区': 2200,
    '卫生间': 1600,
    '员工区': 2100,
    '办公/院长室': 2300,
    '材料/药房': 2600,
    '公共/走廊': 800,
    '小型器械/耗材': 350,
  },

  // 单件安装工时覆盖（人天/件）
  itemHours: {
    'dental-chair-adult': 1.0,
    'dental-chair-deluxe': 1.1,
    'dental-chair-left-hand': 1.0,
    'dental-chair-orthodontic': 1.0,
    'dental-chair-implant': 1.2,
    'dental-chair-child': 0.9,
    'dental-chair-child-cartoon': 1.0,
    'surgical-light': 0.6,
    'dental-workstation-desk': 0.4,
    'sink-cabinet': 0.5,
    'cabinet-base-run': 0.4,
    'upper-wall-cabinet': 0.25,
    'implant-motor': 0.2,
    'intraoral-scanner': 0.3,
    'ultrasonic-scaler': 0.2,
    'cbct-machine': 2.5,
    'panoramic-xray': 2.0,
    'intraoral-xray-wall': 1.0,
    'lead-lined-door': 0.6,
    'lead-shielding-screen': 0.4,
    'lead-apron-rack': 0.2,
    'autoclave-class-b': 0.8,
    'autoclave-class-n': 0.7,
    'autoclave-large': 1.5,
    'washer-disinfector': 1.2,
    'ultrasonic-cleaner': 0.3,
    'cleaning-sink-double': 0.8,
    'drying-cabinet': 0.6,
    'sealing-machine': 0.2,
    'sterile-storage-cabinet': 0.3,
    'stainless-worktable': 0.5,
    'lab-workbench': 0.8,
    'lab-fume-hood': 1.2,
    'resin-3d-printer': 0.6,
    'dust-extractor': 0.4,
    'plaster-mixer': 0.2,
    'desktop-scanner': 0.2,
    'reception-desk-curved': 0.6,
    'reception-back-cabinet': 0.4,
    'queue-display-screen': 0.3,
    'meeting-room-display': 0.3,
    'clinic-entrance-door': 1.0,
    'coffee-bar-counter': 0.5,
    'coffee-machine': 0.2,
    'kids-indoor-slide': 0.8,
    'kids-play-tent': 0.3,
    'waiting-area-rug': 0.1,
  },

  // 分类兜底安装工时（人天/件）
  categoryHours: {
    '前台接待': 0.22,
    '候诊区': 0.15,
    '诊疗室': 0.28,
    '消毒供应室': 0.35,
    '影像室': 0.8,
    '技工室': 0.35,
    '儿童区': 0.15,
    '卫生间': 0.2,
    '员工区': 0.15,
    '办公/院长室': 0.18,
    '材料/药房': 0.18,
    '公共/走廊': 0.06,
    '小型器械/耗材': 0.03,
  },

  // 家具与设备归组（契约固定 5 组，设备并入「家具与设备」）
  equipmentGroup: '家具与设备',

  // 资产分类兜底表（node 端无 meta.categoryOf 时用；分类名与 inventory.json 一致）
  assetCategories: {
    // 前台接待
    'reception-desk-curved': '前台接待',
    'reception-desk-straight': '前台接待',
    'reception-back-cabinet': '前台接待',
    'receptionist-chair': '前台接待',
    'monitor-27': '前台接待',
    'monitor-24': '前台接待',
    'pos-terminal': '前台接待',
    'laser-printer': '前台接待',
    'brochure-rack': '前台接待',
    'queue-display-screen': '前台接待',
    'reception-planter': '前台接待',
    'reception-pendant-light': '前台接待',
    'umbrella-stand': '前台接待',
    'decorative-vase': '前台接待',
    // 候诊区
    'waiting-bench-4seat': '候诊区',
    'waiting-bench-3seat': '候诊区',
    'waiting-sofa-modular': '候诊区',
    'waiting-sofa-2seat': '候诊区',
    'waiting-sofa-3seat': '候诊区',
    'armchair-single': '候诊区',
    'coffee-table-rect': '候诊区',
    'coffee-table-round': '候诊区',
    'waiting-area-rug': '候诊区',
    'meeting-room-display': '候诊区',
    'magazine-rack': '候诊区',
    'water-dispenser-floor': '候诊区',
    'waiting-planter-large': '候诊区',
    'coffee-bar-counter': '候诊区',
    // 诊疗室
    'dental-chair-adult': '诊疗室',
    'dental-chair-deluxe': '诊疗室',
    'dental-chair-left-hand': '诊疗室',
    'dental-chair-orthodontic': '诊疗室',
    'dental-chair-implant': '诊疗室',
    'dentist-stool': '诊疗室',
    'assistant-stool': '诊疗室',
    'mobile-cabinet-two-drawer': '诊疗室',
    'dental-cart': '诊疗室',
    'cabinet-base-run': '诊疗室',
    'upper-wall-cabinet': '诊疗室',
    'sink-cabinet': '诊疗室',
    'chairside-monitor': '诊疗室',
    'dental-computer-tower': '诊疗室',
    'dental-workstation-desk': '诊疗室',
    'led-xray-viewer': '诊疗室',
    'surgical-light': '诊疗室',
    'implant-motor': '诊疗室',
    'intraoral-scanner': '诊疗室',
    'ultrasonic-scaler': '诊疗室',
    'intraoral-camera': '诊疗室',
    'curing-light': '诊疗室',
    'apex-locator': '诊疗室',
    'endo-motor': '诊疗室',
    'medical-waste-bin': '诊疗室',
    'hand-sanitizer-dispenser': '诊疗室',
    // 消毒供应室
    'autoclave-class-b': '消毒供应室',
    'autoclave-class-n': '消毒供应室',
    'autoclave-large': '消毒供应室',
    'washer-disinfector': '消毒供应室',
    'ultrasonic-cleaner': '消毒供应室',
    'cleaning-sink-double': '消毒供应室',
    'drying-cabinet': '消毒供应室',
    'sealing-machine': '消毒供应室',
    'sterile-storage-cabinet': '消毒供应室',
    'stainless-worktable': '消毒供应室',
    'instrument-basket-rack': '消毒供应室',
    'contaminated-waste-bin': '消毒供应室',
    // 影像室
    'cbct-machine': '影像室',
    'panoramic-xray': '影像室',
    'intraoral-xray-wall': '影像室',
    'lead-apron-rack': '影像室',
    'lead-shielding-screen': '影像室',
    'lead-lined-door': '影像室',
    'radiation-warning-sign': '影像室',
    'lead-apron': '影像室',
    'imaging-positioning-chair': '影像室',
    'intraoral-sensor': '影像室',
    // 技工室
    'lab-workbench': '技工室',
    'lab-material-cabinet': '技工室',
    'curing-box': '技工室',
    'dust-extractor': '技工室',
    'desktop-scanner': '技工室',
    'plaster-mixer': '技工室',
    'resin-3d-printer': '技工室',
    'lab-fume-hood': '技工室',
    'dental-lab-motor': '技工室',
    // 儿童区
    'dental-chair-child': '儿童区',
    'dental-chair-child-cartoon': '儿童区',
    'kids-waiting-bench': '儿童区',
    'kids-play-carpet': '儿童区',
    'kids-table-set': '儿童区',
    'toy-cabinet': '儿童区',
    'picture-book-rack': '儿童区',
    'kids-indoor-slide': '儿童区',
    'kids-play-tent': '儿童区',
    'kids-tv': '儿童区',
    'kids-sink': '儿童区',
    // 卫生间
    'toilet-floor': '卫生间',
    'bathroom-vanity': '卫生间',
    'bathroom-mirror': '卫生间',
    'hand-dryer': '卫生间',
    'bathroom-trash-bin': '卫生间',
    'toilet-paper-holder': '卫生间',
    'baby-changing-station': '卫生间',
    // 员工区
    'locker-3door': '员工区',
    'locker-room-bench': '员工区',
    'staff-lounge-sofa': '员工区',
    'staff-break-table': '员工区',
    'microwave': '员工区',
    'coffee-machine': '员工区',
    'refrigerator': '员工区',
    'staff-wall-clock': '员工区',
    // 办公/院长室
    'office-desk': '办公/院长室',
    'office-file-cabinet': '办公/院长室',
    'bookcase': '办公/院长室',
    'guest-chair': '办公/院长室',
    'office-sofa': '办公/院长室',
    'office-coffee-table': '办公/院长室',
    'office-potted-plant': '办公/院长室',
    'office-printer': '办公/院长室',
    'office-chair': '办公/院长室',
    'office-monitor': '办公/院长室',
    // 材料/药房
    'heavy-duty-shelf': '材料/药房',
    'medicine-cabinet': '材料/药房',
    'packing-table': '材料/药房',
    'material-supply-cart': '材料/药房',
    // 公共/走廊
    'corridor-planter': '公共/走廊',
    'corridor-trash-bin': '公共/走廊',
    'corridor-wall-clock': '公共/走廊',
    'fire-extinguisher': '公共/走廊',
    'entrance-floor-mat': '公共/走廊',
    'clinic-entrance-door': '公共/走廊',
    'wall-art': '公共/走廊',
  },

  // ── 四、设计与管理费 ────────────────────────────────────────────────────
  // 设计费/管理费 = (硬装工程 + 机电与暖通) × feePct；工时 = 基础 + 按房间/椅位
  design: { feePct: 0.045, hoursBase: 6, hoursPerRoom: 0.45, hoursPerChair: 0.8 },
  manage: { feePct: 0.03, hoursBase: 2, hoursPerRoom: 0.15 },

  // ── 五、班组人数：工期天数 = ceil(该阶段工时 / 班组人数) ────────────────
  // 注：calendarDays 为净施工工期，不含设备采购周期、报建/消防/医疗执业审批时间；
  // 如需对外承诺日历工期，商务在此基础上另加相应周期。
  labor: { crews: { design: 3, build: 6, mep: 4, install: 3, commission: 2 } },
};
