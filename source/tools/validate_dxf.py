#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""出图 · 算量 · 估价 —— DXF 独立校验 + 渲染（契约 §6.2）

用法：
  python dental/tools/validate_dxf.py <file.dxf> [<file2.dxf> ...] [选项]
    --render-dir <dir>   渲染 SVG 输出目录（默认 _lead_scratch/qa）
    --no-render          不渲染
    --json-out <file>    结果 JSON 写盘（默认 <render-dir>/validate-dxf.result.json）
    --expect-names "A,B" 期望出现的房间名（默认前台接待区/候诊区/公共走廊/消毒室/卫生间）
    --quiet              不打印人读摘要（stderr）

校验项：ezdxf.readfile 无异常 + audit 无错；$ACADVER/$INSUNITS/$MEASUREMENT/$EXTMIN/$EXTMAX；
LAYER 清单与契约核心图层；LINE/LWPOLYLINE/POLYLINE/TEXT/MTEXT/CIRCLE/SOLID 统计；实体引用图层
已定义；坐标无 NaN/Inf；中文 TEXT 抽样（乱码检测）；期望房间名出现；bbox 有限且与 $EXTMIN/MAX 一致；
用 ezdxf.addons.drawing 的 SVG 后端把 DXF 渲染成 SVG（纯 Python，无 matplotlib）。

stdout 只输出一个机器可读 JSON；人读摘要走 stderr。退出码：0 全 PASS；1 有 FAIL。
"""

import argparse
import json
import math
import re
import sys
import traceback
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RENDER_DIR = ROOT / '_lead_scratch' / 'qa'

DEFAULT_EXPECT_NAMES = ['前台接待区', '候诊区', '公共走廊', '消毒室', '卫生间']
CORE_LAYERS = ['A-外墙', 'A-内墙', 'A-门', 'A-家具', 'A-文字', 'A-标注', 'A-图例', 'TK-图框']
CONTRACT_LAYERS = CORE_LAYERS + ['M-给水', 'M-排水', 'E-强电', 'E-弱电', 'G-气']
# 契约 §3.1 列的 ACI 颜色（值冲突时只当 warning）
LAYER_COLORS = {
    'A-外墙': 7, 'A-内墙': 7, 'A-门': 3, 'A-家具': 8, 'A-文字': 7, 'A-标注': 4,
    'M-给水': 5, 'M-排水': 6, 'E-强电': 2, 'E-弱电': 1, 'G-气': 3, 'A-图例': 7, 'TK-图框': 7,
}
COUNT_TYPES = ['LINE', 'LWPOLYLINE', 'POLYLINE', 'TEXT', 'MTEXT', 'CIRCLE', 'SOLID', 'ARC', 'HATCH', 'INSERT']
CJK_RE = re.compile(r'[\u4e00-\u9fff]')
MOJIBAKE_RE = re.compile(r'\ufffd|锟斤拷|Ã.|â€|ã€|銆|锛|鐨|鏂|瀹')


# ── 工具函数 ────────────────────────────────────────────────────────────────
def rel(p):
    try:
        return str(Path(p).resolve().relative_to(ROOT))
    except Exception:
        return str(p)


class Report:
    def __init__(self, file):
        self.res = {
            'file': rel(file),
            'ok': False,
            'checks': [],      # [{name, ok, detail}]
            'errors': [],
            'warnings': [],
            'stats': {},
        }

    def check(self, name, ok, detail=''):
        self.res['checks'].append({'name': name, 'ok': bool(ok), 'detail': str(detail)[:300]})
        if not ok:
            self.res['errors'].append(f'[{name}] {detail}'[:400])
        return bool(ok)

    def warn(self, name, detail):
        self.res['checks'].append({'name': name, 'ok': True, 'warning': True, 'detail': str(detail)[:300]})
        self.res['warnings'].append(f'[{name}] {detail}'[:300])


def is_finite_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v))


def iter_entity_numbers(e):
    """遍历实体 dxf 属性中的数值（含 Vec2/Vec3）。"""
    try:
        attribs = e.dxf.all_existing_dxf_attribs()
    except Exception:
        return
    for name, v in attribs.items():
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            yield f'{name}={v}', float(v)
        elif isinstance(v, (tuple, list)):
            for i, x in enumerate(v):
                if isinstance(x, (int, float)) and not isinstance(x, bool):
                    yield f'{name}[{i}]={x}', float(x)
        elif hasattr(v, 'x') and hasattr(v, 'y'):
            for axis in ('x', 'y', 'z'):
                if hasattr(v, axis):
                    x = getattr(v, axis)
                    if isinstance(x, (int, float)) and not isinstance(x, bool):
                        yield f'{name}.{axis}={x}', float(x)


def scan_non_finite(msp):
    bad = []
    for e in msp:
        try:
            for label, num in iter_entity_numbers(e):
                if not math.isfinite(num):
                    bad.append(f'{e.dxftype()}#{e.dxf.handle} {label}')
                    if len(bad) >= 10:
                        return bad
        except Exception:
            continue
    return bad


def text_of(e):
    try:
        if e.dxftype() == 'MTEXT':
            return e.plain_text()
        return e.dxf.text
    except Exception:
        return ''


def entity_texts(msp):
    out = []
    for e in msp:
        if e.dxftype() in ('TEXT', 'MTEXT'):
            t = text_of(e) or ''
            if t:
                out.append((e, t))
    return out


def text_heights(msp):
    hs = []
    for e in msp:
        if e.dxftype() == 'TEXT':
            try:
                hs.append(float(e.dxf.height))
            except Exception:
                hs.append(0.0)
    return hs


# ── 渲染 ────────────────────────────────────────────────────────────────────
def first_frame_box(box):
    """从整卷 extents 反推 cad.js 的 A2 首页区域（图纸 A2: 594×420，页间距 SHEET_GAP=2000）。

    返回 (BoundingBox2d, 页数) 或 None。仅对「A2 横向并排」布局有效，失败时不影响主渲染。
    """
    from ezdxf.addons.drawing.layout import BoundingBox2d

    frame_h = box.size.y
    if frame_h <= 1 or box.size.x <= frame_h:
        return None
    frame_w = frame_h * 594.0 / 420.0
    pitch = frame_w + 2000.0
    n = round((box.size.x + 2000.0) / pitch)
    if n < 1:
        return None
    if abs(n * pitch - 2000.0 - box.size.x) > max(1.0, pitch * 0.02):
        return None
    crop = BoundingBox2d([
        (box.extmin.x, box.extmin.y),
        (box.extmin.x + frame_w, box.extmin.y + frame_h),
    ])
    return crop, n


def render_svg(doc, out_path, max_width=3000.0, render_box=None):
    """DXF 模型空间 → SVG（ezdxf 纯 Python SVG 后端，无需 matplotlib）。

    与 Lead 的 _lead_scratch/dxf2svg.py 同一套路：手工构造 layout.Page，
    Frontend.draw_layout(msp, finalize=False) 后按 bbox 缩放整卷到 max_width。
    render_box 给定时只渲染该区域（用于首页特写；注意 get_string 会消费录制，需重新 draw）。
    """
    from ezdxf import bbox
    from ezdxf.addons.drawing import RenderContext, Frontend
    from ezdxf.addons.drawing.config import Configuration, ColorPolicy, BackgroundPolicy
    from ezdxf.addons.drawing.svg import SVGBackend
    from ezdxf.addons.drawing.layout import Page, Settings, Units

    msp = doc.modelspace()
    full_box = bbox.extents(msp)
    if not full_box.has_data:
        raise RuntimeError('模型空间为空，无法渲染')
    target = render_box if render_box is not None else full_box
    cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=ColorPolicy.COLOR)
    backend = SVGBackend()
    ctx = RenderContext(doc)
    Frontend(ctx, backend, config=cfg).draw_layout(msp, finalize=False)
    w = max(1.0, target.size.x)
    h = max(1.0, target.size.y)
    k = min(1.0, max_width / w)
    page = Page(w * k, h * k, units=Units.mm)
    svg = backend.get_string(page, settings=Settings(fit_page=True), render_box=render_box)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(svg, encoding='utf-8')
    render_stats = {
        'bytes': len(svg.encode('utf-8')),
        'paths': svg.count('<path'),
        'texts': svg.count('<text'),
        'elements': svg.count('<'),
        'viewBox': re.search(r'viewBox="([^"]+)"', svg).group(1) if re.search(r'viewBox="([^"]+)"', svg) else None,
    }
    return full_box, render_stats


# ── 单文件校验 ──────────────────────────────────────────────────────────────
def validate_one(file_path, args, render_dir):
    r = Report(file_path)
    p = Path(file_path)
    if not p.exists():
        r.check('file-exists', False, f'文件不存在: {p}')
        return r.res
    r.res['stats']['bytes'] = p.stat().st_size
    r.check('file-exists', True, f'{p.stat().st_size} bytes')

    # 1) readfile
    import ezdxf
    try:
        doc = ezdxf.readfile(str(p))
    except Exception as e:
        r.check('readfile', False, f'{type(e).__name__}: {e}')
        r.res['stats']['traceback'] = traceback.format_exc()[-1500:]
        return r.res
    r.check('readfile', True, 'ezdxf.readfile 无异常')

    # 2) audit
    try:
        auditor = doc.audit()
        audit_errors = len(auditor.errors)
        audit_fixes = len(auditor.fixes)
        r.res['stats']['audit'] = {'errors': audit_errors, 'fixes': audit_fixes}
        r.check('audit', audit_errors == 0, f'audit errors={audit_errors}, fixes={audit_fixes}')
    except Exception as e:
        r.warn('audit', f'audit 失败: {type(e).__name__}: {e}')

    # 3) header
    dxfversion = doc.dxfversion
    header = doc.header
    insunits = header.get('$INSUNITS', None)
    measurement = header.get('$MEASUREMENT', None)
    extmin = header.get('$EXTMIN', None)
    extmax = header.get('$EXTMAX', None)
    r.res['stats'].update({
        'dxfversion': dxfversion,
        'INSUNITS': insunits,
        'MEASUREMENT': measurement,
        'EXTMIN': list(extmin) if extmin is not None else None,
        'EXTMAX': list(extmax) if extmax is not None else None,
    })
    r.check('dxfversion', dxfversion == 'AC1021', f'$ACADVER={dxfversion}（契约要求 AC1021 / R2007）')
    r.check('INSUNITS', insunits == 4, f'$INSUNITS={insunits}（契约要求 4=mm）')
    r.check('MEASUREMENT', measurement == 1, f'$MEASUREMENT={measurement}（契约要求 1=metric）')
    r.check('EXTMIN', extmin is not None, '$EXTMIN 缺失')
    r.check('EXTMAX', extmax is not None, '$EXTMAX 缺失')

    # 4) layers
    layer_names = [layer.dxf.name for layer in doc.layers]
    layer_colors = {layer.dxf.name: layer.dxf.color for layer in doc.layers}
    r.res['stats']['layers'] = layer_names
    r.res['stats']['layerCount'] = len(layer_names)
    r.res['stats']['layerColors'] = layer_colors
    r.check('layer-count', len(layer_names) >= 9, f'图层数={len(layer_names)}（契约 §6 要求 9 个以上）')
    r.check('layer-empty', all(n and n.strip() for n in layer_names), '存在空图层名')
    dup = [n for n, c in Counter(layer_names).items() if c > 1]
    r.check('layer-dup', not dup, f'图层名重复: {dup}')
    missing_core = [n for n in CORE_LAYERS if n not in layer_names]
    r.check('layer-core', not missing_core, f'缺契约核心图层 {missing_core}')
    missing_named = [n for n in CONTRACT_LAYERS if n not in layer_names]
    if missing_named:
        r.warn('layer-contract', f'缺契约命名图层 {missing_named}（现有 {len(layer_names)} 层）')
    color_bad = []
    for name, expect in LAYER_COLORS.items():
        if name in layer_colors and layer_colors[name] != expect:
            color_bad.append(f'{name}:{layer_colors[name]}≠{expect}')
    if color_bad:
        r.warn('layer-color', f'ACI 颜色与契约不一致: {color_bad}')
    else:
        r.check('layer-color', True, 'ACI 颜色与契约一致')

    # 5) 实体统计
    msp = doc.modelspace()
    type_counter = Counter()
    layer_counter = Counter()
    for e in msp:
        t = e.dxftype()
        type_counter[t] += 1
        try:
            layer_counter[e.dxf.layer] += 1
        except Exception:
            layer_counter['<无图层>'] += 1
    total = sum(type_counter.values())
    stats = {t: type_counter.get(t, 0) for t in COUNT_TYPES}
    stats['total'] = total
    stats['byType'] = dict(type_counter)
    stats['byLayer'] = dict(layer_counter)
    r.res['stats']['entities'] = stats
    r.check('entity-count', total >= 100, f'实体总数={total}（<100 太少）')
    for t in ['LINE', 'LWPOLYLINE', 'TEXT', 'CIRCLE']:
        r.check(f'entity-{t}', type_counter.get(t, 0) > 0, f'{t} 数量={type_counter.get(t, 0)}，应为正')
    if type_counter.get('SOLID', 0) == 0:
        r.warn('entity-SOLID', 'SOLID 数量=0（契约要求实心箭头/表格底纹，至少应有箭头）')
    if type_counter.get('POLYLINE', 0) == 0 and type_counter.get('LWPOLYLINE', 0) == 0:
        r.warn('entity-POLYLINE', 'POLYLINE/LWPOLYLINE 均为 0（门开启弧应使用 poly 折线近似）')

    # 实体引用图层必须已定义
    undefined_layers = sorted({n for n in layer_counter if n not in layer_names and n != '0'})
    r.check('layer-ref', not undefined_layers, f'实体引用未定义图层 {undefined_layers[:8]}')

    # 6) 文本 / 中文
    texts = entity_texts(msp)
    all_text = '\n'.join(t for _, t in texts)
    cjk_texts = [t for _, t in texts if CJK_RE.search(t)]
    r.res['stats']['textCount'] = len(texts)
    r.res['stats']['cjkTextCount'] = len(cjk_texts)
    r.res['stats']['textSamples'] = cjk_texts[:12]
    r.check('text-count', len(texts) >= 20, f'TEXT/MTEXT 数量={len(texts)}（<20 太少）')
    r.check('text-cjk', len(cjk_texts) >= 10, f'含中文的 TEXT 数量={len(cjk_texts)}（<10，UTF-8 中文可能丢失）')
    bad_moji = [t for t in cjk_texts if MOJIBAKE_RE.search(t)]
    r.check('text-mojibake', not bad_moji, f'检测到疑似乱码文本 {bad_moji[:5]}')
    heights = text_heights(msp)
    r.res['stats']['textHeights'] = sorted(set(round(h, 1) for h in heights))[:20]
    r.check('text-height', all(h > 0 for h in heights), f'存在字高<=0 的 TEXT: {[h for h in heights if h <= 0][:5]}')
    found = [n for n in args.expect_names if n in all_text]
    r.res['stats']['expectNames'] = {'expected': args.expect_names, 'found': found}
    r.check('text-roomnames', len(found) >= min(3, len(args.expect_names)),
            f'期望房间名命中 {found}/{args.expect_names}（至少 3 个）')

    # 7) 非有限数值
    bad_nums = scan_non_finite(msp)
    r.check('finite', not bad_nums, f'非有限坐标/数值: {bad_nums}')

    # 8) bbox 与 $EXTMIN/$EXTMAX
    try:
        from ezdxf import bbox as ezbbox
        box = ezbbox.extents(msp)
        bb = {'min': list(box.extmin), 'max': list(box.extmax), 'size': list(box.size)}
        r.res['stats']['bbox'] = bb
        finite_bb = all(is_finite_num(v) for v in list(bb['min']) + list(bb['max']) + list(bb['size']))
        r.check('bbox-finite', finite_bb, f'bbox 含非有限值: {bb}')
        r.check('bbox-size', box.size.x > 1 and box.size.y > 1, f'bbox 尺寸异常: {list(box.size)}')
        if extmin is not None and extmax is not None:
            e_min = list(extmin)[:3]
            e_max = list(extmax)[:3]
            tol = max(10.0, 0.02 * max(box.size.x, box.size.y, 1.0))
            diffs = [abs(a - b) for a, b in zip(list(box.extmin), e_min)] + [abs(a - b) for a, b in zip(list(box.extmax), e_max)]
            r.res['stats']['extDiff'] = diffs
            r.check('extents', max(diffs) <= tol, f'$EXTMIN/$EXTMAX 与实体 bbox 偏差 {max(diffs):.3f}mm > {tol:.1f}mm')
    except Exception as e:
        r.check('bbox', False, f'计算 bbox 失败: {type(e).__name__}: {e}')

    # 9) 渲染 SVG（整卷）+ 首页单页特写（便于人眼检查平面图细节）
    if not args.no_render:
        base = p.stem if p.stem.startswith('dxf') else 'dxf-' + p.stem
        out_svg = render_dir / f'{base}.svg'
        try:
            box, rs = render_svg(doc, out_svg, max_width=args.render_max)
            r.res['stats']['render'] = {'file': rel(out_svg), 'bbox': [list(box.extmin), list(box.extmax)], **rs}
            r.check('render', rs['bytes'] > 2000 and rs['paths'] + rs['texts'] > 50,
                    f'渲染 SVG 过小或内容为空: {rs} -> {rel(out_svg)}')
        except Exception as e:
            r.res['stats']['render'] = {'error': f'{type(e).__name__}: {e}'}
            r.check('render', False, f'渲染 SVG 失败: {type(e).__name__}: {e}')
        # 首页特写：从 extents 反推 A2 图框（cad.js 固定 A2：frameH=420*scaleDen，页间距 2000）
        try:
            from ezdxf import bbox as ezbbox
            box = ezbbox.extents(msp)
            first = first_frame_box(box)
            if first is not None:
                crop, n_pages = first
                out_p1 = render_dir / f'{base}-p1.svg'
                box1, rs1 = render_svg(doc, out_p1, max_width=args.render_max, render_box=crop)
                r.res['stats']['renderFirstPage'] = {
                    'file': rel(out_p1), 'pages': n_pages, 'bbox': [list(crop.extmin), list(crop.extmax)],
                    **rs1,
                }
                r.check('render-first-page', rs1['bytes'] > 2000 and rs1['paths'] + rs1['texts'] > 50,
                        f'首页渲染过小: {rs1} -> {rel(out_p1)}')
            else:
                r.warn('render-first-page', '无法从 extents 反推 A2 图框，跳过首页特写（不影响主渲染）')
        except Exception as e:
            r.warn('render-first-page', f'首页特写渲染失败: {type(e).__name__}: {e}')

    r.res['ok'] = not r.res['errors']
    return r.res


# ── main ────────────────────────────────────────────────────────────────────
def parse_args(argv):
    ap = argparse.ArgumentParser(add_help=True, description='DXF 独立校验 + SVG 渲染（ezdxf）')
    ap.add_argument('files', nargs='+', help='DXF 文件路径（可多个）')
    ap.add_argument('--render-dir', default=str(DEFAULT_RENDER_DIR), help='渲染 SVG 输出目录')
    ap.add_argument('--json-out', default=None, help='结果 JSON 写盘路径')
    ap.add_argument('--no-render', action='store_true', help='不渲染 SVG')
    ap.add_argument('--render-max', type=float, default=3000.0, help='渲染 SVG 最大宽度（默认 3000 图面单位）')
    ap.add_argument('--expect-names', default=','.join(DEFAULT_EXPECT_NAMES), help='期望出现的房间名，逗号分隔')
    ap.add_argument('--quiet', action='store_true', help='不打印人读摘要')
    args = ap.parse_args(argv)
    args.expect_names = [s for s in args.expect_names.split(',') if s]
    return args


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    render_dir = Path(args.render_dir).resolve()
    render_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for f in args.files:
        try:
            results.append(validate_one(f, args, render_dir))
        except Exception as e:
            results.append({'file': rel(f), 'ok': False, 'errors': [f'校验脚本异常: {type(e).__name__}: {e}'],
                            'warnings': [], 'checks': [], 'stats': {'traceback': traceback.format_exc()[-1500:]}})
    ok = all(r['ok'] for r in results)
    doc = {
        'ok': ok,
        'tool': 'validate_dxf',
        'ezdxf': _ezdxf_version(),
        'renderDir': rel(render_dir),
        'totals': {
            'files': len(results),
            'passed': sum(1 for r in results if r['ok']),
            'failed': sum(1 for r in results if not r['ok']),
            'errors': sum(len(r['errors']) for r in results),
            'warnings': sum(len(r['warnings']) for r in results),
        },
        'results': results,
    }
    json_out = Path(args.json_out).resolve() if args.json_out else render_dir / 'validate-dxf.result.json'
    json_out.parent.mkdir(parents=True, exist_ok=True)
    json_out.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding='utf-8')
    doc['jsonOut'] = rel(json_out)

    if not args.quiet:
        for r in results:
            st = r.get('stats', {})
            ents = st.get('entities', {})
            print(f"[validate] {r['file']}: {'PASS' if r['ok'] else 'FAIL'}  "
                  f"{st.get('bytes', '?')}B  {st.get('dxfversion', '?')}  "
                  f"layers={st.get('layerCount', '?')}  entities={ents.get('total', '?')}  "
                  f"TEXT={ents.get('TEXT', '?')}  错误={len(r['errors'])} 警告={len(r['warnings'])}", file=sys.stderr)
            for e in r['errors'][:8]:
                print('   ✗', e, file=sys.stderr)
            for w in r['warnings'][:6]:
                print('   !', w, file=sys.stderr)
            if st.get('render') and st['render'].get('file'):
                print(f"   → 渲染: {st['render']['file']} ({st['render']['bytes']}B)", file=sys.stderr)
        print(f"[validate] 结果 JSON: {rel(json_out)}", file=sys.stderr)

    print(json.dumps(doc, ensure_ascii=False, indent=2))
    return 0 if ok else 1


def _ezdxf_version():
    try:
        import ezdxf
        return ezdxf.__version__
    except Exception:
        return None


if __name__ == '__main__':
    sys.exit(main())
