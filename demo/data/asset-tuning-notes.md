# 资产标定 notes

- 标定方法：`dental/tools/turntable.mjs` 渲染 4 水平视角（0/90/180/270°）逐件判读；`fit`=最长水平边真实尺寸(m)，`h`=fit×(bbox.y/max(bbox.x,bbox.z))，`rotY`=让正面朝 +Z 的旋转角（度）。演示页 scale=fit/max(bbox.x,bbox.z)、底部对齐 y=0（90° 旋转不改变 max(x,z)，故 rotY 不影响归一化）。
- 覆盖 161 件：CONCEPT §5 全清单（含牙椅/桌/沙发/柜等 110 件）+ lead 补充的 51 件演示实际用件；9 件补充件在 `dental/demo/extra/models/`（已用新文生 3D 版本渲染标定）。
- rotX 特殊姿态（已写进 JSON 的 `rotX` 字段或 note）：`ceiling-cassette-ac`、`led-panel-light` 面板朝 +Z 竖立 → `rotX:90` 才能水平（天花件）；`waiting-area-rug` 斜靠竖立 → 建议不用（或 rotX≈-45 特判）；`tv-wall-55` 双面板坏件 → 建议不用；`clinic-entrance-door` 按门洞高 2.1m 反推 fit=2.25（宽度随之≈2.25m，可另调 X）。
- 坏件（建议换件/不用）：`tv-wall-55`、`sharps-container`、`wayfinding-standee`、`emergency-exit-sign`、`sanitizer-station`、`accessibility-grab-bar`、`imaging-workstation`、`brushing-teaching-board`、`imaging-positioning-chair`、`kids-play-table`、`medicine-cabinet`、`reward-toy-cabinet`、`office-file-cabinet`（抽屉爆开）。
- 比例异常（可用但需注意）：`reception-desk-curved` 偏扁(h≈0.40)、`bookcase` 低矮(h≈0.57)、`kids-play-carpet` 含竖板(h≈1.38)、`mobile-cabinet-two-drawer`/`refrigerator`/`staff-break-table`/`umbrella-stand` 偏矮、`bathroom-vanity`(含镜)/`office-desk`/`executive-desk`(含屏风)/`packing-table` 偏高，明细见各件 note。
- 判读约定：`rotY` 为角度值 0/90/180/270；同名不同风格（如 dental-chair-*、waiting-sofa-*）取同值；拿不准的在小件 note 标 `approx`；对称件（灯、垃圾桶、绿植）一律 0。
- 复现/抽查：`node dental/tools/turntable.mjs --batch`（批量出 4 联图到 `dental/demo/shots/fit/`）；`--ids a,b` 指定件；`--angles 0 --rot-map dental/demo/data/asset-tuning.json` 可验证 rotY 是否把正面转到 +Z。
