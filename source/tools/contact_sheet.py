#!/usr/bin/env python
"""Build labelled contact sheets from rendered thumbnails, one sheet per category.

Usage: python contact_sheet.py [--thumbs DIR] [--out DIR] [--cols 7] [--cell 210]
Outputs: dental/preview/sheets/<category>.png  (+ missing-thumb list in stdout)
"""
import argparse
import json
import os
import sys
from collections import OrderedDict

from PIL import Image, ImageDraw, ImageFont

WS = r"D:\coding\qunhe_3d"
DENTAL = os.path.join(WS, "dental")
FONT_CJK = r"C:\Windows\Fonts\msyh.ttc"
FONT_MONO = r"C:\Windows\Fonts\consola.ttf"


def load_font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--thumbs", default=os.path.join(DENTAL, "preview", "thumbs"))
    ap.add_argument("--out", default=os.path.join(DENTAL, "preview", "sheets"))
    ap.add_argument("--cols", type=int, default=7)
    ap.add_argument("--cell", type=int, default=210)
    ap.add_argument("--categories", default="")
    args = ap.parse_args()

    inv = json.load(open(os.path.join(DENTAL, "inventory.json"), encoding="utf-8-sig"))
    items = inv["items"] if isinstance(inv, dict) else inv
    by_cat = OrderedDict()
    for it in items:
        by_cat.setdefault(it["category"], []).append(it)
    os.makedirs(args.out, exist_ok=True)

    f_title = load_font(FONT_CJK, 30)
    f_label = load_font(FONT_MONO, 13)
    cell = args.cell
    label_h = 30
    pad = 10
    cols = args.cols
    only = {c.strip() for c in args.categories.split(",") if c.strip()}

    missing = []
    for cat, cat_items in by_cat.items():
        if only and cat not in only:
            continue
        cat_items = sorted(cat_items, key=lambda x: (x.get("priority", 3), x["id"]))
        rows = (len(cat_items) + cols - 1) // cols
        width = pad + cols * (cell + pad)
        height = 70 + rows * (cell + label_h + pad)
        sheet = Image.new("RGB", (width, height), (250, 251, 253))
        d = ImageDraw.Draw(sheet)
        present = sum(1 for it in cat_items
                      if os.path.exists(os.path.join(args.thumbs, it["id"] + ".png")))
        d.text((pad, 14), f"{cat}  {len(cat_items)} 件（已渲染 {present}）", font=f_title,
               fill=(25, 30, 40))
        for idx, it in enumerate(cat_items):
            r, c = divmod(idx, cols)
            x = pad + c * (cell + pad)
            y = 70 + r * (cell + label_h + pad)
            thumb = os.path.join(args.thumbs, it["id"] + ".png")
            if os.path.exists(thumb):
                try:
                    im = Image.open(thumb).convert("RGB").resize((cell, cell), Image.LANCZOS)
                    sheet.paste(im, (x, y))
                except Exception:
                    d.rectangle([x, y, x + cell, y + cell], outline=(200, 60, 60))
            else:
                missing.append(it["id"])
                d.rectangle([x, y, x + cell, y + cell], fill=(240, 230, 230), outline=(200, 60, 60))
                d.text((x + 8, y + cell // 2 - 8), "MISSING", font=f_label, fill=(180, 40, 40))
            p = it.get("priority", "")
            tag = f"P{p} " if p else ""
            label = f"{tag}{it['id']}"
            d.text((x, y + cell + 4), label[:34], font=f_label, fill=(30, 40, 55))
        out = os.path.join(args.out, cat.replace("/", "_") + ".png")
        sheet.save(out, "PNG", optimize=True)
        print(f"{cat}: {len(cat_items)} items ({present} rendered) -> {out}")

    print("\nmissing thumbs:", len(missing))
    if missing:
        print(" ".join(missing))


if __name__ == "__main__":
    main()
