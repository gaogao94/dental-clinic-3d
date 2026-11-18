# 口腔诊所平台 · 3D 演示页 CONCEPT

> 目标：把「汽车平台 → 多车型」的逻辑，用已有的 351 件牙科诊所 3D 资产，演示成「口腔诊所平台 → 多门店类型 / 多风格」。
> 一句话逻辑：**同一个平台（冻结硬点 + 标准接口 + 模块库），换门店类型和风格，就能配置出不同诊所——平台件复用、差异件有限。**

## 1. 页面结构（单页，中文，1280–1600 宽桌面优先）

```
┌──────────────────────────────────────────────────────────────────────┐
│ 口腔诊所平台    [S·2椅] [M·4椅] [L·6椅]        [总览|前台|候诊|诊疗|消毒] [硬点] [平台件] │
├────────────┬─────────────────────────────────────────────┬───────────┤
│ 门店类型    │                                             │ 配置指标    │
│ 5 张卡片    │              3D 场景（可旋转/缩放/平移）        │ 面积/诊室/椅位│
│ (纵向)      │              房间标签、点选物件信息              │ 房间/平台件率 │
│            │                                             │ 衍生组合数   │
│ 选装模块    │                                             │ 本次配置清单  │
│ 开关列表    │                                             │ (分组计数)   │
├────────────┴─────────────────────────────────────────────┴───────────┤
│ 风格 4 色卡     ·     平台矩阵：5 个门店类型缩略平面图（点击切换）              │
└──────────────────────────────────────────────────────────────────────┘
```

- 无解释性文字、无副标题/说明段/操作提示；靠标题、标签、数字、颜色、图标自解释。
- 顶部「平台」= 汽车平台的硬点带宽：面积 / 诊室数 / 椅位数 / 模块槽位。
- 左「门店类型」= 车型：社区家庭店 / 儿童诊疗店 / 正畸中心 / 种植旗舰店 / 美学体验店。卡片显示：名称、面积、椅位、模块数、是否可用。
- 左「选装模块」= 配置单：影像室 / 技工室 / 儿童区 / 咨询室 / 咖啡吧 / 消毒升级；超出平台槽位时禁用。
- 右「配置指标」：建筑面积、诊室数、椅位、房间数、平台件复用率（%）、衍生组合数；下方配置清单按房间分组（房间名 + 物件数量）。
- 底部「风格」：4 个色卡（疗愈木 / 洁净蓝白 / 儿童糖果 / 极简黑白 / 暖奶油——选 4 个即可），切换即改墙面/地坪/木作/灯光色温，并替换少量软装变体。
- 底部「平台矩阵」：5 个门店类型的 SVG 平面缩略图（由同一套布局数据生成），点击切换。
- 右上「视角」：总览 / 前台 / 候诊 / 诊疗 / 消毒 —— 相机平滑飞入对应区域。
- 「硬点」开关：地面显示 水/电/气/排/网 五类点位（彩色圆点 + 图例 5 个小标签），对应汽车平台的冻结硬点。
- 「平台件」开关：共享件描边为青绿色、差异件描边为琥珀色；图例显示两类件数。

## 2. 平台 / 门店类型 / 风格 数据

### 平台（硬点带宽）
| id | 标签 | 建筑面积 | 平面尺寸(宽×深) | 诊室 | 椅位 | 模块槽位 |
|---|---|---|---|---|---|---|
| S | 平台 S · 90㎡ | 90㎡ | 9 × 10 m | 2 | 2 | 1 |
| M | 平台 M · 150㎡ | 150㎡ | 12 × 12.5 m | 4 | 4 | 2 |
| L | 平台 L · 240㎡ | 240㎡ | 15 × 16 m | 6 | 6 | 3 |

### 门店类型（车型）
| id | 名称 | 最低平台 | 必含房间 | 默认风格 | 差异点 |
|---|---|---|---|---|---|
| community | 社区家庭店 | S | 前台、候诊、诊疗室×2、消毒、卫生间、办公 | 洁净蓝白 | 标准成人牙椅；连排候诊椅；基础消毒 |
| kids | 儿童诊疗店 | S | 前台、儿童候诊、诊疗室×2（儿童椅）、消毒、卫生间、儿童洗手台 | 儿童糖果 | 儿童牙椅/玩具柜/滑梯/地垫/绘本架 |
| ortho | 正畸中心 | S | 前台、候诊、诊疗室×2（正畸椅）、咨询室、消毒、卫生间、办公 | 极简黑白 | 正畸牙椅、口扫、咨询室、全景影像（选装） |
| implant | 种植旗舰店 | M | 前台、候诊、诊疗室×4（高端椅）、影像室、消毒、卫生间、办公、咨询室 | 暖奶油 | 高端牙椅、CBCT、铅防护、种植机、咖啡吧（选装） |
| aesthetic | 美学体验店 | L | 前台、候诊、诊疗室×6（高端椅）、咨询室、咖啡吧、消毒、卫生间、办公、儿童角 | 疗愈木 | 高端椅、咖啡吧、儿童角、照片墙、绿植软装 |

说明：平台 S 只能开 community/kids/ortho；平台 M 增加 implant；平台 L 全部可开。切换平台时若当前类型不可用，自动切到第一个可用类型。

### 风格（内饰）
| id | 名称 | 墙面 | 地坪 | 木作 | 天花/灯光 | 点缀 |
|---|---|---|---|---|---|---|
| calm | 洁净蓝白 | #eef3f7 | #dfe6ec | #c9d4dd | 冷白 5000K | #4a90c2 |
| kids | 儿童糖果 | #fff6ef | #f2e3d5 | #e9c98e | 中性 4500K | #f2a65a |
| mono | 极简黑白 | #f7f7f7 | #d9d9d9 | #3d3f43 | 冷白 5500K | #2f6fed |
| wood | 疗愈木 | #f3ece2 | #d8c3a5 | #a9805b | 暖白 3500K | #7d9b76 |
| cream | 暖奶油 | #fbf5ec | #e8dccb | #d3b48f | 暖白 3800K | #c98b6b |

## 3. 3D 场景规格

- 引擎：three.js（本地 `../delivery/lib`：three.module.js + addons/loaders/GLTFLoader.js、addons/controls/OrbitControls.js、addons/environments/RoomEnvironment.js），用 importmap；禁止 CDN。
- 资产：`../models/<id>/model.glb`（351 件）+ 补充件在 `extra/models/<id>/model.glb`（天花空调、LED 平板灯、前台吊灯、咖啡吧台、铅防护门、候诊地毯、儿童帐篷、技工排风柜、感应玻璃门）。
- 每件模型加载后自动归一化：`scale = fitSize / max(bbox.x, bbox.z)`，底部对齐 y=0；`fitSize` 按物件真实尺寸给（牙椅 2.0、接待台 2.4、柜 1.2、沙发 1.6、显示器 0.62、马桶 0.7、冰箱 0.65、茶几 1.1 等，见 `asset-fitting.md`）。
- 同一资产多次出现：只加载一次，clone 复用。
- 建筑壳体程序化生成（不含 GLB）：地面板、2.8m 墙（0.12m 厚）、门洞（0.9×2.1m）、玻璃隔断（通透材质）、可选半透明天花；室内外色由风格决定。
- 家具按「房间模板 + 平台/类型参数」程序化摆放，位置以房间局部坐标计算；关键朝向（牙椅、前台桌、沙发、工作台、病床）按物件正面朝向标定（见 asset-facing 表）。
- 相机：透视 45°，OrbitControls（左键旋转、滚轮缩放、右键平移），限制到建筑外围；初始 3/4 俯视全景。视角切换 600ms 缓动飞入。
- 灯光：Hemisphere + Directional（阴影 2048）+ RoomEnvironment；色调由风格决定；地面接触阴影。
- 交互：点选物件 → 视口内小卡片显示「中文名 · 分类 · 平台件/差异件」；点选房间标签 → 飞入该房间；切换配置 350ms 淡出淡入。
- 房间标签：CSS 2D 覆盖层（投影坐标），小圆点 + 房间名，始终朝向屏幕。
- 性能：目标 45+ fps；实例数约 120–200；单一配置只加载用的到的资产（~50 个），首屏 loading 进度条（"加载 23/49"）。

## 4. 布局算法（工程实现建议）

`plan(platform, type, modules)` → rooms[]（矩形 w×d + 位置 x,z + 开口方向）：
1. 建筑外框 W×D。
2. 前区（深 4.2m）：接待台区（宽 ~45%）+ 候诊区；入口在正前方中点（感应玻璃门）。
3. 中部：2.0m 走廊沿东西向；走廊两侧各一排房间。
4. 后区（深 3.0m）：消毒室 / 卫生间 / 办公（或员工）/ 材料间，按宽度依次排布。
5. 中部两侧房间：诊室（约 3.2×3.6m）、影像室、技工室、儿童区、咨询室、咖啡吧，按类型与平台容量排布；每间必有门洞通向走廊。
6. 平台 S 的中部只放 2 诊室；M 放 4；L 放 6，且 L 的后区加员工区/材料间。
7. 结果缓存（key: platform+type+modules+style），切换同 key 不重建几何。

## 5. 资产选型（推荐，engineer 可微调但保持类别语义）

- 前台：reception-desk-curved / reception-desk-straight、receptionist-chair、monitor-27、reception-computer-tower、laser-printer、pos-terminal、queue-display-screen、brochure-rack、reception-planter、reception-pendant-light（补）
- 候诊：waiting-bench-3seat / waiting-bench-4seat、waiting-sofa-3seat / waiting-sofa-modular、armchair-single、coffee-table-rect / coffee-table-round、water-dispenser-floor、tv-wall-55、magazine-rack、waiting-planter-large、waiting-area-rug（补）、coffee-bar-counter（补）
- 诊疗室：dental-chair-*（成人/高端/儿童/正畸/种植按类型）、dentist-stool、assistant-stool、mobile-cabinet-two-drawer、dental-workstation-desk、chairside-monitor、cabinet-base-run、sink-cabinet、sensor-faucet、dental-cart、medical-waste-bin、sharps-container、surgical-light、led-xray-viewer、privacy-curtain、intraoral-camera、implant-motor（种植）、ortho 相关（口扫 intraoral-scanner）
- 消毒：autoclave-class-b、washer-disinfector、cleaning-sink-double、drying-cabinet、sealing-machine、stainless-worktable、sterile-storage-cabinet、ultrasonic-cleaner
- 影像：panoramic-xray、cbct-machine、imaging-workstation、diagnostic-monitor、lead-apron-rack、lead-shielding-screen、lead-lined-door（补）、radiation-warning-sign
- 技工：lab-workbench、plaster-mixer、curing-box、dust-extractor、resin-3d-printer、desktop-scanner、lab-fume-hood（补）
- 儿童：dental-chair-child(-cartoon)、kids-sink、toy-cabinet、kids-table-set、kids-indoor-slide、kids-play-carpet、picture-book-rack、kids-play-tent（补）
- 卫生间：toilet-floor、urinal、bathroom-vanity、bathroom-mirror、hand-dryer、accessibility-grab-bar
- 办公：office-desk / executive-desk、office-chair、office-file-cabinet、bookcase、office-safe、office-sofa、office-coffee-table
- 员工：locker-3door、locker-room-bench、staff-lounge-sofa、staff-break-table、refrigerator、microwave、coffee-machine
- 走廊：wayfinding-standee、wall-art、corridor-planter、corridor-wall-clock、fire-extinguisher、emergency-exit-sign、entrance-floor-mat、sanitizer-station
- 天花（补）：led-panel-light、ceiling-cassette-ac（每个房间按面积放 1–2 个）

## 6. 平台件 / 差异件定义

- 平台件：5 种门店类型都会用到的资产类型（接待台、标准牙椅、连排椅、边柜、消毒三件套、马桶、洁具、灭火器、导视…）→ 复用以降本。
- 差异件：只出现在个别类型（儿童牙椅/滑梯/帐篷、CBCT/铅门、咖啡吧台、咨询沙发、吊灯…）→ 差异化。
- 页面「平台件」开关：给两类的物件描边着色 + 图例计数；指标里的「平台件复用率」= 平台件类型数 / 总类型数。

## 7. 指标算法

- 面积：平台建筑面积（固定值）。
- 诊室 / 椅位：由当前类型 + 平台决定。
- 房间数：plan 的房间数。
- 平台件复用率：`sharedTypes / totalTypes`（按实际用到的资产类型去重统计）四舍五入。
- 衍生组合数：`可用门店类型数 × 风格数 × (1 + 可用选装模块组合数)`，页面上直接显示大数字。
- 配置清单：按房间分组显示「房间名 · 物件数」，不展开逐件。

## 8. 技术交付

- `dental/demo/index.html`（入口）+ `dental/demo/js/`（模块化：`scene.js`、`plan.js`、`config.js`、`ui.js`、`assets.js`、`styles.css`）
- `dental/demo/serve.mjs`：静态服务器，root = `dental/`；`dental/demo/打开演示.cmd`：启动服务并打开 `http://127.0.0.1:<port>/demo/index.html`
- `dental/demo/README.md`（10 行内）
- 自测：本地起服务 + Chrome headless 截图（可参考 `dental/tools/cdp_lite.mjs` / `final_gallery_check.mjs`），至少验证：首屏加载完成、切换平台/类型/风格/模块、点选物件、视角飞入、硬点/平台件开关。截图存 `dental/demo/shots/`。
- 严禁外链 CDN；严禁修改 `dental/models/`、`dental/logs/`、`dental/delivery/` 已交付内容。
