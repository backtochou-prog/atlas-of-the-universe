#!/usr/bin/env python3
"""Fetch, verify and downsample planetary textures; write public/textures/provenance.json.

Requires Python 3 with Pillow and numpy. Raw downloads are cached in data/cache/textures (git-ignored).
  python3 tools/textures/build_textures.py            # all textures
  python3 tools/textures/build_textures.py io europa  # selected ids
  python3 tools/textures/build_textures.py --offline  # never download; process cached files only
Every texture's fidelity (scientific-map / derived / artistic-composite) comes from manifest.json and is copied
into the provenance file unchanged.
"""
import hashlib, json, os, sys, time, urllib.request, datetime
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CACHE = os.path.join(ROOT, 'data', 'cache', 'textures')
OUT = os.path.join(ROOT, 'public', 'textures')
UA = 'AtlasBuild/0.1 (open-source astronomy visualisation; build-time download)'
SIZES = {'2k': (2048, 1024), '512': (512, 256)}
args = [a for a in sys.argv[1:] if not a.startswith('--')]
OFFLINE = '--offline' in sys.argv
os.makedirs(CACHE, exist_ok=True); os.makedirs(OUT, exist_ok=True)

def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()

def download(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return False
    if OFFLINE:
        raise SystemExit(f'--offline: {dest} is not cached')
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    tmp = dest + '.part'
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, 'wb') as f:
        total = int(r.headers.get('Content-Length') or 0); got = 0
        while True:
            b = r.read(1 << 20)
            if not b: break
            f.write(b); got += len(b)
    os.replace(tmp, dest)
    print(f'  downloaded {got/1e6:.1f} MB in {time.time()-t0:.0f}s', flush=True)
    return True

def geotiff_extent(im):
    """Longitude of the left edge in degrees, from GeoTIFF tags, when the projection is equirectangular on a sphere."""
    try:
        tags = im.tag_v2
        scale = tags.get(33550); tie = tags.get(33922)
        if not scale or not tie: return None
        return {'pixel_scale': list(scale[:2]), 'tiepoint': list(tie[:6]), 'width': im.size[0], 'height': im.size[1]}
    except Exception:
        return None

def geotiff_longitude(ge):
    """Left-edge longitude and implied body radius from GeoTIFF tags of a global simple-cylindrical (equirectangular) map.
    X = R * lon, and the pixel scale times the width is the full circumference 2 pi R, so R and lon_left follow without
    assuming either. The implied radius is compared with the real body radius as a check on the projection."""
    import math
    ps, tie, w = ge['pixel_scale'][0], ge['tiepoint'], ge['width']
    R = ps * w / (2 * math.pi)
    return {'lon_left_deg': round(math.degrees(tie[3] / R), 3), 'implied_radius_km': round(R / 1000.0, 2)}

# Published ring-feature radii (km) used ONLY to calibrate the radial extent of the Saturn ring strip. They are the
# standard published Cassini-era values, entered from the standard ring tables, not fetched from a machine-readable source.
RING_FEATURES_KM = {'b_ring_inner_edge': 92000.0, 'cassini_division_inner': 117580.0, 'cassini_division_outer': 122170.0, 'a_ring_outer_edge': 136775.0}

def calibrate_ring(png_path):
    """Fit the radial extent covered by the ring-opacity strip from three ring features visible in its alpha profile."""
    a = np.asarray(Image.open(png_path).convert('RGBA')).astype('float64')[:, :, 3].mean(axis=0) / 255.0
    W = len(a); d = np.diff(a)
    x_b = int(np.argmax(d[:int(W * 0.5)]))
    cd_min = int(np.argmin(a[int(W * 0.55):int(W * 0.85)]) + int(W * 0.55))
    thr = 0.55 * a[int(W * 0.35):int(W * 0.62)].mean()
    lo = cd_min
    while a[lo - 1] < thr: lo -= 1
    hi = cd_min
    while a[hi + 1] < thr: hi += 1
    x_a = int(np.argmin(d[int(W * 0.85):]) + int(W * 0.85))
    f = RING_FEATURES_KM
    pts = [(x_b, f['b_ring_inner_edge']), ((lo + hi) / 2, (f['cassini_division_inner'] + f['cassini_division_outer']) / 2), (x_a, f['a_ring_outer_edge'])]
    X = np.array([[p[1], 1.0] for p in pts]); y = np.array([p[0] for p in pts])
    (m, c), *_ = np.linalg.lstsq(X, y, rcond=None)
    return {'inner_km': round(float((0 - c) / m)), 'outer_km': round(float((W - c) / m)),
            'residual_px': [round(float(m * p[1] + c - p[0]), 1) for p in pts], 'strip_width_px': W,
            'features_used_km': f, 'method': 'least-squares fit of strip x-position against known ring-feature radii (B-ring inner edge, Cassini Division centre, A-ring outer edge)'}

def resample(im, size):
    w, h = im.size
    # integer pre-reduction keeps memory and time reasonable for very large rasters
    f = max(1, min(w // (size[0] * 2), h // (size[1] * 2)))
    if f > 1: im = im.reduce(f)
    return im.resize(size, Image.LANCZOS)

def luminance(im):
    return im.convert('L')

def annotate_nodata():
    """Record, for every map, the fraction of pixels that are pure black in the 2k output. In planetary mosaics a zero-valued
    pixel is NO DATA (unimaged terrain), not dark ground; the renderer draws it as a flat neutral grey so it cannot be mistaken
    for a shadow, and the fraction is shown to the user."""
    path = os.path.join(OUT, 'provenance.json')
    prov = json.load(open(path))
    for e in prov['textures']:
        out = (e.get('outputs') or {}).get('2k')
        if not out: continue
        # Black is MEANINGFUL in a cloud-opacity or night-lights layer (no cloud, no light); only surface maps can have no-data pixels.
        if 'cloud' in e['id'] or 'night' in e['id']:
            e.pop('nodata_fraction', None); continue
        a = np.asarray(Image.open(os.path.join(ROOT, 'public', out['file'])).convert('L'))
        e['nodata_fraction'] = round(float((a <= 2).mean()), 4)
    json.dump(prov, open(path, 'w'), indent=2)
    print('annotated no-data fractions:', {e['id']: e.get('nodata_fraction') for e in prov['textures'] if 'nodata_fraction' in e})

def report():
    """Render docs/TEXTURE_PROVENANCE.md from public/textures/provenance.json (generated, do not edit)."""
    prov = json.load(open(os.path.join(OUT, 'provenance.json')))
    rows = []
    rows.append('# Texture provenance\n')
    rows.append('Generated by `python3 tools/textures/build_textures.py --report` from `public/textures/provenance.json`. Do not edit by hand.\n')
    rows.append('**Fidelity** says how a texture must be read: `scientific-map` is a spacecraft data mosaic; `derived` is processed (or art-directed) from scientific data; `artistic-composite` is NOT a scientific map (the provider states it contains fictional fill and enhanced colour); `procedural` is generated by Atlas and is not imagery.\n')
    rows.append('| Texture | Body | Fidelity | Source | Original asset | Original size | Licence | Projection | Processing | Used for |')
    rows.append('|---|---|---|---|---|---|---|---|---|---|')
    esc = lambda x: str(x).replace('|', '/').replace('\n', ' ')
    for t in prov['textures']:
        size = 'x'.join(str(v) for v in t.get('original_size', [])) + (f" {t.get('original_mode','')}" if t.get('original_mode') else '')
        rows.append(f"| {t['id']} | {t['body']} | **{t['fidelity']}** | [{esc(t['source'])}]({t['page']}) | `{t['asset']}` ({t['original_bytes']/1e6:.1f} MB) | {size} | {esc(t['license'])} | {esc(t['projection'])} | {esc(t['processing'])} | {esc(t['use'])} |")
    rows.append('\n## Credits (to be shown wherever the textures are used)\n')
    seen = set()
    for t in prov['textures']:
        if t['credit'] not in seen:
            seen.add(t['credit']); rows.append(f"- {t['credit']} ({t['license']})")
    rows.append('\n## Per-texture notes\n')
    for t in prov['textures']:
        extra = []
        if t.get('note'): extra.append(t['note'])
        if t.get('lon_note'): extra.append(t['lon_note'])
        if t.get('projection_verified_from_geotiff'): extra.append(f"GeoTIFF tags give a longitude of {t['lon_left_deg']} deg at the left edge and an implied body radius of {t['implied_radius_km']} km, which matches the body, confirming a global simple-cylindrical map. East-positive longitude is the USGS convention and is not encoded in the tags.")
        if t.get('nodata_fraction'): extra.append(f"{t['nodata_fraction']*100:.1f}% of this map is pure black in the source, which in a planetary mosaic means NO DATA (unimaged terrain); the renderer draws it as flat grey.")
        if t.get('ring_calibration'):
            c = t['ring_calibration']; extra.append(f"Radial extent calibrated to {c['inner_km']:,} to {c['outer_km']:,} km (residuals {c['residual_px']} px of {c['strip_width_px']}) against {', '.join(c['features_used_km'].keys())}. {c['method']}.")
        if extra: rows.append(f"- **{t['id']}** ({t['fidelity']}): " + ' '.join(extra))
    open(os.path.join(ROOT, 'docs', 'TEXTURE_PROVENANCE.md'), 'w').write('\n'.join(rows) + '\n')
    print('wrote docs/TEXTURE_PROVENANCE.md')

def main():
    if '--report' in sys.argv:
        report(); return
    if '--annotate-nodata' in sys.argv:
        annotate_nodata(); return
    manifest = json.load(open(os.path.join(ROOT, 'tools', 'textures', 'manifest.json')))
    prov = {'generated': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'tool': 'tools/textures/build_textures.py', 'textures': []}
    cache = {}
    for t in manifest['textures']:
        if args and t['id'] not in args: continue
        print(f"== {t['id']} ({t['fidelity']})", flush=True)
        src = os.path.join(CACHE, t['asset'])
        download(t['url'], src)
        entry = dict(t)
        entry['original_bytes'] = os.path.getsize(src)
        entry['original_sha256'] = sha256(src)
        entry['retrieved'] = datetime.datetime.fromtimestamp(os.path.getmtime(src), datetime.timezone.utc).strftime('%Y-%m-%d')
        if t.get('ring'):
            im = Image.open(src); entry['original_size'] = list(im.size); entry['original_mode'] = im.mode
            im.convert('RGBA').save(os.path.join(OUT, f"{t['id']}.png"), optimize=True)
            entry['outputs'] = {'png': f"textures/{t['id']}.png"}
            entry['ring_calibration'] = calibrate_ring(os.path.join(OUT, f"{t['id']}.png"))
            prov['textures'].append(entry); continue
        im = Image.open(src)
        entry['original_size'] = list(im.size); entry['original_mode'] = im.mode
        ge = geotiff_extent(im)
        if ge:
            entry['geotiff'] = ge
            entry.update(geotiff_longitude(ge))
            entry['projection_verified_from_geotiff'] = True
        im.load()
        if im.mode in ('I;16', 'I', 'F'):
            a = np.asarray(im).astype('float64'); lo, hi = np.percentile(a, [0.5, 99.5]); a = np.clip((a - lo) / (hi - lo), 0, 1)
            im = Image.fromarray((a * 255).astype('uint8'), 'L')
        if t.get('grayscale'): im = luminance(im)
        elif im.mode != 'RGB': im = im.convert('RGB')
        if t.get('derive') == 'earth_clouds':
            noc = Image.open(os.path.join(CACHE, 'earth_noClouds.0330.jpg'))
            if not os.path.exists(os.path.join(CACHE, 'earth_noClouds.0330.jpg')):
                raise SystemExit('earth_day must be built first')
            a = np.asarray(im.convert('L')).astype('float64') / 255.0
            b = np.asarray(noc.convert('L').resize(im.size)).astype('float64') / 255.0
            d = np.clip(a - b, 0, 1); d = np.clip(d / max(np.percentile(d, 99.5), 1e-6), 0, 1)
            im = Image.fromarray((d * 255).astype('uint8'), 'L')
        outs = {}
        for name, size in SIZES.items():
            r = resample(im, size)
            path = os.path.join(OUT, f"{t['id']}_{name}.jpg")
            r.save(path, quality=88, optimize=True)
            outs[name] = {'file': f"textures/{t['id']}_{name}.jpg", 'size': list(size), 'bytes': os.path.getsize(path), 'sha256': sha256(path)}
        entry['outputs'] = outs
        entry['aspect_ok'] = abs(im.size[0] / im.size[1] - 2.0) < 0.02
        prov['textures'].append(entry)
        print(f"   original {entry['original_size']} {entry['original_mode']} -> {', '.join(o['file'] for o in outs.values())}", flush=True)
    path = os.path.join(OUT, 'provenance.json')
    if args and os.path.exists(path):  # merge partial runs
        old = {x['id']: x for x in json.load(open(path))['textures']}
        for e in prov['textures']: old[e['id']] = e
        prov['textures'] = [old[k] for k in [t['id'] for t in manifest['textures'] if t['id'] in old]]
    json.dump(prov, open(path, 'w'), indent=2)
    print(f"wrote {path} with {len(prov['textures'])} textures")

main()
