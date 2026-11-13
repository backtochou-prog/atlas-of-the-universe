#!/usr/bin/env python3
"""Gaia DR3 star-density maps (derived images made by us from real catalogue counts).

  python3 tools/deepspace/make_gaia_density.py lmc
  python3 tools/deepspace/make_gaia_density.py smc [--level 12] [--colour]

What it does
  1. Asks the ESA Gaia archive TAP service (https://gea.esac.esa.int/tap-server/tap, async/UWS, same endpoint as
     src/data/ingestion/tap.ts) for a HEALPix aggregation of gaiadr3.gaia_source inside a circle:
         SELECT hp, COUNT(*) AS n, AVG(bp_rp) AS bprp FROM (SELECT source_id/(2^35 * 4^(12-L)) AS hp, bp_rp
           FROM gaiadr3.gaia_source WHERE 1=CONTAINS(POINT('ICRS',ra,dec), CIRCLE('ICRS',ra0,dec0,r))) AS s GROUP BY hp
     (bigint division of source_id = the nested HEALPix index at level L, ICRS; the numeric divisor is written out in the query). No source is filtered by magnitude,
     parallax or proper motion: foreground Milky Way stars are included.
  2. Renders it on a stated north-up TAN grid (east left): each output pixel takes the count of the HEALPix cell that
     contains its centre (nested ang2pix implemented here with numpy; verified against Gaia's own index), divided by
     the cell area (stars / arcmin^2). Pixel scale ~ the cell size, so there is no interpolation or invented detail.
  3. Log stretch: v = log10(1 + d/d_ref) / log10(1 + d_max/d_ref); d_ref = 5th percentile of non-zero densities,
     d_max = 99.9th percentile (clipped). Written as an 8-bit greyscale PNG to data/cache/deepspace/gaia-density-<t>.png
     plus a .json sidecar with the exact numbers used. --colour also writes a variant whose hue encodes the mean
     BP-RP of the stars in each cell (blue = small BP-RP, red = large; a false-colour mapping defined below).
Pixels outside the query circle are black and mean "not queried", not "no stars".
"""
import argparse, csv, io, json, math, os, sys, time, urllib.parse, urllib.request
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "data" / "cache" / "deepspace"
TAP = "https://gea.esac.esa.int/tap-server/tap"
UA = "AtlasOfTheUniverse-asset-build/1.0 (open-source)"
TARGETS = {  # centre (ICRS deg), circle radius (deg), output pixels, pixel scale (arcmin)
    "lmc": dict(ra=80.894, dec=-69.756, radius=6.0, npx=840, scale=0.85),
    "smc": dict(ra=13.187, dec=-72.829, radius=3.4, npx=480, scale=0.85),
}


def http(url, data=None, timeout=120):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode() if data is not None else None, headers={"User-Agent": UA})
    return urllib.request.urlopen(req, timeout=timeout)


def adql(t, level):
    div = 2 ** 35 * 4 ** (12 - level)  # bigint division of source_id == nested HEALPix index at `level`
    return (f"SELECT hp, COUNT(*) AS n, AVG(bp_rp) AS bprp FROM (SELECT source_id/{div} AS hp, bp_rp FROM gaiadr3.gaia_source "
            f"WHERE 1=CONTAINS(POINT('ICRS',ra,dec), CIRCLE('ICRS',{t['ra']},{t['dec']},{t['radius']}))) AS s GROUP BY hp")


def run_async(q, dest):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    body = urllib.parse.urlencode(dict(REQUEST="doQuery", LANG="ADQL", FORMAT="csv", PHASE="RUN", MAXREC="5000000", QUERY=q)).encode()
    try:
        r = opener.open(urllib.request.Request(f"{TAP}/async", data=body, headers={"User-Agent": UA}), timeout=120)
        job = r.headers.get("Location")
    except urllib.error.HTTPError as e:  # 303 See Other carries the job URL
        job = e.headers.get("Location")
        if not job:
            raise
    print("job", job)
    while True:
        ph = http(job + "/phase").read().decode().strip()
        print("phase", ph, flush=True)
        if ph == "COMPLETED":
            break
        if ph in ("ERROR", "ABORTED"):
            raise SystemExit(http(job + "/error").read().decode())
        time.sleep(10)
    with http(job + "/results/result", timeout=600) as r, open(dest, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)


def _spread(v):  # interleave: bit k of v -> bit 2k
    v = v.astype(np.int64)
    v = (v | (v << 16)) & 0x0000FFFF0000FFFF
    v = (v | (v << 8)) & 0x00FF00FF00FF00FF
    v = (v | (v << 4)) & 0x0F0F0F0F0F0F0F0F
    v = (v | (v << 2)) & 0x3333333333333333
    v = (v | (v << 1)) & 0x5555555555555555
    return v


def ang2pix_nested(nside, ra_deg, dec_deg):
    """HEALPix nested index of (ra, dec) (Gorski et al. 2005 ang2pix_nest); vectorised."""
    z = np.sin(np.radians(dec_deg))
    tt = (np.radians(ra_deg) % (2 * np.pi)) / (np.pi / 2)  # in [0, 4)
    za = np.abs(z)
    # equatorial belt
    t1 = nside * (0.5 + tt)
    t2 = nside * z * 0.75
    jp = np.floor(t1 - t2).astype(np.int64)
    jm = np.floor(t1 + t2).astype(np.int64)
    ifp, ifm = jp // nside, jm // nside
    face_e = np.where(ifp == ifm, ifp | 4, np.where(ifp < ifm, ifp, ifm + 8))
    ix_e = jm & (nside - 1)
    iy_e = nside - (jp & (nside - 1)) - 1
    # polar caps
    ntt = np.minimum(tt.astype(np.int64), 3)
    tp = tt - ntt
    tmp = nside * np.sqrt(3 * (1 - za))
    jpp = np.minimum(np.floor(tp * tmp).astype(np.int64), nside - 1)
    jmp = np.minimum(np.floor((1 - tp) * tmp).astype(np.int64), nside - 1)
    north = z >= 0
    face_p = np.where(north, ntt, ntt + 8)
    ix_p = np.where(north, nside - jmp - 1, jpp)
    iy_p = np.where(north, nside - jpp - 1, jmp)
    eq = za <= 2.0 / 3.0
    face, ix, iy = np.where(eq, face_e, face_p), np.where(eq, ix_e, ix_p), np.where(eq, iy_e, iy_p)
    return face * nside * nside + _spread(ix) + (_spread(iy) << 1)


def tan_grid(t):
    n, sc = t["npx"], math.radians(t["scale"] / 60.0)
    i = (np.arange(n) - (n - 1) / 2.0)
    xi = -i[None, :] * sc + 0 * i[:, None]        # east to the left
    eta = -i[:, None] * sc + 0 * i[None, :]       # north up
    ra0, d0 = math.radians(t["ra"]), math.radians(t["dec"])
    rho = np.hypot(xi, eta)
    c = np.arctan(rho)
    with np.errstate(invalid="ignore", divide="ignore"):
        dec = np.arcsin(np.cos(c) * math.sin(d0) + np.where(rho > 0, eta * np.sin(c) * math.cos(d0) / rho, 0))
    ra = ra0 + np.arctan2(xi * np.sin(c), rho * math.cos(d0) * np.cos(c) - eta * math.sin(d0) * np.sin(c))
    return np.degrees(ra) % 360, np.degrees(dec)


def ang_sep_deg(ra, dec, ra0, dec0):
    a, b, c, d = map(np.radians, (ra, dec, ra0, dec0))
    h = np.sin((b - d) / 2) ** 2 + np.cos(b) * np.cos(d) * np.sin((a - c) / 2) ** 2
    return np.degrees(2 * np.arcsin(np.sqrt(h)))


def bprp_rgb(x):  # false-colour ramp for mean BP-RP: <=0.3 blue-white, 1.0 yellow-white, >=2.0 orange-red
    stops = [(0.3, (150, 175, 255)), (0.8, (235, 235, 255)), (1.2, (255, 225, 160)), (2.0, (255, 120, 60))]
    xs = [s[0] for s in stops]
    out = np.stack([np.interp(x, xs, [s[1][k] for s in stops]) for k in range(3)], -1)
    return out / 255.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target", choices=TARGETS)
    ap.add_argument("--level", type=int, default=12)
    ap.add_argument("--colour", action="store_true")
    ap.add_argument("--check", action="store_true", help="verify ang2pix_nested against Gaia's own index (small TAP query)")
    args = ap.parse_args()
    t, L = TARGETS[args.target], args.level
    nside = 2 ** L
    csvp = CACHE / "gaia" / f"gaia-hp{L}-{args.target}.csv"
    csvp.parent.mkdir(parents=True, exist_ok=True)
    if args.check:
        q = (f"SELECT TOP 2000 ra, dec, GAIA_HEALPIX_INDEX({L}, source_id) AS hp FROM gaiadr3.gaia_source "
             f"WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{t['ra']},{t['dec']},{t['radius']}))")
        rows = list(csv.DictReader(io.StringIO(http(f"{TAP}/sync", dict(REQUEST="doQuery", LANG="ADQL", FORMAT="csv", QUERY=q)).read().decode())))
        mine = ang2pix_nested(nside, np.array([float(r["ra"]) for r in rows]), np.array([float(r["dec"]) for r in rows]))
        ok = int((mine == np.array([int(r["hp"]) for r in rows])).sum())
        print(f"ang2pix_nested agrees with GAIA_HEALPIX_INDEX for {ok}/{len(rows)} sources")
        return 0 if ok == len(rows) else 1
    if not csvp.exists() or csvp.stat().st_size == 0:
        run_async(adql(t, L), csvp)
    rows = list(csv.DictReader(open(csvp)))
    hp = np.array([int(r["hp"]) for r in rows], dtype=np.int64)
    n = np.array([int(r["n"]) for r in rows], dtype=np.float64)
    bp = np.array([float(r["bprp"]) if r["bprp"] not in ("", "null", "NaN") else np.nan for r in rows])
    order = np.argsort(hp)
    hp, n, bp = hp[order], n[order], bp[order]
    ra, dec = tan_grid(t)
    cell = ang2pix_nested(nside, ra.ravel(), dec.ravel())
    idx = np.clip(np.searchsorted(hp, cell), 0, len(hp) - 1)
    hit = hp[idx] == cell
    cell_area_arcmin2 = (4 * math.pi / (12 * 4 ** L)) * (180 / math.pi * 60) ** 2
    dens = np.where(hit, n[idx], 0.0).reshape(ra.shape) / cell_area_arcmin2
    inside = ang_sep_deg(ra, dec, t["ra"], t["dec"]) <= t["radius"]
    nz = dens[inside & (dens > 0)]
    d_ref, d_max = float(np.percentile(nz, 5)), float(np.percentile(nz, 99.9))
    v = np.clip(np.log10(1 + dens / d_ref) / math.log10(1 + d_max / d_ref), 0, 1) * inside
    out = CACHE / f"gaia-density-{args.target}.png"
    Image.fromarray((v * 255 + 0.5).astype(np.uint8), "L").save(out)
    stats = dict(target=args.target, healpixLevel=L, cellAreaArcmin2=cell_area_arcmin2, npx=t["npx"], pixelScaleArcmin=t["scale"],
                 fovArcmin=t["npx"] * t["scale"], centreRaDeg=t["ra"], centreDecDeg=t["dec"], queryRadiusDeg=t["radius"],
                 cellsReturned=len(hp), sourcesCounted=int(n.sum()), dRefPerArcmin2=d_ref, dMaxPerArcmin2=d_max,
                 densityMaxPerArcmin2=float(dens[inside].max()), sourcesInCircleCheckedAgainstTAP=None)
    (CACHE / f"gaia-density-{args.target}.json").write_text(json.dumps(stats, indent=1))
    print(json.dumps(stats, indent=1))
    if args.colour:
        col = np.full(dens.shape, np.nan)
        col.ravel()[:] = np.where(hit, bp[idx], np.nan)
        rgb = bprp_rgb(np.nan_to_num(col, nan=1.0)) * v[..., None]
        Image.fromarray((rgb * 255 + 0.5).astype(np.uint8), "RGB").save(CACHE / f"gaia-density-{args.target}-colour.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
