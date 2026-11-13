#!/usr/bin/env python3
"""Build the deep-space image assets from the manifests in tools/deepspace/images/*.json.

  python3 tools/deepspace/build_images.py            # download (cached), verify, make LOD levels, write provenance
  python3 tools/deepspace/build_images.py --only m31-phat
  python3 tools/deepspace/build_images.py --report   # regenerate docs/DEEP_SPACE_IMAGE_PROVENANCE.md only

A manifest file is {"assets": [ ... ]}. Each asset has every field of DeepImageAsset (src/data/deepspace/types.ts)
EXCEPT these, which this script computes and fills in:
  source.sha256, source.retrieved (today, UTC, only when first downloaded), geometry.originalWidthPx/HeightPx, levels.
It additionally needs  "source.downloadUrl"  (the exact file) and may set  "process": {"crop": [l,t,r,b], "maxLevelPx": 4096,
"percentile": [lo, hi], "gamma": g,
"sourceFile": "data/cache/deepspace/x.png"}.
  crop        cropping changes the geometry: declare it in `processing` and give the cropped fovArcmin and centre yourself.
  percentile  optional stretch: lo/hi percentiles (0-100) of the NON-ZERO 8-bit pixel values (all channels together) are mapped to 0/255, clipped.
  gamma       optional stretch applied after `percentile`: out = in ** (1/gamma) on 0..1 (gamma > 1 brightens mid-tones).
              When either is used a sentence stating the exact numbers is appended to `processing` automatically (and the usual
              "no colour or tone changes" claim is replaced by it). They are applied to the cached original, before resizing.
  override    (asset-level flag, not under process) "override": true replaces the asset of the same id declared in another manifest
              (e.g. to re-declare it with a stretch) without editing that manifest; the id must exist elsewhere.
  sourceFile  the asset is a local derived image (repo-relative path), e.g. made by tools/deepspace/make_gaia_density.py, not downloaded;
              its SHA-256 is of that file. source.downloadUrl should then be the https URL/query that reproduces it (the validator
              requires https). A file:// downloadUrl is also accepted by the downloader (used only if sourceFile is absent).

Levels are WebP (quality 80), longest side 256 / 1024 / 2048 / 4096, never upscaled. Level 0 is always <= 256 px.
Originals are cached in data/cache/deepspace/ (not committed).
"""
import argparse, datetime, hashlib, json, os, shutil, sys, urllib.request
from pathlib import Path
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parents[2]
MANIFESTS = ROOT / "tools" / "deepspace" / "images"
CACHE = ROOT / "data" / "cache" / "deepspace"
OUT = ROOT / "public" / "deepspace"
LEVEL_SIDES = [256, 1024, 2048, 4096]
UA = "AtlasOfTheUniverse-asset-build/1.0 (open-source; contact via repository)"


def fetch(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    if url.startswith("file://"):
        shutil.copyfile(urllib.request.url2pathname(url[7:]), dest)
        return
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=180) as r, open(dest.with_suffix(dest.suffix + ".part"), "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    os.replace(dest.with_suffix(dest.suffix + ".part"), dest)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_one(a: dict, force: bool) -> dict:
    aid = a["id"]
    url = a["source"]["downloadUrl"]
    ext = os.path.splitext(url.split("?")[0])[1].lower() or ".img"
    src = CACHE / f"{aid}{ext}"
    sf = (a.get("process") or {}).get("sourceFile")
    if sf:
        src = ROOT / sf          # locally derived image, used in place
        if not src.exists():
            raise FileNotFoundError(f"{sf} (run its generator first)")
    first = not src.exists()
    if not sf:
        fetch(url, src)
    a = json.loads(json.dumps(a))
    a["source"]["sha256"] = sha256(src)
    if first or "retrieved" not in a["source"]:
        a["source"]["retrieved"] = a["source"].get("retrieved") or datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    im = Image.open(src)
    a["geometry"]["originalWidthPx"], a["geometry"]["originalHeightPx"] = im.size
    proc = a.pop("process", {}) or {}
    if im.mode not in ("RGB", "RGBA", "L"):
        im = im.convert("RGB")
    if im.mode == "L":
        im = im.convert("RGB")
    if "crop" in proc:
        im = im.crop(tuple(proc["crop"]))
    stretch = ""
    if "percentile" in proc or "gamma" in proc:
        arr = np.asarray(im.convert("RGB"), dtype=np.float64)
        lo, hi = 0.0, 255.0
        if "percentile" in proc:
            nz = arr[arr > 0]
            lo, hi = (float(v) for v in np.percentile(nz, proc["percentile"]))
        g = float(proc.get("gamma", 1.0))
        out = np.clip((arr - lo) / max(hi - lo, 1e-9), 0, 1) ** (1.0 / g)
        im = Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGB")
        stretch = (f"Declared display stretch applied by us to the 8-bit original before resizing: "
                   + (f"values between the {proc['percentile'][0]}th and {proc['percentile'][1]}th percentile of its non-zero pixels "
                      f"({lo:.0f} and {hi:.0f} of 255) were mapped linearly to 0 and 255 and clipped; " if "percentile" in proc else "")
                   + f"then out = in^(1/{g:g}). This changes contrast only; it adds no information and the original archive image is unchanged.")
    max_level = int(proc.get("maxLevelPx", 4096))
    levels = []
    (OUT / "img").mkdir(parents=True, exist_ok=True)
    long_side = max(im.size)
    sides = [s for s in LEVEL_SIDES if s <= max_level and s < long_side]
    if long_side <= max_level and long_side not in sides:
        sides.append(long_side)          # the full image if it is smaller than the next standard level
    sides = sorted(set(sides)) or [long_side]
    for i, side in enumerate(sides):
        scale = min(1.0, side / long_side)
        w, h = max(1, round(im.size[0] * scale)), max(1, round(im.size[1] * scale))
        lv = im if scale == 1.0 else im.resize((w, h), Image.LANCZOS)
        rel = f"img/{aid}.L{i}.webp"
        lv.save(OUT / rel, "WEBP", quality=80, method=6)
        levels.append({"level": i, "file": rel, "widthPx": w, "heightPx": h, "bytes": (OUT / rel).stat().st_size, "format": "webp"})
    a["levels"] = levels
    a["processing"] = list(a.get("processing", [])) + [
        f"Downloaded original ({a['geometry']['originalWidthPx']}x{a['geometry']['originalHeightPx']} px) and verified its SHA-256.",
        f"Resized with Lanczos to {', '.join(str(l['widthPx']) + 'x' + str(l['heightPx']) for l in levels)} px; encoded as WebP quality 80. No upscaling."
        + ("" if stretch else " No colour or tone changes.")
        + (f" Cropped to {proc['crop']} (declared geometry is of the crop)." if "crop" in proc else ""),
    ]
    if stretch:
        a["processing"].append(stretch)
    return a


def report(assets: list) -> None:
    lines = ["# Deep-space image provenance", "", "Generated by `tools/deepspace/build_images.py` from `public/deepspace/provenance.json`. Do not edit by hand.", "",
             f"{len(assets)} assets. Every row is a real archive image; the licence evidence is the text quoted from the archive.", ""]
    for a in sorted(assets, key=lambda x: (x["objectId"], x["id"])):
        b, s, g, l = a["band"], a["source"], a["geometry"], a["licence"]
        lines += [f"## {a['title']}  (`{a['id']}`, object `{a['objectId']}`)", "",
                  f"- **Source:** {s['archive']} · image id `{s['imageId']}` · [page]({s['landingUrl']}) · [file]({s['downloadUrl']}) · retrieved {s['retrieved']} · SHA-256 `{s['sha256'][:16]}…`",
                  f"- **Credit:** {a['credit']}",
                  f"- **Licence:** {l['name']} ([terms]({l['url']})); attribution required: {l['attributionRequired']}; redistribution allowed: {l['redistributionAllowed']}",
                  f"  - Evidence: “{l['evidence']}”",
                  f"- **Observation:** {a['observation']['telescope']}" + (f" · {a['observation']['instrument']}" if a['observation'].get('instrument') else "") + (f" · {a['observation']['date']}" if a['observation'].get('date') else ""),
                  f"- **Band:** {b['kind']} · filters {', '.join(b['filters']) or 'n/a'} · false colour: {b['falseColour']} · composite: {b['composite']}",
                  f"  - {b['colourNote']}",
                  f"- **Geometry:** original {g['originalWidthPx']}×{g['originalHeightPx']} px · field {g['fovArcmin'][0]}′×{g['fovArcmin'][1]}′ · centre RA {g['centreRaDeg']}°, Dec {g['centreDecDeg']}° · up is {g['upPositionAngleDeg']}° east of north · WCS: {g['wcsSource']}",
                  f"- **Levels:** " + ", ".join(f"L{x['level']} {x['widthPx']}×{x['heightPx']} ({x['bytes'] // 1024} KB)" for x in a['levels']),
                  f"- **Fidelity:** {a['fidelity']}",
                  "- **Processing:** " + " ".join(a['processing']), ""]
    (ROOT / "docs" / "DEEP_SPACE_IMAGE_PROVENANCE.md").write_text("\n".join(lines))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    prov_path = OUT / "provenance.json"
    existing = {a["id"]: a for a in (json.loads(prov_path.read_text())["assets"] if prov_path.exists() else [])}
    if args.report:
        report(list(existing.values()))
        return 0
    wanted, overrides = {}, {}
    for m in sorted(MANIFESTS.glob("*.json")):
        for a in json.loads(m.read_text())["assets"]:
            if a.pop("override", False):      # re-declaration of an asset owned by another manifest (same id, replaces it)
                overrides[a["id"]] = a
                continue
            if a["id"] in wanted:
                raise SystemExit(f"duplicate asset id {a['id']} ({m.name})")
            wanted[a["id"]] = a
    for aid, a in overrides.items():
        if aid not in wanted:
            raise SystemExit(f"override asset {aid} has no asset to replace")
        wanted[aid] = a
    failures = []
    for aid, a in wanted.items():
        if args.only and aid != args.only:
            continue
        try:
            existing[aid] = build_one(a, args.force)
            print(f"ok   {aid}  {[ (l['widthPx'], l['heightPx']) for l in existing[aid]['levels'] ]}")
        except Exception as e:  # noqa: BLE001 - report every failure, keep going
            failures.append((aid, str(e)))
            print(f"FAIL {aid}: {e}", file=sys.stderr)
    # drop assets no longer in any manifest
    existing = {k: v for k, v in existing.items() if k in wanted}
    OUT.mkdir(parents=True, exist_ok=True)
    out = {"manifest": {"schema": "atlas-deep-images/1", "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")}, "assets": sorted(existing.values(), key=lambda x: x["id"])}
    prov_path.write_text(json.dumps(out, indent=1))
    report(out["assets"])
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
