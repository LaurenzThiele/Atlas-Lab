"""Download the raw data for "How deep the Mariana Trench really is" (DEEP DIVE 01).

What it does: I ask the GMRT GridServer for one GeoTIFF of seabed depth over the southern
Mariana Trench, the box the animation flies through, and save it exactly as GMRT serves it.
Reads:  nothing (network only).
Writes: data/raw/gmrt_mariana_med.tif, data/raw/sources.json (source, download date, size, SHA-256).
Run:    uv run data/download.py   (from the piece folder; about 6.5 MB, no sign-up, no API key)

What you learn: how to cut a box out of a global bathymetry grid with a web service instead of
downloading the whole planet. GMRT (Global Multi-Resolution Topography, Lamont-Doherty Earth
Observatory) merges ship multibeam surveys into one grid, so over a well-surveyed trench it is
far sharper than GEBCO's ~450 m cells. "resolution=med" gives about 245 m between grid nodes
here: enough for the 3D dive, and small enough to load in a browser.

A file that already exists is skipped. Delete it to download it again.
"""

import hashlib
import json
from datetime import date
from pathlib import Path

import requests

HERE = Path(__file__).parent
RAW_DIR = HERE / "raw"
USER_AGENT = "AtlasLab/1.0"
TIMEOUT_S = 120
CHUNK_BYTES = 1024 * 1024
MIN_BYTES = 1_000_000  # the box is about 6.5 MB; far less means GMRT sent an error page

# The animation box: the southern Mariana Trench with the Challenger Deep near its centre,
# wide enough for the camera to start at the surface and dive along the trench axis.
BBOX = {"west": 140.6, "east": 143.8, "south": 10.2, "north": 12.6}
GRIDSERVER_URL = "https://www.gmrt.org/services/GridServer"

GMRT_LICENCE = "Creative Commons Attribution 4.0 International (CC BY 4.0)"
GMRT_LICENCE_URL = "https://www.gmrt.org/about/terms_of_use.php"
GMRT_CREDIT = (
    "Ryan, W.B.F. et al. (2009), Global Multi-Resolution Topography (GMRT) synthesis data set, "
    "Geochem. Geophys. Geosyst., 10, Q03014, doi:10.1029/2008GC002332. Data doi:10.1594/IEDA.100001"
)

SOURCES = [
    {
        "name": "GMRT Global Multi-Resolution Topography: southern Mariana Trench, medium resolution",
        "publisher": "Lamont-Doherty Earth Observatory, Columbia University (GMRT)",
        "url": GRIDSERVER_URL,
        "params": {**BBOX, "layer": "topo", "format": "geotiff", "resolution": "med"},
        "file": "gmrt_mariana_med.tif",
        "format": "GeoTIFF, float32 elevation in metres (negative below sea level), EPSG:4326",
        "licence": GMRT_LICENCE,
        "licence_url": GMRT_LICENCE_URL,
        "credit": GMRT_CREDIT,
        "share_derived": True,
        "share_note": (
            '"This web site and its downloadable products are designed for both public and '
            "academic use, and are licensed under a Creative Commons Attribution 4.0 "
            'International (CC BY 4.0) License."'
        ),
    },
]


def download(session: requests.Session, src: dict, target: Path) -> None:
    """Stream to a .part file, so a broken run never leaves a file that looks finished."""
    part = target.with_name(target.name + ".part")
    with session.get(src["url"], params=src["params"], stream=True, timeout=TIMEOUT_S) as r:
        r.raise_for_status()
        with part.open("wb") as f:
            for chunk in r.iter_content(CHUNK_BYTES):
                f.write(chunk)
    with part.open("rb") as f:
        magic = f.read(4)
    # A GeoTIFF starts with II*\0 (little-endian) or MM\0* (big-endian); anything else is an error page.
    if magic not in (b"II*\x00", b"MM\x00*") or part.stat().st_size < MIN_BYTES:
        part.unlink()
        raise ValueError(
            f"GMRT did not send a GeoTIFF for {src['file']}: check the box and try again"
        )
    part.rename(target)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(CHUNK_BYTES), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    records = []
    for src in SOURCES:
        target = RAW_DIR / src["file"]
        if target.exists():
            print(f"skip   {src['file']} (already there)")
        else:
            print(f"get    {src['file']} ...")
            download(session, src, target)
        records.append(
            {
                **src,
                "downloaded": date.fromtimestamp(target.stat().st_mtime).isoformat(),
                "size_bytes": target.stat().st_size,
                "sha256": sha256(target),
            }
        )
    (RAW_DIR / "sources.json").write_text(json.dumps(records, indent=2, ensure_ascii=False))
    total_mb = sum(r["size_bytes"] for r in records) / 1e6
    print(f"done   {len(records)} file, {total_mb:.1f} MB, list in {RAW_DIR / 'sources.json'}")


if __name__ == "__main__":
    main()
