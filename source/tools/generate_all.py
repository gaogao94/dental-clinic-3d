#!/usr/bin/env python
"""Batch-generate the dental clinic object library with the cheapest Lux3D route.

Phase image : image-to-3D  + G1-Turbo (1 credit/call) for items with an uploaded reference image.
Phase text  : text-to-3D   + G1-Turbo (13 credits/call) for items without a usable reference image.

Design:
  * rolling quote groups (default 15 calls) so every create matches a fresh, unexpired quote
  * at most N concurrent account generation slots (default 5, free tier)
  * save each task ID immediately, download GLB as soon as status=3 (output URLs expire in 2h)
  * resume-safe: existing valid model.glb files are skipped
  * durable records: attempts.jsonl, quotes.jsonl, run_manifest.json, budget.json

Usage:
  python generate_all.py [--phase auto|image|text] [--group-size 15] [--slots 5]
                         [--limit N] [--dry-run] [--retry-failed]
"""
import argparse
import json
import os
import struct
import subprocess
import sys
import time

WS = r"D:\coding\qunhe_3d"
DENTAL = os.path.join(WS, "dental")
MODELS = os.path.join(DENTAL, "models")
LOGS = os.path.join(DENTAL, "logs")
SKILL = r"C:\Users\admin\.dsh\skills\aholo-lux3d"
PY = (r"D:\coding\qunhe_3d\.aholo-runtime\environments"
      r"\27e04ca0e2467d06932f4d9c17b382006cebe1c53ec86fb7cb9a547484037f86-77edd84a9bc04ec58150295f47dc11e4"
      r"\Scripts\python.exe")
JOURNAL = os.path.join(LOGS, "collection.sqlite")
sys.path.insert(0, os.path.join(SKILL, "core", "runtime"))
import lux3d_client as C  # noqa: E402

TURBO = "G1-Turbo"
FACE_COUNT = 80000
COST = {"image": 1, "text": 13}


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def read_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8-sig") as f:
        return json.load(f)


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def append_jsonl(path, rec):
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def glb_ok(path):
    try:
        if os.path.getsize(path) < 50000:
            return False
        with open(path, "rb") as f:
            head = f.read(12)
        return head[:4] == b"glTF"
    except Exception:
        return False


def load_done():
    done = {}
    for name in os.listdir(MODELS) if os.path.isdir(MODELS) else []:
        if name.startswith("_"):
            continue
        p = os.path.join(MODELS, name, "model.glb")
        if os.path.exists(p) and glb_ok(p):
            done[name] = p
    return done


def load_inventory():
    inv = read_json(os.path.join(DENTAL, "inventory.json"))
    return inv["items"] if isinstance(inv, dict) else inv


def build_review(plan_version=1, phase_note=""):
    init = read_json(os.path.join(LOGS, "init.json"))
    plan_text = open(os.path.join(DENTAL, "plan", "review-plan-v1.md"), encoding="utf-8").read()
    if phase_note:
        plan_text += "\n\n## 本批次说明\n" + phase_note + "\n"
    review = {
        "pluginTaskId": init["pluginTaskId"],
        "planVersion": plan_version,
        "plan": plan_text,
        "userInputs": [{
            "inputId": "input-1",
            "text": ("我想要生成一个口腔诊所里会用到的所有的东西（室内设计阶段肉眼可见的物件：移动柜、电脑、电脑桌、牙椅等），"
                     "从前台到消毒室所有空间都要覆盖，用最便宜的方法生成尽可能多的物件；目标：要么把所有想到的物件都生成，"
                     "要么额度用完；完成后交付并关机。"),
            "addedInVersion": 1,
        }],
        "attachments": [],
        "context": {"model": "deepseek-flash", "clientRegion": "CN"},
    }
    path = os.path.join(DENTAL, "plan", "review.json")
    write_json(path, review)
    return path


def run_quote(entries, phase, group_no, plan_version=1):
    """entries: list of (item, body, op). Returns quote id + details."""
    items = {}
    for seq, (item, body, op) in enumerate(entries, start=1):
        path = ("/lux3d/v1/generate/img-to-3d/task/create" if op == "image"
                else "/lux3d/v1/generate/text-to-3d/task/create")
        items[str(seq)] = {
            "endpoint": {"method": "POST", "path": path},
            "parameters": {"pathParameters": {}, "queryParameters": {}, "body": body},
        }
    items_path = os.path.join(DENTAL, "plan", f"items-g{group_no:03d}.json")
    write_json(items_path, items)
    review_path = build_review(plan_version, f"第 {group_no} 组（{phase}，{len(entries)} 次调用）。")
    env = dict(os.environ)
    env["LUX3D_CN_API_KEY"] = open(os.path.join(WS, "_secrets", "aholo_cn_api_key.txt"),
                                   encoding="utf-8").read().strip()
    env["PYTHONIOENCODING"] = "utf-8"
    cmd = [PY, os.path.join(SKILL, "scripts", "commerce.py"), "quote", "--region", "cn",
           "--items", items_path, "--review", review_path, "--journal", JOURNAL,
           "--model-name", "deepseek-flash", "--client-region", "CN",
           "--host-name", "DeepSeek Harness"]
    p = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=WS, timeout=240)
    if p.returncode != 0:
        raise RuntimeError(f"quote failed rc={p.returncode}: {(p.stdout or '')[-500:]} {(p.stderr or '')[-800:]}")
    data = json.loads(p.stdout)
    quote = data["quote"]
    expected = sum(COST[op] for _, _, op in entries)
    if quote.get("estimatedCreditsTotal") != expected:
        raise RuntimeError(f"quote total {quote.get('estimatedCreditsTotal')} != expected {expected}")
    rec = {"at": now(), "group": group_no, "phase": phase, "quoteId": quote["quoteId"],
           "reviewId": (quote.get("review") or {}).get("reviewId"),
           "total": quote["estimatedCreditsTotal"], "details": quote.get("details"),
           "expiresAt": quote.get("expiresAt"), "uniqueId": (data.get("account") or {}).get("uniqueId"),
           "balance": (data.get("account") or {}).get("availableCredits")}
    append_jsonl(os.path.join(LOGS, "quotes.jsonl"), rec)
    return quote["quoteId"], quote, data.get("account") or {}


def make_body(item, urls, op, prompt_map=None):
    if op == "image":
        return {
            "img": urls[item["id"]]["url"],
            "version": TURBO,
            "outputFormat": ["glb"],
            "faceCount": FACE_COUNT,
            "enablePbr": True,
            "aiPredictSize": True,
        }
    prompt = ((prompt_map or {}).get(item["id"])
              or item.get("prompt")
              or f"isolated product photo of {item.get('en')}, pure white background, three-quarter front view, studio lighting, photorealistic, high detail")
    return {
        "prompt": prompt,
        "version": TURBO,
        "outputFormat": ["glb"],
        "faceCount": FACE_COUNT,
        "enablePbr": True,
        "aiPredictSize": True,
    }


def create_task(item, body, op, quote_id):
    if op == "image":
        return C.create_image_to_3d_task(
            img=body["img"], version=TURBO, faceCount=FACE_COUNT, outputFormat=["glb"],
            enablePbr=True, aiPredictSize=True, region="cn", content_id=quote_id)
    return C.create_text_to_3d_task(
        body["prompt"], version=TURBO, faceCount=FACE_COUNT, outputFormat=["glb"],
        enablePbr=True, aiPredictSize=True, region="cn", content_id=quote_id)


def save_model(item, task_id, task_data, op):
    expected = C.generation_result_formats(TURBO, ["glb"])
    outputs = C.parse_task_outputs(task_data)
    out_dir = os.path.join(MODELS, item["id"])
    os.makedirs(out_dir, exist_ok=True)
    models = C.download_requested_models(outputs, os.path.join(out_dir, "model"), expected)
    path, size = models[0]
    meta = {
        "id": item["id"], "zh": item.get("zh"), "en": item.get("en"),
        "category": item.get("category"), "room": item.get("room"),
        "priority": item.get("priority"), "taskId": str(task_id), "credits": COST[op],
        "status": "succeeded", "version": TURBO, "faceCount": FACE_COUNT,
        "sourceImage": (f"refs/{item['id']}/ref.jpg" if op == "image" else "text-to-3d"),
        "createdAt": now(), "bytes": size,
    }
    write_json(os.path.join(out_dir, "meta.json"), meta)
    return path, size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", default="auto", choices=["auto", "image", "text"])
    ap.add_argument("--group-size", type=int, default=15)
    ap.add_argument("--slots", type=int, default=5)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--retry-failed", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only-file", default="", help="JSON list of item ids to process (regeneration)")
    ap.add_argument("--force", action="store_true", help="with --only-file: regenerate even if a model exists")
    ap.add_argument("--prompt-map", default="", help="JSON {id: prompt} overrides for text-to-3D")
    args = ap.parse_args()
    prompt_map = read_json(args.prompt_map, {}) if args.prompt_map else {}

    os.makedirs(LOGS, exist_ok=True)
    inventory = load_inventory()
    refs = read_json(os.path.join(DENTAL, "refs", "refs_urls.json"), {})
    done = load_done()
    attempts = read_json(os.path.join(LOGS, "run_manifest.json"), {"schema": "dental-clinic-runs/v1", "items": {}})
    manifest_items = attempts.get("items") or {}

    only_ids = None
    if args.only_file:
        only_ids = set(json.load(open(args.only_file, encoding="utf-8-sig")))
        if args.force:
            done = {k: v for k, v in done.items() if k not in only_ids}

    # previously failed (terminal failure) items
    failed_ids = {k for k, v in manifest_items.items() if v.get("status") == "failed"}

    pending_img, pending_txt = [], []
    for item in inventory:
        iid = item["id"]
        if only_ids is not None and iid not in only_ids:
            continue
        if iid in done:
            continue
        if iid in failed_ids and not args.retry_failed:
            continue
        if iid in refs and refs[iid].get("url"):
            pending_img.append(item)
        else:
            pending_txt.append(item)
    if args.phase == "image":
        pending_txt = []
    elif args.phase == "text":
        pending_img = []
    pending_img.sort(key=lambda x: (x.get("priority", 3), x.get("category", "")))
    pending_txt.sort(key=lambda x: (x.get("priority", 3), x.get("category", "")))
    if args.limit:
        pending_img = pending_img[: args.limit]
        pending_txt = pending_txt[: max(0, args.limit - len(pending_img))]
    print(f"done={len(done)} image-phase={len(pending_img)} text-phase={len(pending_txt)}", flush=True)
    if args.dry_run:
        return

    budget = read_json(os.path.join(LOGS, "budget.json"), {}) or {}
    authorized = budget.get("authorizedTotalCredits", 3200)
    committed = sum(v.get("credits", 0) for v in manifest_items.values()
                    if v.get("status") in ("succeeded", "failed"))
    committed = max(committed, (budget.get("totals") or {}).get("committedCredits", 0))

    jobs = [(it, "image") for it in pending_img] + [(it, "text") for it in pending_txt]
    group_no = len(read_json(os.path.join(LOGS, "quotes.jsonl"), [])) if False else 0
    try:
        group_no = sum(1 for _ in open(os.path.join(LOGS, "quotes.jsonl"), encoding="utf-8")) if os.path.exists(os.path.join(LOGS, "quotes.jsonl")) else 0
    except Exception:
        group_no = 0

    retry_queue = []
    retries_used = {}

    def record_failed(item, op, reason):
        iid = item["id"]
        manifest_items[iid] = {
            "id": iid, "zh": item.get("zh"), "en": item.get("en"),
            "category": item.get("category"), "room": item.get("room"),
            "priority": item.get("priority"), "attemptId": f"{iid}-gen",
            "statePath": f"dental/attempts/{iid}/state.json", "taskId": "",
            "op": op, "version": TURBO, "status": "failed", "providerStatus": None,
            "createdAt": now(), "updatedAt": now(), "localCompletedAt": now(),
            "modelPath": "", "formats": [], "credits": COST[op], "error": reason[:300],
        }

    def schedule_retry(item, op, reason):
        iid = item["id"]
        if retries_used.get(iid, 0) < 1:
            retries_used[iid] = retries_used.get(iid, 0) + 1
            retry_queue.append((item, op))
        else:
            record_failed(item, op, reason)

    while True:
        group = jobs[: args.group_size]
        if not group:
            break
        jobs = jobs[args.group_size:]
        cost = sum(COST[op] for _, op in group)
        if committed + cost > authorized:
            print(f"STOP: budget {authorized - committed} left < group cost {cost}", flush=True)
            break
        group_no += 1
        phase_label = "image" if all(op == "image" for _, op in group) else ("text" if all(op == "text" for _, op in group) else "mixed")
        print(f"== group {group_no} phase={phase_label} size={len(group)} cost={cost} committed={committed}", flush=True)
        entries = [(it, make_body(it, refs, op, prompt_map), op) for it, op in group]
        try:
            quote_id, quote, account = run_quote(entries, phase_label, group_no)
        except Exception as e:
            print("QUOTE FAIL:", repr(e)[:600], flush=True)
            break
        print(f"quote {quote_id} total={quote['estimatedCreditsTotal']} balance={account.get('availableCredits')}", flush=True)

        # submit / poll / download this group
        active = {}   # iid -> dict
        queue = [(it, body, op) for (it, body, op) in entries]
        while queue or active:
            while queue and len(active) < args.slots:
                item, body, op = queue.pop(0)
                iid = item["id"]
                rec = {"id": iid, "op": op, "version": TURBO, "quoteId": quote_id,
                       "status": "submitting", "createdAt": now()}
                append_jsonl(os.path.join(LOGS, "attempts.jsonl"), rec)
                try:
                    tid = create_task(item, body, op, quote_id)
                except Exception as e:
                    msg = repr(e)[:400]
                    print(f"  create FAIL {iid}: {msg}", flush=True)
                    rec.update({"status": "create_failed", "error": msg, "updatedAt": now()})
                    append_jsonl(os.path.join(LOGS, "attempts.jsonl"), rec)
                    if "CONCURRENCY" in msg.upper() or "RATE" in msg.upper() or "限" in msg:
                        queue.append((item, body, op))
                        time.sleep(5)
                    else:
                        schedule_retry(item, op, f"create_failed: {msg}")
                    continue
                rec.update({"status": "submitted", "taskId": str(tid), "updatedAt": now()})
                append_jsonl(os.path.join(LOGS, "attempts.jsonl"), rec)
                committed += COST[op]
                active[iid] = {"item": item, "op": op, "taskId": str(tid), "submittedAt": time.time()}
            if not active:
                time.sleep(2)
                continue
            time.sleep(10)
            for iid, st in list(active.items()):
                try:
                    data = C.get_task(st["taskId"], region="cn")
                except Exception as e:
                    st["queryErrors"] = st.get("queryErrors", 0) + 1
                    print(f"  query ERR {iid}: {repr(e)[:120]}", flush=True)
                    continue
                status = data.get("status")
                if status in (3, 4, 5, 6):
                    item, op = st["item"], st["op"]
                    base = {"id": iid, "op": op, "version": TURBO, "quoteId": quote_id,
                            "taskId": st["taskId"], "providerStatus": status, "updatedAt": now()}
                    if status == 3:
                        try:
                            path, size = save_model(item, st["taskId"], data, op)
                            base.update({"status": "succeeded", "modelPath": path, "bytes": size,
                                         "localCompletedAt": now(), "credits": COST[op]})
                            manifest_items[iid] = {
                                "id": iid, "zh": item.get("zh"), "en": item.get("en"),
                                "category": item.get("category"), "room": item.get("room"),
                                "priority": item.get("priority"),
                                "attemptId": f"{iid}-gen", "statePath": f"dental/attempts/{iid}/state.json",
                                "taskId": st["taskId"], "op": op, "version": TURBO,
                                "status": "succeeded", "providerStatus": 3,
                                "createdAt": base.get("createdAt") or now(), "updatedAt": now(),
                                "localCompletedAt": now(), "modelPath": path, "formats": ["glb"],
                                "credits": COST[op],
                            }
                            print(f"  OK {iid} {size} bytes", flush=True)
                        except Exception as e:
                            base.update({"status": "output_invalid", "error": repr(e)[:400]})
                            schedule_retry(item, op, f"output_invalid: {repr(e)[:250]}")
                            print(f"  DL FAIL {iid}: {repr(e)[:200]}", flush=True)
                    else:
                        base.update({"status": "failed", "error": json.dumps(data.get("outputs") or data.get("m") or [])[:300]})
                        schedule_retry(item, op, f"provider_status_{status}")
                        print(f"  FAIL {iid} status={status}", flush=True)
                    append_jsonl(os.path.join(LOGS, "attempts.jsonl"), base)
                    active.pop(iid)
            # persist manifest + budget periodically
            write_json(os.path.join(LOGS, "run_manifest.json"),
                       {"schema": "dental-clinic-runs/v1", "updatedAt": now(), "items": manifest_items})
            budget.update({"totals": {"committedCredits": committed,
                                      "remainingCredits": authorized - committed,
                                      "authorizedTotalCredits": authorized}})
            write_json(os.path.join(LOGS, "budget.json"), budget)

        # queue one retry round with a fresh quote in the next loop
        if retry_queue:
            jobs = retry_queue + jobs
            retry_queue = []

    # final manifest counts
    ok = sum(1 for v in manifest_items.values() if v.get("status") == "succeeded")
    print(f"finished: succeeded={ok} committed={committed}", flush=True)
    write_json(os.path.join(LOGS, "run_manifest.json"),
               {"schema": "dental-clinic-runs/v1", "updatedAt": now(), "items": manifest_items})


if __name__ == "__main__":
    main()
