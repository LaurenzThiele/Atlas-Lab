"""Download the raw data for "Why almost nobody lives in most of Egypt".

What it does: I download the GHSL population grid GHS-POP (release R2023A, epoch 2025, 100 m
cells in World Mollweide) for the four tiles that cover Egypt, plus three Natural Earth 1:10m
layers: the country borders, which I need to cut Egypt out of the grid, and the rivers and
lakes, which draw the Nile, Lake Nasser and the delta lakes under the dots. I unzip every file
and change nothing else.
Reads:  nothing (network only).
Writes: data/raw/GHS_POP_E2025_GLOBE_R2023A_54009_100_V1_0_<tile>/ (one GeoTIFF per tile),
        data/raw/ne_10m_admin_0_countries/, data/raw/ne_10m_rivers_lake_centerlines/,
        data/raw/ne_10m_lakes/ (each with its zip next to it),
        data/raw/sources.json (source, download date, size and SHA-256).
Run:    uv run data/download.py   (from the piece folder; about 46 MB, no sign-up, no API key)

What you learn: how a global raster is cut into tiles, and why I pick the equal-area version.
GHSL publishes the whole world as one 4.9 GB zip, or as tiles of 1,000 x 1,000 km (10,000 x
10,000 cells of 100 m). The tiles are named R<row>_C<col>, counted from the top-left corner of
the Mollweide grid at x = -18,041,000 m, y = 9,000,000 m. Egypt's border spans x 2.26 to
3.53 million m and y 2.69 to 3.84 million m in Mollweide, so it falls in rows 6 to 7 and
columns 21 to 22: four tiles, about 36 MB instead of 4.9 GB. I take the Mollweide grid
(ESRI:54009) instead of the lon/lat one because Mollweide is equal-area: every cell is exactly
100 x 100 m = 0.01 km2, so "share of the land" is a simple count of cells.

A file that already exists is skipped. Delete it to download it again.
"""

import hashlib
import json
import zipfile
from datetime import date
from pathlib import Path

import requests

HERE = Path(__file__).parent
RAW_DIR = HERE / "raw"
USER_AGENT = "AtlasLab/1.0"
TIMEOUT_S = 120
CHUNK_BYTES = 1024 * 1024

GHS_PAGE = "https://human-settlement.emergency.copernicus.eu/download.php"
GHS_URL = (
    "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_R2023A/"
    "GHS_POP_E2025_GLOBE_R2023A_54009_100/V1-0/tiles"
)
GHS_STEM = "GHS_POP_E2025_GLOBE_R2023A_54009_100_V1_0"
GHS_TILES = ["R6_C21", "R6_C22", "R7_C21", "R7_C22"]  # the four tiles under Egypt (see above)
GHS_LICENCE_NOTE = (
    "GHSL copyright notice: 'Any copyright and/or sui generis right on the dataset is licensed "
    "under the Creative Commons Attribution 4.0 International (CC BY 4.0) licence. Reuse is "
    "allowed provided appropriate credit is given and any changes are indicated.'"
)
NE_URL = "https://naciscdn.org/naturalearth/10m"
NE_LICENCE_NOTE = (
    "'All versions of Natural Earth raster + vector map data found on this website are in the "
    "public domain. You may use the maps in any manner, including modifying the content and "
    "design, electronic dissemination, and offset printing.'"
)
NE_LAYERS = [
    ("cultural", "ne_10m_admin_0_countries", "admin 0 countries (v5.1)", "country polygons"),
    ("physical", "ne_10m_rivers_lake_centerlines", "rivers and lake centerlines", "river lines"),
    ("physical", "ne_10m_lakes", "lakes", "lake polygons"),
]

SOURCES = [
    {
        "name": f"GHS-POP R2023A, epoch 2025, 100 m, tile {tile}",
        "publisher": "European Commission, Joint Research Centre (GHSL)",
        "url": f"{GHS_URL}/{GHS_STEM}_{tile}.zip",
        "file": f"{GHS_STEM}_{tile}.zip",
        "format": "Zipped GeoTIFF, people per 100 m cell, World Mollweide (ESRI:54009)",
        "licence": "CC BY 4.0",
        "licence_url": "https://creativecommons.org/licenses/by/4.0/",
        "credit": "GHS-POP R2023A, Schiavina et al. 2023, European Commission JRC, "
        "doi:10.2905/2FF68A52-5B5B-4A22-8F40-C41DA8332CFE",
        "share_derived": True,
        "share_note": GHS_LICENCE_NOTE,
    }
    for tile in GHS_TILES
] + [
    {
        "name": f"Natural Earth 1:10m {title}",
        "publisher": "Natural Earth",
        "url": f"{NE_URL}/{theme}/{stem}.zip",
        "file": f"{stem}.zip",
        "format": f"Zipped Shapefile, {what}, WGS84",
        "licence": "Public domain (Natural Earth terms of use)",
        "licence_url": "https://www.naturalearthdata.com/about/terms-of-use/",
        "credit": "Natural Earth",
        "share_derived": True,
        "share_note": NE_LICENCE_NOTE,
    }
    for theme, stem, title, what in NE_LAYERS
]


def download(session: requests.Session, url: str, target: Path) -> None:
    """Stream to a .part file and rename at the end, so a broken run never looks finished."""
    part = target.with_name(target.name + ".part")
    with session.get(url, stream=True, timeout=TIMEOUT_S) as response:
        response.raise_for_status()
        with part.open("wb") as f:
            for chunk in response.iter_content(CHUNK_BYTES):
                f.write(chunk)
    part.rename(target)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(CHUNK_BYTES), b""):
            h.update(chunk)
    return h.hexdigest()


def unzip(archive: Path) -> Path:
    """Unzip into a folder named after the zip. Unzipping is the only processing I do here."""
    folder = archive.with_suffix("")
    if not folder.exists():
        with zipfile.ZipFile(archive) as z:
            z.extractall(folder)
    return folder


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
            download(session, src["url"], target)
        size_bytes = target.stat().st_size
        if size_bytes == 0:
            raise ValueError(f"{target} is empty: delete it and run again")
        # A zip that does not open is a broken download. testzip() reads every member and
        # returns the first one with a bad checksum, so I catch it here, not in key_figures.py.
        with zipfile.ZipFile(target) as z:
            if (bad := z.testzip()) is not None:
                raise ValueError(f"{target} is corrupt ({bad}): delete it and run again")
        print(f"unzip  {src['file']} -> {unzip(target).name}/")
        records.append(
            {
                **src,
                "page": GHS_PAGE if "GHS_POP" in src["file"] else "",
                "downloaded": date.fromtimestamp(target.stat().st_mtime).isoformat(),
                "size_bytes": size_bytes,
                "sha256": sha256(target),
            }
        )
    (RAW_DIR / "sources.json").write_text(json.dumps(records, indent=2, ensure_ascii=False))
    total_mb = sum(r["size_bytes"] for r in records) / 1e6
    print(f"done   {len(records)} files, {total_mb:.0f} MB, list in {RAW_DIR / 'sources.json'}")


if __name__ == "__main__":
    main()
