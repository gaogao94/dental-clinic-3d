# 口腔诊所平台 · 3D 演示页

双击 `打开演示.cmd`（或 `node serve.mjs`），自动打开 `http://127.0.0.1:<port>/demo/index.html`。
交互：平台 S/M/L · 门店类型 5 种 · 风格 5 种 · 选装模块（超槽位禁用）· 视角飞入（总览/前台/候诊/诊疗/消毒）· 点选物件信息卡 · 硬点 · 平台件/差异件描边 · 天花开关 · 底部平台矩阵（点击切换）· 指标与配置清单。
数据：`js/config.js`（平台/类型/风格/模块）、`js/plan.js`（房间与家具布局）、`js/asset-tuning.js`（尺寸/朝向默认表，`demo/data/asset-tuning.json` 存在时覆盖）。
资产：默认走 `demo/lod-models/`（demo 用到的 152 件轻量 LOD，`?hi=1` 用原始模型）；缺 LOD 自动回退 `../models/<id>/model.glb` 或 `demo/extra/models/<id>/model.glb`（9 件补充件）。
天花：`天花` 开关显示程序化 LED 平板灯/空调风口；天花 GLB 件（体积大、姿态需 rotX）未放入 3D 场景。
性能：单页无外链，three.js 全部本地；静态几何合并、阴影 1024、按需渲染。本机无 GPU（SwiftShader 软渲染），真实 GPU 下目标 45+ fps。
自测截图：`shots/`（1600×1000）。

## 出图与报价（顶栏「出图」）

当前配置 → 三张图页 + 估价/工时，随平台/门店类型/风格/模块实时刷新；`DXF` / `SVG` / `报价 CSV` 下载，`打印` 出 A2 横向 PDF。

| 文件 | 职责 |
|---|---|
| `js/cad.js` | plan → Drawing（A2 图框、自适应 1:50/1:100、标题栏、墙/门/家具/硬点/标注、表格分页）→ DXF（R2007/AC1021，mm，中文图层）与 SVG；1:50 与 1:100 的字高/符号按纸面尺寸归一 |
| `js/quote.js` | 工程量 → 5 组造价（硬装/机电与暖通/家具与设备/设计与管理/税金）+ 工时/工期 + CSV + 金额大写 |
| `js/price-book.js` | 单价与工效数据：面积规则、五类点位、模块附加、资产覆盖价/分类兜底价、风格系数、税率、区间、班组人数（商务直接改数，不要改公式） |
| `js/footprint.js` | 119 件资产平面尺寸（归一化后 world bbox，已按 rotY 转正；`node dental/tools/dump-footprints.mjs` 重新生成） |
| `js/sheet.js` | 出图浮层：图页预览、造价/工时侧栏、下载与打印 |

口径：方案估算（含税、±8% 区间；工期为净施工工期，不含设备采购/报建/审批）；出图是**方案阶段平面布置图 + 机电点位图**，可作 CAD 二次设计底图，不是结构/节点施工图。
验收：`node dental/tools/verify-drawing-quote.mjs`（全组合金额自洽/单调/可复现/DXF-SVG 结构）、`python dental/tools/validate_dxf.py <file>`（ezdxf 独立校验 + 渲染）、`node dental/tools/shot-sheet.mjs`（浏览器 E2E：截图、下载、console）。接口契约见 `dental/plan/drawing-quote-contract.md`。
