#!/usr/bin/env python
"""Upload local reference images to the Lux3D Asset service and record public URLs.

Reads:  dental/refs/refs_manifest.json (entries with status ok/cached + path)
Writes: dental/refs/refs_urls.json   {id: {file, url, uploadedAt, size}}
Usage:  python upload_refs.py [--limit N] [--workers 4] [--force] [--ids id1,id2]
"""
import argparse
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REFS = os.path.join(ROOT, "refs")
MANIFEST = os.path.join(REFS, "refs_manifest.json")
URLS = os.path.join(REFS, "refs_urls.json")
SKILL = r"C:\Users\admin\.dsh\skills\aholo-lux3d"
sys.path.insert(0, os.path.join(SKILL, "core", "runtime"))
import asset_uploader  # noqa: E402

_lock = threading.Lock()
_print_lock = threading.Lock()


def log(msg):
    with _print_lock:
        print(msg, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--ids", default="")
    args = ap.parse_args()

    manifest = json.load(open(MANIFEST, encoding="utf-8"))
    urls = {}
    if os.path.exists(URLS):
        try:
            urls = json.load(open(URLS, encoding="utf-8-sig"))
        except Exception:
            urls = {}
    only = {s.strip() for s in args.ids.split(",") if s.strip()}
    todo = []
    for iid, rec in manifest.items():
        if only and iid not in only:
            continue
        if rec.get("status") not in ("ok", "cached"):
            continue
        if iid in urls and not args.force:
            continue
        path = rec.get("path") or os.path.join(REFS, iid, "ref.jpg")
        if os.path.exists(path):
            todo.append((iid, path))
    if args.limit:
        todo = todo[: args.limit]
    log(f"uploading {len(todo)} refs, workers={args.workers}")

    def work(iid, path):
        res = asset_uploader.upload_file(path, region="cn", sleep_fn=time.sleep)
        return iid, {"file": path, "url": res["url"], "size": res.get("size"),
                     "uploadedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")}

    n = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(work, iid, path): iid for iid, path in todo}
        for fut in as_completed(futs):
            iid = futs[fut]
            try:
                iid, rec = fut.result()
                with _lock:
                    urls[iid] = rec
                n += 1
                if n % 10 == 0:
                    log(f"[{n}/{len(todo)}] uploaded")
            except Exception as e:
                log(f"FAIL {iid}: {type(e).__name__}: {str(e)[:160]}")

    tmp = URLS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(urls, f, ensure_ascii=False, indent=1)
    os.replace(tmp, URLS)
    log(f"done: urls={len(urls)} file={URLS}")


if __name__ == "__main__":
    main()
