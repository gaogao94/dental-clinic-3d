# 出图 · 算量 · 估价 —— 接口契约（v1，2026-11-13）

本文件是「根据当前配置生成 CAD 图 + 估算工时和造价」功能的**唯一接口契约**。所有并行开发的
成员以本文件为准；改契约必须先由 Lead 更新本文件并通知全员。

## 0. 工作区与基线

- 工作目录：`D:\coding\qunhe_3d`
- **规范副本（canonical，所有功能改动只写这里）**：`dental/server/public/demo/`
- 本地演示副本（最后同步，不要在开发期改）：`dental/demo/`
- 基线：`git pull` 后的 `main`（最新 commit `48188eb`），不要提交、不要 rebase、不要动 `dental/models/`、`dental/logs/`、`dental/delivery/`。
- 纯前端静态页：无构建步骤、无 npm 依赖、无 CDN、ES module + importmap（three 走本地 `lib/`）。
- 浏览器端模块之间用 `?v=20261113-8` 缓存版本号（只在 `index.html`/`main.js`/`ui.js`/`sheet.js` 的 import 上加，
  纯模块互相 import **不加** 版本号，保证 node 能直接 import 做测试）。

## 1. 新增文件

| 文件 | 归属 | 说明 |
|---|---|---|
| `dental/server/public/demo/js/footprint.js` | Lead（已生成） | 119 件资产平面尺寸表 `FOOTPRINTS[id]=[w,d,h]` + `footprintOf(id)` |
| `dental/server/public/demo/js/cad.js` | cad-engine | 平面图/点位图/工程量表 → DXF / SVG（纯模块） |
| `dental/server/public/demo/js/quote.js` | quote-engine | 工程量 + 工时 + 造价（纯模块） |
| `dental/server/public/demo/js/price-book.js` | quote-engine | 单价/工效数据（纯模块，可被商务直接改数） |
| `dental/server/public/demo/js/sheet.js` | ui-sheet | 出图与报价浮层：预览 + 下载 + 打印（浏览器端） |
| `dental/tools/dump-footprints.mjs` | Lead | footprint 数据生成脚本（Lead 从 `_lead_scratch` 迁入） |

**禁止**修改 `js/plan.js` / `js/config.js` / `js/scene.js` / `js/assets.js`（如需数据缺口，找 Lead）。

## 2. 现有数据源（plan）

`buildPlan({platform,type,style,modules})`（`js/plan.js`，纯函数、有缓存）返回：

```
W, D                        // 建筑外框（米）
usableW                     // W - conn（conn 为东侧竖向通道宽）
frontD, corrAz, corrAd, corrBz, corrBd, backd
rooms[]                     // {id,name,kind,x,z,w,d,zone,door:{side:'north'|'south',x,w}|null,chair,idx}
                            //   kind: waiting reception clinic steril toilet office imaging lab consult staff materials corridor
                            //   zone: front | rowA | rowB | back | corr
items[]                     // {asset,x,z,rotY,y,room,mount,fallback,clamp}
hardPoints[]                // {x,z,kind}   kind: water power gas drain net
ceilingFixtures[]           // {kind:'light'|'ac',x,z,room}
assetIds/sharedIds/diffIds/itemCounts
stats{area,chairs,clinics,roomCount,sharedTypes,totalTypes,reuse,itemCount}
svg{W,D,entranceX,entranceW,rects[],chairs[],corridors[{x,z,w,d}]}
platform,type,style,modules
```

坐标约定：x 向东（0→W），z 向南（0 前立面→D 后墙），单位米；`rotY` 角度制，0=正面朝 +Z；
**门洞位置**：`side==='north'` 时洞口在 `z+d` 墙，`'south'` 时在 `z` 墙，中心 x=`door.x`，宽 `door.w`（0.9m）。

墙体真值以 `js/scene.js#_buildShell` 为准（CAD 必须复刻同一套墙线，含门洞）：
- 外墙：`z=0`（含 `entranceX±entranceW/2` 入口洞、两侧玻璃带）。`z=D`、`x=0`、`x=W` 无洞。
- 内墙：`z=frontD`(0→usableW)、`z=corrAz`(rowA 门洞)、`z=corrAz+corrAd`(rowB 门洞)、
  `z=corrBz+corrBd`(back 门洞)、`z=corrBz`；各 band 内相邻房间分界 `wallX2(room.x)`、
  band 末 `wallX2(usableW)`。墙厚 120mm（中心线两侧各 60）。

平面尺寸表：`import { footprintOf } from './footprint.js'` → `{w,d,h,exact}`（米，已按 rotY=0 转正，
CAD 里只需再按 `item.rotY` 旋转矩形）。

## 3. `js/cad.js` 契约（cad-engine 负责）

纯 ESM 模块，**不得 import three.js / DOM / fetch**；只 import `./footprint.js`（可 import config.js 里的常量）。

```js
export const CAD_UNITS = 'mm';                 // 输出 DXF 单位 = 毫米（1:1），图框 = 图纸尺寸×比例分母
export function buildDrawing(plan, opts = {})  // → Drawing
export function toDXF(drawing)                 // → string（DXF R2007 / AC1021，UTF-8，可被 ezdxf/AutoCAD 打开）
export function toSVG(drawing, opts = {})      // → string（整卷 SVG，供页面预览/打印；opts.sheet 可只取一页）
export function drawingStats(drawing)          // → {sheets, entities, layers, byLayer:{layer:count}}
```

### 3.1 图面模型（全部坐标 = 模型空间毫米）

```js
Drawing = {
  kind: 'cad-drawing', version: 1, units: 'mm',
  project: {
    title: '口腔诊所平面布置图', platform, platformLabel, typeName, styleName,
    area /*㎡*/, chairs, clinics, roomCount, itemCount,
    date: 'YYYY-MM-DD', stage: '方案设计',
  },
  sheets: [Sheet],
}
Sheet = { id:'plan'|'mep'|'boq', name:'平面布置图'|'机电点位图'|'工程量与估价表', no:'ADS-01-01',
          paper:'A2', scaleDen:100, frame:{x,y,w,h}, inner:{x,y,w,h}, entities:[Entity] }
Entity =
  { t:'line',   layer, x1,y1,x2,y2 }
| { t:'poly',   layer, pts:[[x,y],...], closed?:bool }
| { t:'circle', layer, x,y,r }
| { t:'text',   layer, x,y, h, text, align?:'left'|'center'|'right', anchor?:'base'|'middle' }
| { t:'solid',  layer, pts:[[x,y]x4] }          // 实心填充（箭头等），DXF 输出 SOLID 注意 3/4 点顺序
```

图层名（中文，DXF 里直接可见；颜色用 ACI 索引）：

| 图层 | 用途 | ACI |
|---|---|---|
| `A-外墙` | 外墙双线 | 7（白） |
| `A-内墙` | 内墙双线 | 7 |
| `A-门` | 门扇+开启弧 | 3（绿） |
| `A-家具` | 家具/设备轮廓 | 8（灰，虚线可选） |
| `A-文字` | 房间名/面积/家具名 | 7 |
| `A-标注` | 尺寸线/标注文字 | 4（青） |
| `M-给水` `M-排水` `E-强电` `E-弱电` `G-气` | 硬点五类（含点位图符号） | 5/6/2/1/3 按 `HARD_KINDS` 对应色语义 |
| `A-图例` | 图例/说明 | 7 |
| `TK-图框` | 图框 + 标题栏 | 7 |

字号（模型毫米）：房间名 350、房间尺寸/面积 200、家具名 200、标注 250、图框标题 500、表头 250、表格正文 200。

### 3.2 三张图页（必须全有；第 3 页仅在 `opts.boq` 提供时生成）

**页 1 `平面布置图`**
- 图框 + 标题栏（右下，含：项目名/门店类型/平台/风格/面积/椅位/房间数/图号/比例/日期/阶段；
  若 `drawing.project.quoteSummary` 存在，加「估价（元）」「工时（人天）」两格）。
- 墙体双线（外墙、内墙，含门洞断口）；门扇 45° + 开启弧（弧用 `poly` 折线近似，步长 ≤15°）；
  入口（`entranceX`，宽 `entranceW`）画推拉门符号 + 「入口」文字 + 箭头。
- 房间名（居中，350）+ 净尺寸 `w×d`（200）+ 面积（200，1 位小数）。
- 家具/设备 footprint（按 `item.rotY` 旋转的矩形，米→毫米 ×1000），最大边 ≥0.9m 的物件加名称标签
  （名称来源 `opts.meta.nameOf(id)`，缺省用 id），标签不超出矩形外接范围过多（可偏移到矩形中心下方）。
- 尺寸标注：底部总体 W、左侧总体 D、走廊净宽 `corrAd`（各带尺寸界线+箭头+文字）。
- 家具与硬点/门窗不得占用走廊净宽（只画布置，不做碰撞断言）。

**页 2 `机电点位图`**
- 图框 + 标题栏（标题「机电点位图」）。
- 墙线单线（thin）+ 房间轮廓 + 房间名（250）。
- 五类硬点符号：圆 r=120 + 类目字（水/电/气/排/网），落在 `A-*` 图层；同点位半径按需要错开 300 以上避免重叠。
- 右下角图例表：类目 / 符号 / 数量，合计点位行。

**页 3 `工程量与估价表`**（`opts.boq = quote` 时）
- 图框 + 标题栏（标题「工程量与估价表」）。
- 表格列：序号 | 项目 | 规格 | 单位 | 数量 | 单价(元) | 合价(元) | 工时(人天)。
- 分组行（硬装工程/机电与暖通/家具与设备/设计与管理）加底纹（`solid` 矩形）粗体，组末小计。
- 表尾：合计、税金、总计、单方造价、每椅造价、总工时、工期（天）、金额大写。
- 行数超一页时自动续页（`sheet.no` 依次递增，标题栏保持）；**任何情况不得裁切行**。

### 3.3 DXF 硬性要求
- 版本 AC1021（R2007+，UTF-8 中文直写）；`$INSUNITS=4`（mm）、`$MEASUREMENT=1`、`$EXTMIN/$EXTMAX` 正确。
- HEADER / TABLES(LTYPE, LAYER, STYLE) / BLOCKS(空) / ENTITIES / EOF 齐全；实体有合法 layer 引用。
- 文本样式 `CN`（font `simsun.ttc`），TEXT 高度按实体 h。
- 不能出现 `NaN` / `Infinity` / 空图层名；`ezdxf.readfile()` 必须无错通过（QA 负责）。
- 整卷（所有图页）横向并排摆放在模型空间，页间距 2000mm。SVG 与 DXF 的几何必须一致（同一 Drawing）。

## 4. `js/quote.js` + `js/price-book.js` 契约（quote-engine 负责）

纯 ESM，**不得 import DOM/three/cad**；`quote.js` import `./price-book.js`。数字可复现（无随机、无 Date 之外的隐式状态，
`opts.date` 可覆盖；`generatedAt` 用 `opts.date` 或本地日期字符串）。

```js
export function buildQuote(plan, opts = {}) // → Quote
export function quoteToCSV(quote)           // → string（UTF-8，首字符 BOM '\ufeff'，Excel 中文不乱码）
export function amountInWords(yuan)          // → '人民币壹拾贰万叁仟肆佰伍拾陆元整' 形式
export { PRICE_BOOK } from './price-book.js' // 便于测试/调试
```

`opts = { book?: PRICE_BOOK, meta?: { nameOf(id), categoryOf(id) }, date?: 'YYYY-MM-DD' }`

```js
Quote = {
  kind:'clinic-quote', version:1, generatedAt,
  config:{ platform, platformLabel, typeName, styleName, modules:[], area, chairs, roomCount },
  metrics:{ area, usableArea, perimeter, partitionLen, ceilingArea,
            points:{water,power,gas,drain,net}, pointCount,
            chairs, clinics, roomCount, itemCount, sharedItemCount, diffItemCount,
            itemsByAsset:{id:n}, itemsByCategory:{cat:n},
            hardArea, mepArea, itemArea, designArea },   // 各分组计价基数，便于核对
  lines:[{ no, group, name, spec, unit, qty, price, amount, hours }],
  groups:[{ id, name, amount, hours, share }],          // share = 金额占比 0..1，5 个分组
  totals:{ subtotal, tax, total, low, high, perArea, perChair, amountInWords, rangePct },
  labor:{ totalHours, byTrade:[{id,name,hours,share}], calendarDays,
          phases:[{id,name,days,hours,crew}], peakCrew },
  byRoom:[{ roomId, name, amount, hours, itemCount }],
  priceBookVersion,
}
```

- 分组固定 5 个：`硬装工程` / `机电与暖通` / `家具与设备` / `设计与管理` / `税金`（税金组可以是单行，
  `totals.subtotal` = 前 4 组合计，`totals.total` = subtotal + tax，`totals.low/high = total×(1∓rangePct)`）。
- 工时单位 **人天**，`labor.totalHours` = Σ lines.hours；`phases` 至少 4 段：
  设计 / 硬装施工 / 家具设备安装 / 调试交付，`calendarDays = Σ phases.days`。
- 单价口径：人民币元，含税（增值税见 `taxRate`）；quantity 保留 2 位、金额取整到元。
- **可复现**：同一 plan 两次调用 `JSON.stringify` 完全一致（`date` 固定时）。
- 合理性（QA 会校验）：`L > M > S`（同类型同风格）；模块越多越贵；`perChair`、`perArea` 在
  `[3000, 15000] 元/㎡`、`[8, 60] 万元/椅` 区间内（S/M/L × 5 类型 × 5 风格全组合）。
  **金额区间与单调性只对 UI 可达组合校验**（门店类型强制模块 + 0..(平台槽位 − 强制模块数) 可选模块；
  超槽位组合仍校验自洽/可复现）。量级基准（2026 华东中端口径）：S 社区店 55–70 万；
  M 种植旗舰店+影像 170–200 万（单方 1.1–1.3 万/㎡）；L 美学体验店 190–230 万（6 椅高端配置）。

### price-book.js 数据要求（可被商务直接改数）
```js
export const PRICE_BOOK = {
  version:'2026.11', currency:'CNY', taxRate:0.06, rangePct:0.08,
  styleFactor:{ calm:1.0, kids:1.08, mono:1.12, wood:1.15, cream:1.10 },  // 只作用硬装组
  areaRules:[{ id,name,group:'硬装工程',unit:'㎡',price,hours, qty:'area'|'usableArea'|'ceilingArea'|'partitionArea'|'extWallArea'|'intWallArea'|'perimeter', factor?,offset? }],
  pointRules:[{ kind:'water'|'power'|'gas'|'drain'|'net', name, group:'机电与暖通', unit:'点', price, hours }],
  moduleRules:[{ module:'imaging', name:'铅防护工程', group:'机电与暖通', unit:'项', price, hours }],
  itemPrices:{ 'dental-chair-adult':65000, ... },   // 资产 id 覆盖价
  categoryPrices:{ '前台接待':3500, ... },          // 分类兜底价（口径见 dental/inventory.json 的 category）
  itemHours:{ 'cbct-machine':3, ... },              // 单件安装工时（人天）覆盖
  categoryHours:{ '前台接待':0.4, ... },            // 分类兜底安装工时
  equipmentGroup:'家具与设备',                        // 大型医疗设备可归 设备工程（自行决定，需在 groups 中显示）
  design:{ feePct:0.045, hoursBase:6, hoursPerRoom:0.45, hoursPerChair:0.8 },
  manage:{ feePct:0.03, hoursPerRoom:0.15 },
  labor:{ crews:{ design:3, build:6, mep:4, install:3, commission:2 } },
}
```
数据必须覆盖：`dental/inventory.json` 全部 13 个分类（分类名原样）+ 至少 25 件大设备/重点件覆盖价
（牙椅 5 种、CBCT、全景机、高压灭菌器、清洗消毒机、超声洁牙机、种植机、口扫、3D 打印、技工台、前台弧形台等）。

## 5. 浏览器层契约（ui-sheet 负责）

修改：`index.html`、`css/styles.css`、`js/ui.js`、`js/main.js`；新增 `js/sheet.js`。

- 顶栏在 `#viewSeg` 之后加一个 toggle 按钮：`<button id="toggleSheet" class="toggle"><i class="dots-sheet"></i>出图</button>`
  （样式同其它 toggle；`.dots-sheet` 用 CSS 渐变）。
- 新增浮层（默认隐藏）：`<div id="sheetPanel" class="sheet-panel hidden"> … </div>`，结构：
  - `.sheet-head`：`<h2>出图与报价</h2>` + `.sheet-config`（`平台 M · 社区家庭店 · 洁净蓝白 · 150㎡ · 4 椅`）
    + `.sheet-actions`：`DXF` / `SVG` / `报价 CSV` / `打印` / `关闭`（`data-dl` 属性）。
  - `.sheet-body`：左 `.sheet-preview`（白纸+阴影，内联 SVG，可滚动、随窗口缩放）；右 `.sheet-side`（造价/工时）。
  - `.sheet-side` 内容（只用标签+数字，不写解释文字）：
    估算造价（大号 ¥）、区间、单方造价（元/㎡）、每椅造价（元/椅）；5 个分组行（金额 + 占比条）；
    总工日、工期（天）；4 个阶段行（阶段 + 天数）；工种行（可合并到阶段下，自定，保持简洁）。
- 交互：`出图` 按钮开/关；`关闭` 与 ESC 关闭；打开时按当前 plan 现算 drawing/quote（`buildDrawing`/`buildQuote`）；
  配置变化后若浮层开着则实时刷新；视图/3D 不受影响，浮层 `z-index` 高于 3D 标签层，`#sheetPanel` 打开时
  body 滚动不穿透（页面本身不滚动）。
- 下载（全部用 Blob + `<a download>`，文件名含配置，中文可用）：
  - DXF：`平面图_${typeName}_${platform}_${styleName}.dxf`，MIME `application/dxf`
  - SVG：同名 `.svg`，MIME `image/svg+xml`
  - CSV：`估价单_${typeName}_${platform}.csv`，MIME `text/csv;charset=utf-8`
  - 打印：`window.open('')` 写入「SVG 图页 + 打印 CSS」的 HTML，然后 `print()`（作为 PDF 出口）。
- `js/ui.js`：`renderMetrics(state, plan)` 增加两张卡：`估算造价`（万元，1 位小数，`.toFixed(1)` + `<small>万</small>`）、
  `估算工时`（人天整数 + `<small>人天</small>`）；数值来自 `plan.quote.totals.total` / `plan.quote.labor.totalHours`。
- `js/main.js`：`apply()` 里 plan 建好后
  `plan.quote = buildQuote(plan, { meta: { nameOf: (id) => lib.info(id).zh, categoryOf: (id) => lib.info(id).category } })`；
  `plan.drawing` 惰性（打开浮层/下载时）由 `sheet.js` 调 `buildDrawing(plan, { boq: plan.quote, meta })`。
  绑定 `sheet.js` 的 `createSheetPanel({ getPlan: () => plan, getState: () => state, meta })`。
- `window.demo` 追加（QA 用）：`drawing()` 返回 drawing、`quote()` 返回 quote、`csv()` 返回 CSV 字符串、
  `dxf()` 返回 DXF 字符串、`svg()` 返回 SVG 字符串、`openSheet()`/`closeSheet()`。
- 视觉：沿用现有设计语言（白卡、`--line` 边框、`--teal` 强调、字号 11–13px、数字 tabular-nums），
  **不写解释性文字/副标题/操作提示**；A4 打印样式隐藏侧栏。

## 6. 验收（QA 负责，测试脚本放 `dental/tools/`）

1. **node 纯模块测试**（`node dental/tools/verify-drawing-quote.mjs`）：
   - 全组合（3 平台 × 可用类型 × 5 风格 × 0–槽位模块组合）建 plan → quote → drawing → DXF/SVG：
     无异常、无 NaN、数值有限；DXF/SVG 长度合理（DXF > 20KB、SVG > 8KB）。
   - 金额自洽：Σ lines.amount == groups 合计 == subtotal；total == subtotal + tax；low < total < high；
     Σ lines.hours == labor.totalHours；Σ groups.share ≈ 1；Σ phase.days == calendarDays。
   - 可复现：同输入两次 buildQuote 的 JSON 完全一致。
   - 单调性：L 总价 > M > S（同类型同风格）；加模块后总价 ≥ 原总价。
   - 区间合理性见 §4。
   - DXF 结构自检（node 侧）：`0\nSECTION` 配对、以 `0\nEOF` 结尾、图层表含 9 个图层、实体坐标非 NaN。
2. **ezdxf 独立校验**（`python dental/tools/validate_dxf.py <file>`，ezdxf 1.4.5 已装）：
   `readfile` 无错；统计 LAYER/TEXT/LWPOLYLINE/LINE/CIRCLE/SOLID 数；TEXT 中文正确（抽样比对房间名）；
   渲染 DXF→SVG（`ezdxf.addons.drawing`）供人眼检查；输出 JSON 机器可读结果。
3. **浏览器端**（`node dental/tools/shot-sheet.mjs`，用 `dental/tools/cdp_lite.mjs` + 本地 `dental/demo`）：
   打开浮层 → 截图（1280×900）→ 校验 `window.demo.quote()` / `drawing()` / `dxf()` 与 node 端一致；
   三个下载按钮触发且文件名正确（可用 `Page.setDownloadBehavior` 截获）；打印窗口不报错。
4. Lead 终验：同配置的 DXF 在 ezdxf 渲染图 + 浏览器截图人工确认；提交。

## 7. 里程碑

| 里程碑 | 内容 | 负责 |
|---|---|---|
| M1 | 契约冻结 + footprint.js + 全员读契约 | Lead |
| M2 | cad.js / quote.js+price-book.js 纯模块先行自测通过 | cad-engine / quote-engine |
| M3 | sheet.js + UI 接线，浏览器能打开浮层并下载 | ui-sheet |
| M4 | QA 全组合验证 + DXF ezdxf 渲染 + 截图 | qa-verify |
| M5 | 同步 `dental/demo`、README/文档、提交 | Lead |

## 8. 汇报格式

完成任务时用一句话汇报：改动文件 / 自测命令与结果 / 已知限制。遇到契约歧义**先找 Lead**，不要自行改契约。
