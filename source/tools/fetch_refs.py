#!/usr/bin/env python
"""Fetch one product reference image per dental-clinic inventory item.

Sources (no API key): Bing image async (zh + en), 360 image search, Baidu image search.
Output: dental/refs/<id>/ref.jpg  +  dental/refs/refs_manifest.json
Usage: python fetch_refs.py [--inventory PATH] [--limit N] [--workers 6] [--force]
"""
import argparse
import io
import json
import os
import random
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

from PIL import Image

_SSL_CTX = ssl.create_default_context()
_SSL_NOVERIFY = ssl._create_unverified_context()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REFS = os.path.join(ROOT, "refs")
MANIFEST = os.path.join(REFS, "refs_manifest.json")
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
_lock = threading.Lock()
_done = {"n": 0, "total": 0}
_print_lock = threading.Lock()


def log(msg):
    with _print_lock:
        print(msg, flush=True)


def http_get(url, timeout=18, headers=None):
    h = {"User-Agent": UA, "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
         "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    try:
        r = urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX)
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", None)
        if isinstance(reason, ssl.SSLCertVerificationError) or isinstance(reason, ssl.SSLError):
            r = urllib.request.urlopen(req, timeout=timeout, context=_SSL_NOVERIFY)
        else:
            raise
    with r:
        return r.read(), r.headers.get("Content-Type", "")


def _dedupe(urls, seen):
    out = []
    for u in urls:
        u = u.replace("&amp;", "&").strip()
        if not u.lower().startswith(("http://", "https://")):
            continue
        key = u.split("?")[0].lower()
        if key in seen:
            continue
        if key.endswith((".gif", ".svg")):
            continue
        seen.add(key)
        out.append(u)
    return out


def search_bing_async(q, mkt="zh-CN"):
    url = ("https://cn.bing.com/images/async?q=" + urllib.parse.quote(q)
           + "&first=0&count=35&mkt=" + mkt + "&adlt=off")
    try:
        raw, _ = http_get(url)
        html = raw.decode("utf-8", "ignore")
    except Exception:
        return []
    urls = re.findall(r"murl&quot;:&quot;(.*?)&quot;", html)
    if not urls:
        urls = [m.replace("\\/", "/") for m in re.findall(r'"murl":"(.*?)"', html)]
    return urls


def search_so360(q):
    url = "https://image.so.com/j?q=" + urllib.parse.quote(q) + "&pn=30&rn=24&src=srp"
    try:
        raw, _ = http_get(url)
        d = json.loads(raw.decode("utf-8", "ignore"))
    except Exception:
        return []
    urls = []
    for it in d.get("list") or []:
        u = it.get("img") or it.get("thumb") or it.get("imgUrl")
        if u:
            urls.append(u)
    return urls


def search_baidu(q):
    url = ("https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&word="
           + urllib.parse.quote(q)
           + "&pn=0&rn=24&ie=utf-8&oe=utf-8&fr=&cl=2&lm=-1&st=-1&ct=201326592")
    try:
        raw_b, _ = http_get(url, headers={"Referer": "https://image.baidu.com/",
                                          "Cookie": "BD_UPN=1; BAIDUID=0000"})
        d = json.loads(raw_b.decode("utf-8", "ignore"))
    except Exception:
        return []
    urls = []
    for it in d.get("data") or []:
        if not isinstance(it, dict):
            continue
        u = it.get("middleURL") or it.get("thumbURL") or it.get("hoverURL")
        if u:
            urls.append(u)
    return urls


def border_whiteness(img):
    img = img.convert("RGB")
    w, h = img.size
    px = img.load()
    total = white = 0
    step = max(1, min(w, h) // 60)
    pts = []
    for x in range(0, w, step):
        pts.append((x, 0)); pts.append((x, h - 1))
    for y in range(0, h, step):
        pts.append((0, y)); pts.append((w - 1, y))
    for (x, y) in pts:
        r, g, b = px[x, y]
        total += 1
        if r > 235 and g > 235 and b > 235:
            white += 1
    return white / max(total, 1)


def url_keyword_boost(url, keywords):
    low = urllib.parse.unquote(url).lower()
    for k in keywords:
        if k and k.lower() in low:
            return 0.9
    return 0.0


def image_stddev(img):
    """Brightness std-dev on a small grayscale copy; very low = placeholder/flat image."""
    try:
        g = img.convert("L").resize((48, 48))
        vals = list(g.getdata())
        mean = sum(vals) / len(vals)
        var = sum((v - mean) ** 2 for v in vals) / len(vals)
        return var ** 0.5
    except Exception:
        return 99.0


def evaluate(data, ctype, url, keywords):
    if len(data) < 12000:
        return None, None
    if ctype and "image" not in ctype and not data.startswith((b"\xff\xd8", b"\x89PNG", b"RIFF")):
        return None, None
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception:
        return None, None
    w, h = img.size
    if min(w, h) < 280 or max(w, h) > 5000:
        return None, None
    aspect = w / float(h)
    if aspect < 0.40 or aspect > 2.7:
        return None, None
    if image_stddev(img) < 14:  # anti-hotlink placeholder / flat banner
        return None, None
    whiteness = border_whiteness(img)
    score = min(w, h) / 1100.0 * 0.5 + whiteness * 2.0
    score += (1.0 - min(abs(aspect - 1.0) / 1.2, 1.0)) * 0.4
    score += url_keyword_boost(url, keywords)
    return score, img


def collect_urls(item, variant=0):
    zh = (item.get("q_zh") or "").strip()
    en = (item.get("q_en") or "").strip()
    zh_name = (item.get("zh") or "").strip()
    en_name = (item.get("en") or "").strip()
    queries = []
    if variant == 0:
        if zh:
            queries.append(("bing_zh", zh))
        if en:
            queries.append(("bing_en", en))
        en_base = re.sub(r"(?i)\b(product photo|white background|isolated|photo)\b", "", en).strip(" ,-")
        if en_base:
            queries.append(("bing_en", en_base + " product white background"))
        if zh:
            queries.append(("so360", zh))
            queries.append(("baidu", zh))
    elif variant == 1:
        for q in (f"{zh_name} 白底 实物图", f"{zh_name} 产品图 高清", f"{en_name} isolated on white background product",
                  f"{en_name} product photo front view white background"):
            if q.strip():
                queries.append(("bing_zh" if any(ord(c) > 127 for c in q) else "bing_en", q))
        if zh_name:
            queries.append(("so360", zh_name + " 产品"))
            queries.append(("baidu", zh_name + " 白底"))
    else:
        for q in (f"{en_name} png transparent isolated object", f"{zh_name} 实物 白底 高清",
                  f"{en_name} studio product shot"):
            if q.strip():
                queries.append(("bing_zh" if any(ord(c) > 127 for c in q) else "bing_en", q))
    seen = set()
    for kind, q in queries:
        try:
            if kind == "bing_zh":
                got = search_bing_async(q, "zh-CN")
            elif kind == "bing_en":
                got = search_bing_async(q, "en-US")
            elif kind == "so360":
                got = search_so360(q)
            else:
                got = search_baidu(q)
        except Exception:
            got = []
        got = _dedupe(got, seen)
        for u in got:
            yield u


def pick_image(item, variant=0):
    zh = (item.get("zh") or "")
    en = (item.get("en") or "")
    keywords = [en] + [w for w in re.split(r"[\s\-_/]+", en) if len(w) > 3] + [zh]
    keywords = [k for k in keywords if k]
    best = (None, None, None, -1)
    tried = 0
    for url in collect_urls(item, variant):
        if tried >= 22:
            break
        tried += 1
        try:
            data, ctype = http_get(url, timeout=15, headers={"Referer": "https://cn.bing.com/"})
        except Exception:
            continue
        score, img = evaluate(data, ctype, url, keywords)
        if score is None:
            continue
        if score > best[3]:
            best = (img, url, None, score)
        if best[3] >= 2.15:
            break
    return best


def save_ref(item_id, img):
    d = os.path.join(REFS, item_id)
    os.makedirs(d, exist_ok=True)
    w, h = img.size
    if max(w, h) > 1400:
        scale = 1400.0 / max(w, h)
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    img = img.convert("RGB")
    path = os.path.join(d, "ref.jpg")
    img.save(path, "JPEG", quality=88, optimize=True)
    return path, img.size


def process(item, force=False, variant=0):
    iid = item["id"]
    dest = os.path.join(REFS, iid, "ref.jpg")
    if os.path.exists(dest) and not force:
        return {"id": iid, "status": "cached", "path": dest}
    result = {"id": iid, "zh": item.get("zh"), "category": item.get("category"), "status": "missing"}
    for attempt in range(2):
        try:
            img, url, _, score = pick_image(item, variant)
            if img is not None:
                path, size = save_ref(iid, img)
                result.update({"status": "ok", "path": path, "sourceUrl": url,
                               "width": size[0], "height": size[1], "score": round(score, 3)})
                break
        except Exception as e:
            result["error"] = repr(e)[:200]
        time.sleep(1.0 + random.random())
    return result


def load_manifest():
    if os.path.exists(MANIFEST):
        try:
            return json.load(open(MANIFEST, encoding="utf-8"))
        except Exception:
            return {}
    return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inventory", default=os.path.join(ROOT, "inventory.json"))
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--variant", type=int, default=0, choices=[0, 1, 2])
    ap.add_argument("--ids", default="")
    args = ap.parse_args()

    inv = json.load(open(args.inventory, encoding="utf-8-sig"))
    items = inv["items"] if isinstance(inv, dict) else inv
    only = {s.strip() for s in args.ids.split(",") if s.strip()}
    if only:
        items = [it for it in items if it["id"] in only]
    if args.limit:
        items = items[: args.limit]
    os.makedirs(REFS, exist_ok=True)
    manifest = load_manifest()
    _done["total"] = len(items)
    log(f"fetching refs for {len(items)} items, workers={args.workers}")

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(process, it, args.force, args.variant): it for it in items}
        for fut in as_completed(futs):
            it = futs[fut]
            try:
                res = fut.result()
            except Exception as e:
                res = {"id": it["id"], "status": "missing", "error": repr(e)[:200]}
            with _lock:
                manifest[res["id"]] = res
                _done["n"] += 1
                n = _done["n"]
            if n % 10 == 0 or res["status"] != "ok":
                log(f"[{n}/{_done['total']}] {res['id']}: {res['status']}")

    if not only:
        ids = {it["id"] for it in items}
        manifest = {k: v for k, v in manifest.items() if k in ids}
    tmp = MANIFEST + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    os.replace(tmp, MANIFEST)
    ok = sum(1 for v in manifest.values() if v["status"] in ("ok", "cached"))
    log(f"done: ok={ok} missing={len(manifest)-ok} manifest={MANIFEST}")


if __name__ == "__main__":
    main()
