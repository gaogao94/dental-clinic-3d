#!/usr/bin/env python
"""Generate the extra demo assets (image-to-3D G1-Turbo, 1 credit each).

Reads:  dental/demo/extra/inventory-extra.json, dental/refs/refs_urls.json
Writes: dental/demo/extra/models/<id>/model.glb
        dental/demo/extra/extra-manifest.json
"""
import json
import os
import subprocess
import sys
import time

WS = r"D:\coding\qunhe_3d"
DENTAL = os.path.join(WS, "dental")
EXTRA = os.path.join(DENTAL, "demo", "extra")
SKILL = r"C:\Users\admin\.dsh\skills\aholo-lux3d"
PY = (r"D:\coding\qunhe_3d\.aholo-runtime\environments"
      r"\27e04ca0e2467d06932f4d9c17b382006cebe1c53ec86fb7cb9a547484037f86-77edd84a9bc04ec58150295f47dc11e4"
      r"\Scripts\python.exe")
sys.path.insert(0, os.path.join(SKILL, "core", "runtime"))
import lux3d_client as C  # noqa: E402

TURBO = "G1-Turbo"
FACE_COUNT = 80000


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def read_json(p):
    with open(p, encoding="utf-8-sig") as f:
        return json.load(f)


def main():
    inv = read_json(os.path.join(EXTRA, "inventory-extra.json"))["items"]
    urls = read_json(os.path.join(DENTAL, "refs", "refs_urls.json"))
    init = read_json(os.path.join(DENTAL, "logs", "init.json"))
    plan_text = open(os.path.join(DENTAL, "plan", "review-plan-v1.md"), encoding="utf-8").read()
    plan_text += ("\n\n## 补充批次：诊所平台演示缺件\n"
                  "为「口腔诊所平台」3D 演示补充 9 件场景缺失物件（天花空调、灯具、吧台、铅防护门、地毯、帐篷、排风柜、感应门），"
                  "image-to-3D G1-Turbo，1 积分/件。")

    items_quote, ids = {}, []
    for seq, it in enumerate(inv, start=1):
        if it["id"] not in urls:
            print("NO URL:", it["id"])
            continue
        if os.path.exists(os.path.join(EXTRA, "models", it["id"], "model.glb")):
            print("SKIP existing:", it["id"])
            continue
        ids.append(it["id"])
        items_quote[str(seq)] = {
            "endpoint": {"method": "POST", "path": "/lux3d/v1/generate/img-to-3d/task/create"},
            "parameters": {"pathParameters": {}, "queryParameters": {}, "body": {
                "img": urls[it["id"]]["url"], "version": TURBO, "outputFormat": ["glb"],
                "faceCount": FACE_COUNT, "enablePbr": True, "aiPredictSize": True}},
        }
    review = {
        "pluginTaskId": init["pluginTaskId"], "planVersion": 1, "plan": plan_text,
        "userInputs": [{"inputId": "input-1",
                        "text": "用这些 3D 资产做一个口腔诊所平台演示网页；缺的物件继续生成补齐。",
                        "addedInVersion": 1}],
        "context": {"model": "deepseek-flash", "clientRegion": "CN"},
    }
    os.makedirs(EXTRA, exist_ok=True)
    json.dump(review, open(os.path.join(EXTRA, "review-extra.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    items_path = os.path.join(EXTRA, "items-extra.json")
    json.dump(items_quote, open(items_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    env = dict(os.environ)
    env["LUX3D_CN_API_KEY"] = open(os.path.join(WS, "_secrets", "aholo_cn_api_key.txt"),
                                   encoding="utf-8").read().strip()
    env["PYTHONIOENCODING"] = "utf-8"
    p = subprocess.run([PY, os.path.join(SKILL, "scripts", "commerce.py"), "quote", "--region", "cn",
                        "--items", items_path, "--review", os.path.join(EXTRA, "review-extra.json"),
                        "--journal", os.path.join(DENTAL, "logs", "collection.sqlite"),
                        "--model-name", "deepseek-flash", "--client-region", "CN",
                        "--host-name", "DeepSeek Harness"],
                       capture_output=True, text=True, env=env, cwd=WS, timeout=240)
    if p.returncode != 0:
        print("QUOTE FAIL", p.returncode, p.stdout[-800:], p.stderr[-800:])
        return 1
    quote = json.loads(p.stdout)["quote"]
    print("quote", quote["quoteId"], "total", quote["estimatedCreditsTotal"], flush=True)

    records = {}
    for it in inv:
        iid = it["id"]
        if it["id"] not in ids:
            continue
        try:
            tid = C.create_image_to_3d_task(
                img=urls[iid]["url"], version=TURBO, faceCount=FACE_COUNT, outputFormat=["glb"],
                enablePbr=True, aiPredictSize=True, region="cn", content_id=quote["quoteId"])
            records[iid] = {"id": iid, "zh": it["zh"], "taskId": str(tid), "status": "submitted",
                            "createdAt": now(), "credits": 1}
            print("submitted", iid, tid, flush=True)
        except Exception as e:
            records[iid] = {"id": iid, "status": "create_failed", "error": repr(e)[:200]}
            print("CREATE FAIL", iid, repr(e)[:200], flush=True)
    json.dump(records, open(os.path.join(EXTRA, "extra-manifest.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    pending = {k: v for k, v in records.items() if v.get("taskId")}
    os.makedirs(os.path.join(EXTRA, "models"), exist_ok=True)
    deadline = time.time() + 1800
    while pending and time.time() < deadline:
        for iid, rec in list(pending.items()):
            try:
                data = C.get_task(rec["taskId"], region="cn")
            except Exception as e:
                print("query err", iid, repr(e)[:100]); continue
            st = data.get("status")
            if st in (3, 4, 5, 6):
                rec["providerStatus"] = st
                rec["updatedAt"] = now()
                if st == 3:
                    try:
                        expected = C.generation_result_formats(TURBO, ["glb"])
                        outputs = C.parse_task_outputs(data)
                        outdir = os.path.join(EXTRA, "models", iid)
                        os.makedirs(outdir, exist_ok=True)
                        got = C.download_requested_models(outputs, os.path.join(outdir, "model"), expected)
                        rec["status"] = "succeeded"
                        rec["modelPath"] = got[0][0]
                        rec["bytes"] = got[0][1]
                        rec["localCompletedAt"] = now()
                        print("OK", iid, got[0], flush=True)
                    except Exception as e:
                        rec["status"] = "output_invalid"
                        rec["error"] = repr(e)[:300]
                        print("DL FAIL", iid, repr(e)[:200], flush=True)
                else:
                    rec["status"] = "failed"
                    print("FAIL", iid, st, flush=True)
                pending.pop(iid)
                json.dump(records, open(os.path.join(EXTRA, "extra-manifest.json"), "w", encoding="utf-8"),
                          ensure_ascii=False, indent=1)
        if pending:
            time.sleep(10)
    print("done", sum(1 for r in records.values() if r.get("status") == "succeeded"), "/", len(records))
    return 0


if __name__ == "__main__":
    sys.exit(main())
