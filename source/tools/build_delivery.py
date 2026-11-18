#!/usr/bin/env python
"""Build the Lux3D delivery bundle for the dental clinic object library.

Reads  dental/logs/run_manifest.json  (written by the Lead's workflow runner),
writes one lux3d.workflow-state/v2 snapshot per delivered object, assembles
dental/delivery/delivery-spec.json (lux3d.delivery-spec/v2) and calls the
bundled aholo-lux3d runtime:

    python <skill>/core/runtime/delivery_bundle.py prepare \
        --spec dental/delivery/delivery-spec.json \
        --output-dir dental/delivery/lux3d-bundle --locale zh-CN

Re-runnable after the real data is ready:

    "D:\\coding\\qunhe_3d\\.aholo-runtime\\environments\\<env>\\Scripts\\python.exe" \
        dental\\tools\\build_delivery.py --force

The script never touches dental/logs, dental/models/<id>/ or dental/inventory.json.
"""

from __future__ import annotations

import argparse
import datetime
import json
import pathlib
import re
import shutil
import subprocess
import sys
import traceback

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
DENTAL = REPO_ROOT / "dental"
DEFAULT_SKILL_RUNTIME = pathlib.Path(
    r"C:\Users\admin\.dsh\skills\aholo-lux3d\core\runtime"
)
STATE_SCHEMA = "lux3d.workflow-state/v2"
SPEC_SCHEMA = "lux3d.delivery-spec/v2"
MANIFEST_SCHEMA = "dental-clinic-runs/v1"
SPEC_TITLE = "牙科诊所 3D 物件库"
REGIONS = {"cn", "international"}
ID_RE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\Z")
RESERVED_IDS = {"CON", "PRN", "AUX", "NUL"} | {
    f"{prefix}{number}" for prefix in ("COM", "LPT") for number in range(1, 10)
}
SUPPORTED_FORMATS = {"glb"}
CREATE_OPERATIONS = {
    "articulation-animation", "mesh-retopology", "image-to-3d", "text-to-3d",
    "material-transfer", "four-view", "export", "auto-rig", "animation-retarget",
}
OP_ALIASES = {
    "image": "image-to-3d",
    "image_to_3d": "image-to-3d",
    "image2-3d": "image-to-3d",
    "text": "text-to-3d",
    "text_to_3d": "text-to-3d",
}
VERSIONLESS_OPS = {
    "four-view", "mesh-retopology", "export",
    "articulation-animation", "auto-rig", "animation-retarget",
}
STATUS_PROVIDER = {"succeeded": {3}, "provider_succeeded": {3}, "failed": {4, 5}, "cancelled": {6}}


def read_json(path: pathlib.Path):
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        raise SystemExit(f"[delivery] 无法读取 {path}: {exc}")


def read_json_retry(path: pathlib.Path, attempts: int = 6, delay: float = 0.4):
    """The Lead may still be writing run_manifest.json; tolerate a transient partial file."""
    import time

    last = None
    for index in range(attempts):
        try:
            with path.open("r", encoding="utf-8-sig") as handle:
                return json.load(handle)
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as exc:
            last = exc
            if index + 1 < attempts:
                time.sleep(delay)
    raise SystemExit(f"[delivery] 无法读取 {path}: {last}")


def write_json(path: pathlib.Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    tmp.replace(path)


def portable_id(raw, fallback: str) -> str:
    text = re.sub(r"[^A-Za-z0-9_-]+", "-", str(raw or "")).strip("-_")
    if not text:
        text = fallback
    if not re.match(r"[A-Za-z0-9]", text):
        text = "x-" + text
    text = text[:76]
    if text.upper() in RESERVED_IDS:
        text = "x-" + text
    return text


def parse_timestamp(value):
    """Return an ISO-8601 string with timezone, or None when unusable."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("Z", "+00:00")
    # accept +0800 style offsets as well
    text = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", text)
    try:
        parsed = datetime.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.isoformat()


def iso_to_dt(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))


def normalize_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def glb_probe(path: pathlib.Path):
    """Lightweight GLB sanity check; the delivery runtime does the strict check."""
    try:
        data = path.read_bytes()
    except OSError as exc:
        return False, f"读取失败: {exc}"
    if len(data) < 20 or data[:4] != b"glTF":
        return False, "不是 GLB 文件"
    version = int.from_bytes(data[4:8], "little")
    if version != 2:
        return False, f"glTF 版本不支持: {version}"
    try:
        length = int.from_bytes(data[12:16], "little")
        chunk_type = data[16:20]
        if chunk_type != b"JSON":
            return False, "首个数据块不是 JSON"
        chunk = data[20:20 + length]
        doc = json.loads(chunk.decode("utf-8").rstrip("\x00 "))
    except (ValueError, UnicodeDecodeError) as exc:
        return False, f"JSON 块损坏: {exc}"
    if not doc.get("meshes"):
        return False, "模型不含网格"
    if not doc.get("scenes"):
        return False, "模型不含场景"
    return True, "ok"


def load_label_maps(inventory_path: pathlib.Path, models_dir: pathlib.Path):
    labels = {}
    inventory = read_json(inventory_path)
    if isinstance(inventory, dict):
        for item in inventory.get("items") or []:
            if isinstance(item, dict) and item.get("id"):
                labels[str(item["id"])] = item
    metas = {}
    if models_dir.is_dir():
        for child in models_dir.iterdir():
            if not child.is_dir():
                continue
            meta = read_json(child / "meta.json")
            if isinstance(meta, dict):
                key = str(meta.get("id") or child.name)
                metas[key] = meta
                if child.name != key:
                    metas[child.name] = meta
    return labels, metas


def resolve_model_path(item, models_dir: pathlib.Path) -> pathlib.Path | None:
    raw = item.get("modelPath")
    candidates = []
    if isinstance(raw, str) and raw.strip():
        candidate = pathlib.Path(raw)
        candidates.append(candidate if candidate.is_absolute() else REPO_ROOT / candidate)
        if not candidate.is_absolute():
            candidates.append(DENTAL / candidate)
    item_id = str(item.get("id") or "")
    if item_id:
        candidates.append(models_dir / item_id / "model.glb")
    for candidate in candidates:
        try:
            if candidate.is_file() and candidate.stat().st_size > 0:
                return candidate.resolve()
        except OSError:
            continue
    return None


def prepare_state_document(item, model_path: pathlib.Path, warnings: list[str]):
    status = str(item.get("status") or "").strip()
    provider = normalize_int(item.get("providerStatus"))
    if provider is None or provider not in {0, 1, 2, 3, 4, 5, 6}:
        provider = 3 if status == "succeeded" else provider
    allowed = STATUS_PROVIDER.get(status) if provider is not None else None
    if allowed is not None and provider not in allowed:
        return None, f"providerStatus={provider} 与 status={status} 矛盾"
    if status == "succeeded" and provider != 3:
        return None, "成功记录缺少 providerStatus=3"
    operation = str(item.get("op") or "image-to-3d").strip()
    operation = OP_ALIASES.get(operation.lower(), operation)
    if operation not in CREATE_OPERATIONS:
        return None, f"不支持的操作: {item.get('op')!r}"
    region = str(item.get("region") or "cn")
    if region not in REGIONS:
        return None, f"region 非法: {region}"
    version = item.get("version") or "G1-Turbo"
    if operation not in VERSIONLESS_OPS:
        version = str(version).strip()
        if not version:
            return None, "缺少生成版本号 version"
    else:
        version = None
    task_id = item.get("taskId")
    try:
        task_id = str(int(task_id))
    except (TypeError, ValueError):
        return None, f"taskId 非法: {task_id!r}"
    if not re.fullmatch(r"[1-9][0-9]{0,18}", task_id):
        return None, f"taskId 非法: {task_id!r}"

    request = {"operation": operation, "region": region}
    if operation not in VERSIONLESS_OPS:
        request["version"] = version
    expected = [fmt for fmt in (item.get("formats") or ["glb"]) if fmt in SUPPORTED_FORMATS] or ["glb"]
    downloaded = [{"path": str(model_path), "format": fmt} for fmt in expected]

    created = parse_timestamp(item.get("createdAt"))
    updated = parse_timestamp(item.get("updatedAt"))
    completed = parse_timestamp(item.get("localCompletedAt"))
    if completed and not created:
        warnings.append("有 localCompletedAt 但缺 createdAt，已忽略完成时间")
        completed = None
    if created and completed and iso_to_dt(completed) < iso_to_dt(created):
        warnings.append("localCompletedAt 早于 createdAt，已忽略完成时间")
        completed = None
    if not created:
        warnings.append("缺 createdAt（bundle 内本地耗时不可用）")

    state = {
        "schema": STATE_SCHEMA,
        "taskId": task_id,
        "status": status,
        "lastKnownProviderStatus": provider,
        "request": request,
        "expectedFormats": expected,
        "downloadedArtifacts": downloaded,
    }
    if created:
        state["createdAt"] = created
    if updated:
        state["updatedAt"] = updated
    if completed:
        state["localCompletedAt"] = completed
    return state, None


def ensure_output_dir(output_dir: pathlib.Path, force: bool) -> None:
    if not output_dir.exists():
        return
    resolved = output_dir.resolve()
    delivery = (DENTAL / "delivery").resolve()
    safe = resolved.parent == delivery or resolved.name.startswith("lux3d-bundle")
    if not safe:
        raise SystemExit(
            f"[delivery] 拒绝自动删除非预期目录: {resolved}（请手动确认后删除）"
        )
    if not force:
        raise SystemExit(
            f"[delivery] 输出目录已存在: {resolved}\n"
            f"[delivery] 重跑请加 --force（仅删除该目录后重建）"
        )
    shutil.rmtree(resolved)


def find_python(explicit: str | None) -> str:
    if explicit:
        return explicit
    candidate = REPO_ROOT / ".aholo-runtime" / "environments"
    if candidate.is_dir():
        for env in candidate.iterdir():
            exe = env / "Scripts" / "python.exe"
            if exe.is_file():
                return str(exe)
    return sys.executable


def main() -> int:
    parser = argparse.ArgumentParser(description="生成牙科诊所物件的 Lux3D 交付包")
    parser.add_argument("--manifest", default=str(DENTAL / "logs" / "run_manifest.json"))
    parser.add_argument("--models-dir", default=str(DENTAL / "models"))
    parser.add_argument("--inventory", default=str(DENTAL / "inventory.json"))
    parser.add_argument("--spec", default=str(DENTAL / "delivery" / "delivery-spec.json"))
    parser.add_argument("--state-dir", default=str(DENTAL / "delivery" / "state"))
    parser.add_argument("--output-dir", default=str(DENTAL / "delivery" / "lux3d-bundle"))
    parser.add_argument("--report", default=str(DENTAL / "delivery" / "delivery-run-report.json"))
    parser.add_argument("--delivery-bundle", default=str(DEFAULT_SKILL_RUNTIME / "delivery_bundle.py"))
    parser.add_argument("--python", default=None, help="调用 delivery_bundle.py 的 python.exe")
    parser.add_argument("--force", action="store_true", help="输出目录已存在时删除重建")
    parser.add_argument("--dry-run", action="store_true", help="只生成 spec/state 并校验，不复制产物")
    parser.add_argument("--no-prevalidate", action="store_true", help="跳过 build_manifest 预校验")
    args = parser.parse_args()

    manifest_path = pathlib.Path(args.manifest).resolve()
    models_dir = pathlib.Path(args.models_dir).resolve()
    spec_path = pathlib.Path(args.spec).resolve()
    state_dir = pathlib.Path(args.state_dir).resolve()
    output_dir = pathlib.Path(args.output_dir).resolve()
    report_path = pathlib.Path(args.report).resolve()
    bundle_script = pathlib.Path(args.delivery_bundle).resolve()

    report = {
        "schema": "dental-clinic-delivery-run/v1",
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "manifest": str(manifest_path),
        "spec": str(spec_path),
        "outputDir": str(output_dir),
        "status": "error",
        "total": 0,
        "delivered": 0,
        "skipped": [],
        "warnings": [],
        "bundle": None,
        "command": None,
        "error": None,
    }

    def finish(code: int) -> int:
        report["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        write_json(report_path, report)
        print(json.dumps(report, ensure_ascii=False))
        return code

    try:
        manifest = read_json_retry(manifest_path)
        if not isinstance(manifest, dict):
            report["error"] = f"run_manifest.json 尚未生成或不可读: {manifest_path}"
            return finish(2)
        if manifest.get("schema") not in (None, MANIFEST_SCHEMA):
            report["warnings"].append(f"未知 manifest schema: {manifest.get('schema')}")
        raw_items = manifest.get("items")
        normalized_items = []
        if isinstance(raw_items, dict):
            # Lead currently writes items as an id-keyed object; accept it like a list.
            for key, value in raw_items.items():
                if not isinstance(value, dict):
                    report["skipped"].append({"id": str(key), "reason": "条目不是对象"})
                    continue
                entry = dict(value)
                entry.setdefault("id", key)
                normalized_items.append(entry)
        elif isinstance(raw_items, list):
            normalized_items = raw_items
        else:
            report["error"] = "run_manifest.json 中没有 items"
            return finish(2)
        if not normalized_items:
            report["error"] = "run_manifest.json 中 items 为空"
            return finish(2)
        report["total"] = len(normalized_items)

        labels, metas = load_label_maps(pathlib.Path(args.inventory), models_dir)

        items_out = []
        used_item_ids = set()
        used_attempt_ids = set()
        index = 0
        for raw in normalized_items:
            index += 1
            if not isinstance(raw, dict):
                report["skipped"].append({"id": f"#{index}", "reason": "条目不是对象"})
                continue
            raw_id = str(raw.get("id") or f"item-{index:03d}")
            status = str(raw.get("status") or "").strip()
            provider = normalize_int(raw.get("providerStatus"))
            if status != "succeeded" or provider != 3:
                report["skipped"].append({
                    "id": raw_id,
                    "reason": f"未成功: status={status or '缺失'} providerStatus={provider}",
                })
                continue
            model_path = resolve_model_path(raw, models_dir)
            if model_path is None:
                report["skipped"].append({"id": raw_id, "reason": "缺少 model.glb"})
                continue
            ok, detail = glb_probe(model_path)
            if not ok:
                report["skipped"].append({"id": raw_id, "reason": f"GLB 无效: {detail}"})
                continue
            meta = metas.get(raw_id, {})
            zh = raw.get("zh") or meta.get("zh") or (labels.get(raw_id) or {}).get("zh") or raw_id
            item_id = portable_id(raw.get("id"), f"item-{index:03d}")
            base = item_id
            suffix = 1
            while item_id.casefold() in used_item_ids:
                suffix += 1
                item_id = f"{base}-{suffix}"[:80]
            used_item_ids.add(item_id.casefold())
            attempt_base = item_id[:77] + "-a1"
            attempt_id = attempt_base
            suffix = 1
            while attempt_id.casefold() in used_attempt_ids:
                suffix += 1
                attempt_id = f"{attempt_base[:77]}-{suffix}"
            used_attempt_ids.add(attempt_id.casefold())

            state, reason = prepare_state_document(raw, model_path, report["warnings"])
            if state is None:
                report["skipped"].append({"id": raw_id, "reason": reason})
                continue
            state_path = state_dir / "attempts" / f"{attempt_id}.json"
            write_json(state_path, state)
            items_out.append({
                "id": item_id,
                "label": str(zh),
                "selectedAttemptId": attempt_id,
                "attempts": [{
                    "id": attempt_id,
                    "statePath": pathlib.PurePath(state_path).relative_to(spec_path.parent).as_posix(),
                }],
            })
        report["delivered"] = len(items_out)
        if not items_out:
            report["error"] = "没有可交付条目（全部跳过，见 skipped）"
            return finish(2)

        spec = {
            "schema": SPEC_SCHEMA,
            "title": SPEC_TITLE,
            "items": items_out,
            "scene": {"status": "not-requested"},
        }
        write_json(spec_path, spec)
        print(f"[delivery] spec: {spec_path}  items={len(items_out)}  skipped={len(report['skipped'])}")

        if not args.no_prevalidate:
            ok = prevalidate(spec_path, bundle_script, report)
            if not ok:
                return finish(1)

        if args.dry_run:
            report["status"] = "dry-run"
            report["bundle"] = {"status": "not-built", "reason": "--dry-run"}
            return finish(0)

        ensure_output_dir(output_dir, args.force)
        python = find_python(args.python)
        command = [
            python, str(bundle_script), "prepare",
            "--spec", str(spec_path),
            "--output-dir", str(output_dir),
            "--locale", "zh-CN",
        ]
        report["command"] = command
        print("[delivery] 调用: " + " ".join(f'"{c}"' if " " in c else c for c in command))
        proc = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if proc.stdout.strip():
            print(proc.stdout.strip())
        if proc.returncode != 0:
            report["error"] = "delivery_bundle.py prepare 失败: " + (
                (proc.stderr or proc.stdout or "").strip() or f"exit {proc.returncode}"
            )
            return finish(1)
        bundle_manifest = output_dir / "lux3d-delivery.json"
        bundle_doc = read_json(bundle_manifest) if bundle_manifest.is_file() else None
        report["status"] = "ok"
        report["bundle"] = {
            "path": str(output_dir),
            "manifest": str(bundle_manifest),
            "status": (bundle_doc or {}).get("status"),
            "assetStatus": (bundle_doc or {}).get("assetStatus"),
            "locale": "zh-CN",
        }
        print(f"[delivery] 完成 -> {output_dir}")
        return finish(0)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - report any failure in the JSON summary
        report["error"] = f"{type(exc).__name__}: {exc}"
        traceback.print_exc()
        return finish(1)


def prevalidate(spec_path: pathlib.Path, bundle_script: pathlib.Path, report: dict) -> bool:
    """Run delivery_bundle.build_manifest in-process when the runtime is importable."""
    runtime_dir = bundle_script.parent
    if not bundle_script.is_file():
        report["warnings"].append(f"找不到 delivery_bundle.py: {bundle_script}，跳过预校验")
        return True
    sys.path.insert(0, str(runtime_dir))
    try:
        import delivery_bundle  # type: ignore
        spec = read_json(spec_path)
        delivery_bundle.build_manifest(spec, spec_path.parent)
        print("[delivery] 预校验通过（build_manifest）")
        return True
    except ImportError as exc:
        report["warnings"].append(f"运行时不支持进程内预校验（{exc}），交给 prepare 校验")
        return True
    except ValueError as exc:
        report["error"] = f"交付规格校验失败: {exc}"
        return False


if __name__ == "__main__":
    sys.exit(main())
