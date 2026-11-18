#!/usr/bin/env python
"""Regenerate the 9 extra demo assets with text-to-3D G1-Turbo (13 credits each).

Overwrites dental/demo/extra/models/<id>/model.glb (raw; run optimize_models.mjs after).
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

PROMPTS = {
    "ceiling-cassette-ac": "a ceiling cassette air conditioner indoor unit, white square panel with four-way air outlet grille and central intake, isolated product photo, pure white background, three-quarter downward view, studio lighting, photorealistic, high detail",
    "led-panel-light": "a square LED panel ceiling light, thin white aluminum frame, flat uniform white diffuser, isolated product photo, pure white background, three-quarter view, studio lighting, photorealistic",
    "reception-pendant-light": "a modern linear pendant light, long slim white metal bar with warm LED strip underneath, hanging from two thin cables, isolated product photo, pure white background, three-quarter view, studio lighting, photorealistic",
    "coffee-bar-counter": "a modern coffee bar counter, white stone countertop with light wood front panel, small sink and open shelf, isolated product photo, pure white background, three-quarter front view, studio lighting, photorealistic",
    "lead-lined-door": "a lead lined radiation protection door for a hospital x-ray room, single white steel door leaf with stainless steel handle and small warning label, isolated product photo, pure white background, three-quarter front view, studio lighting, photorealistic",
    "waiting-area-rug": "a modern rectangular area rug, soft grey short pile with subtle darker border, viewed from a three-quarter top angle, isolated product photo, pure white background, studio lighting, photorealistic",
    "kids-play-tent": "a small children's play tent, pastel teepee made of canvas fabric with wooden poles, isolated product photo, pure white background, three-quarter front view, studio lighting, photorealistic",
    "lab-fume-hood": "a laboratory fume hood bench, stainless steel frame with transparent glass sash and interior work surface, isolated product photo, pure white background, three-quarter front view, studio lighting, photorealistic",
    "clinic-entrance-door": "a double sliding automatic entrance glass door with slim dark aluminum frame, closed, isolated product photo, pure white background, front view, studio lighting, photorealistic",
}


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def read_json(p):
    with open(p, encoding="utf-8-sig") as f:
        return json.load(f)


def main():
    init = read_json(os.path.join(DENTAL, "logs", "init.json"))
    plan_text = open(os.path.join(DENTAL, "plan", "review-plan-v1.md"), encoding="utf-8").read()
    plan_text += ("\n\n## 补充批次（第二轮：文生 3D）\n"
                  "首批补充件图生 3D 参考图不可用（生成结果错误），改用文生 3D G1-Turbo 重做 9 件："
                  "天花空调、LED 平板灯、前台吊灯、咖啡吧台、铅防护门、候诊地毯、儿童帐篷、技工排风柜、感应玻璃门。")

    items = {}
    ids = [k for k in PROMPTS]
    for seq, iid in enumerate(ids, start=1):
        items[str(seq)] = {
            "endpoint": {"method": "POST", "path": "/lux3d/v1/generate/text-to-3d/task/create"},
            "parameters": {"pathParameters": {}, "queryParameters": {}, "body": {
                "prompt": PROMPTS[iid], "version": TURBO, "outputFormat": ["glb"],
                "faceCount": FACE_COUNT, "enablePbr": True, "aiPredictSize": True}},
        }
    review = {
        "pluginTaskId": init["pluginTaskId"], "planVersion": 1, "plan": plan_text,
        "userInputs": [{"inputId": "input-1",
                        "text": "用这些 3D 资产做一个口腔诊所平台演示网页；缺的物件继续生成补齐。",
                        "addedInVersion": 1}],
        "context": {"model": "deepseek-flash", "clientRegion": "CN"},
    }
    json.dump(review, open(os.path.join(EXTRA, "review-extra-text.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    items_path = os.path.join(EXTRA, "items-extra-text.json")
    json.dump(items, open(items_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    env = dict(os.environ)
    env["LUX3D_CN_API_KEY"] = open(os.path.join(WS, "_secrets", "aholo_cn_api_key.txt"),
                                   encoding="utf-8").read().strip()
    env["PYTHONIOENCODING"] = "utf-8"
    p = subprocess.run([PY, os.path.join(SKILL, "scripts", "commerce.py"), "quote", "--region", "cn",
                        "--items", items_path, "--review", os.path.join(EXTRA, "review-extra-text.json"),
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
    prev_path = os.path.join(EXTRA, "extra-manifest-text.json")
    if os.path.exists(prev_path):
        try:
            prev = read_json(prev_path)
        except Exception:
            prev = {}
        for iid, rec in prev.items():
            if rec.get("status") == "succeeded":
                records[iid] = rec
    queue = [iid for iid in ids if iid not in records]
    active = {}
    while queue or active:
        while queue and len(active) < 5:
            iid = queue.pop(0)
            try:
                tid = C.create_text_to_3d_task(PROMPTS[iid], version=TURBO, faceCount=FACE_COUNT,
                                               outputFormat=["glb"], enablePbr=True, aiPredictSize=True,
                                               region="cn", content_id=quote["quoteId"])
                records[iid] = {"id": iid, "taskId": str(tid), "status": "submitted",
                                "createdAt": now(), "credits": 13, "op": "text-to-3d"}
                active[iid] = str(tid)
                print("submitted", iid, tid, flush=True)
            except Exception as e:
                records[iid] = {"id": iid, "status": "create_failed",
                                "error": repr(e)[:200], "credits": 13}
                print("CREATE FAIL", iid, repr(e)[:160], flush=True)
        json.dump(records, open(os.path.join(EXTRA, "extra-manifest-text.json"), "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        if not active:
            continue
        time.sleep(10)
        for iid, tid in list(active.items()):
            try:
                data = C.get_task(tid, region="cn")
            except Exception as e:
                print("query err", iid, repr(e)[:100]); continue
            st = data.get("status")
            if st in (3, 4, 5, 6):
                rec = records[iid]
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
                        print("OK", iid, got[0][1], flush=True)
                    except Exception as e:
                        rec["status"] = "output_invalid"
                        rec["error"] = repr(e)[:300]
                        print("DL FAIL", iid, repr(e)[:160], flush=True)
                else:
                    rec["status"] = "failed"
                    print("FAIL", iid, st, flush=True)
                active.pop(iid)
                json.dump(records, open(os.path.join(EXTRA, "extra-manifest-text.json"), "w", encoding="utf-8"),
                          ensure_ascii=False, indent=1)
    ok = sum(1 for r in records.values() if r.get("status") == "succeeded")
    print("done", ok, "/", len(records))
    return 0


if __name__ == "__main__":
    sys.exit(main())
