"""Download the raw data for "Switzerland in one line" (ONE LINE 01).

What it does: I fetch the elevation and the reference data the reel needs, exactly as the
publishers serve them:
  - Copernicus DEM GLO-30 (about 30 m) for the five 1 x 1 degree tiles the line and its 15 km
    corridor run through,
    from Basel down to the Italian border at Monte Rosa. This is the profile and the 3D slice.
  - Copernicus DEM GLO-90 (about 90 m) for every tile that touches Switzerland, for the overview
    shot of the whole country. 90 m is plenty at that scale and a ninth of the size.
  - swissBOUNDARIES3D (swisstopo): the official national border, to find exactly where the line
    leaves Switzerland.
  - swissNAMES3D (swisstopo): the official names and heights of peaks, passes, rivers and towns,
    so every label on the line comes from data and the high point can be checked against the
    surveyed summit height.
Reads:  nothing (network only).
Writes: data/raw/copernicus_dem_30/*.tif, data/raw/copernicus_dem_90/*.tif,
        data/raw/swissboundaries3d_2026-01_2056_5728.gpkg.zip (unzipped next to it),
        data/raw/swissnames3d_2026_2056.csv.zip (unzipped next to it),
        data/raw/sources.json (source, download date, size, SHA-256).
Run:    uv run data/download.py   (from the piece folder; about 375 MB, no sign-up, no API key)

What you learn: you rarely need a whole country at full resolution. The line itself gets the
30 m DEM, the wide shot gets the 90 m DEM, and both come as 1 x 1 degree tiles whose names
follow a fixed rule, so I build the URLs instead of listing the bucket.

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

# The line runs from Basel (about 47.56 N, 7.59 E) to Monte Rosa on the Italian border (about
# 45.94 N, 7.87 E). The line never leaves the 7 E column of tiles, but the 15 km corridor east of
# it crosses 8 E in the Alps, so two tiles of the 8 E column join the three.
# Tiles are named after their south-west corner.
DEM30_TILES = [(45, 7), (46, 7), (47, 7), (45, 8), (46, 8)]  # (lat, lon) of the south-west corner

# Switzerland spans about 45.8 to 47.8 N and 5.9 to 10.5 E: 3 x 6 tiles at 90 m.
DEM90_LATS = [45, 46, 47]
DEM90_LONS = [5, 6, 7, 8, 9, 10]

DEM30_BASE_URL = "https://copernicus-dem-30m.s3.amazonaws.com"
DEM90_BASE_URL = "https://copernicus-dem-90m.s3.amazonaws.com"

# The AWS registry page for these buckets points to the Copernicus DEM licence: GLO-30 Public and
# GLO-90 are free for the general public, commercial use included, as long as the notice is shown.
COPDEM_LICENCE = "Copernicus DEM licence (GLO-30 Public and GLO-90): free for any use, with notice"
COPDEM_LICENCE_URL = (
    "https://dataspace.copernicus.eu/explore-data/data-collections/"
    "copernicus-contributing-missions/collections-description/COP-DEM"
)
COPDEM_SHARE_NOTE = (
    '"The GLO-30 and GLO-90 datasets are available worldwide with a free license." and '
    '"When communicating to the General Public or distributing the Copernicus WorldDEM-30 '
    "(GLO-30), the User shall inform the General Public of the source by using the following "
    'notice" (Copernicus Data Space, COP-DEM, User Obligations)'
)


def copdem_credit(product: str) -> str:
    return (
        f"Produced using Copernicus WorldDEM-{product} © DLR e.V. 2010-2014 and © Airbus Defence "
        "and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; "
        "all rights reserved"
    )


# swisstopo's free geodata are Open Government Data: use, share and commercial use allowed,
# with the source named.
SWISSTOPO_LICENCE = "swisstopo terms of use for free geodata (open use, source must be named)"
SWISSTOPO_LICENCE_URL = (
    "https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices"
)
SWISSTOPO_CREDIT = "Federal Office of Topography swisstopo"
SWISSTOPO_SHARE_NOTE = (
    '"The free geodata and geoservices of swisstopo may be used, distributed and made '
    "accessible. Furthermore, they may be enriched and processed and also used commercially. "
    'A reference to the source is mandatory."'
)
SWISSTOPO_BASE_URL = "https://data.geo.admin.ch"
BOUNDARIES_FILE = "swissboundaries3d_2026-01_2056_5728.gpkg.zip"
NAMES_FILE = "swissnames3d_2026_2056.csv.zip"


def dem_tile_name(arcsec: int, lat: int, lon: int) -> str:
    """Build a Copernicus DEM tile name: 10 arc seconds is GLO-30, 30 arc seconds is GLO-90."""
    return f"Copernicus_DSM_COG_{arcsec}_N{lat:02d}_00_E{lon:03d}_00_DEM"


def dem_sources(product: str, arcsec: int, base_url: str, tiles: list) -> list:
    return [
        {
            "name": f"Copernicus DEM GLO-{product} tile N{lat} E{lon:03d}",
            "publisher": "ESA / Copernicus, served by the AWS Open Data Registry (Sinergise)",
            "url": f"{base_url}/{dem_tile_name(arcsec, lat, lon)}/{dem_tile_name(arcsec, lat, lon)}.tif",
            "file": f"copernicus_dem_{product}/{dem_tile_name(arcsec, lat, lon)}.tif",
            "format": "Cloud-optimised GeoTIFF, EPSG:4326, float32 heights in metres (EGM2008)",
            "licence": COPDEM_LICENCE,
            "licence_url": COPDEM_LICENCE_URL,
            "credit": copdem_credit(product),
            "share_derived": True,
            "share_note": COPDEM_SHARE_NOTE,
        }
        for lat, lon in tiles
    ]


SOURCES = (
    dem_sources("30", 10, DEM30_BASE_URL, DEM30_TILES)
    + dem_sources(
        "90", 30, DEM90_BASE_URL, [(lat, lon) for lat in DEM90_LATS for lon in DEM90_LONS]
    )
    + [
        {
            "name": "swissBOUNDARIES3D, release 2026-01 (national, cantonal and municipal borders)",
            "publisher": "Federal Office of Topography swisstopo",
            "url": f"{SWISSTOPO_BASE_URL}/ch.swisstopo.swissboundaries3d/"
            f"swissboundaries3d_2026-01/{BOUNDARIES_FILE}",
            "file": BOUNDARIES_FILE,
            "format": "GeoPackage (zipped), polygons, EPSG:2056 (LV95) with heights",
            "licence": SWISSTOPO_LICENCE,
            "licence_url": SWISSTOPO_LICENCE_URL,
            "credit": SWISSTOPO_CREDIT,
            "share_derived": True,
            "share_note": SWISSTOPO_SHARE_NOTE,
        },
        {
            "name": "swissNAMES3D, release 2026 (place and terrain names, points)",
            "publisher": "Federal Office of Topography swisstopo",
            "url": f"{SWISSTOPO_BASE_URL}/ch.swisstopo.swissnames3d/swissnames3d_2026/{NAMES_FILE}",
            "file": NAMES_FILE,
            "format": "CSV (zipped, semicolon separated), EPSG:2056 (LV95) E, N and height in m",
            "licence": SWISSTOPO_LICENCE,
            "licence_url": SWISSTOPO_LICENCE_URL,
            "credit": SWISSTOPO_CREDIT,
            "share_derived": True,
            "share_note": SWISSTOPO_SHARE_NOTE,
        },
    ]
)


def download(session: requests.Session, url: str, target: Path) -> None:
    """Stream to a .part file, so a broken run never leaves a file that looks finished."""
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + ".part")
    with session.get(url, stream=True, timeout=TIMEOUT_S) as r:
        r.raise_for_status()
        with part.open("wb") as f:
            for chunk in r.iter_content(CHUNK_BYTES):
                f.write(chunk)
    with part.open("rb") as f:
        magic = f.read(4)
    # A GeoTIFF starts with II*\0 or MM\0*, a zip with PK. Anything else is an error page.
    expected = (b"PK\x03\x04",) if target.suffix == ".zip" else (b"II*\x00", b"MM\x00*")
    if magic not in expected:
        part.unlink()
        raise ValueError(f"{url} did not send the expected file type")
    part.rename(target)


def unzip(path: Path) -> Path:
    """Unzip into a folder named after the zip, without .gpkg.zip or .csv.zip (skipped if there)."""
    folder = path.parent / path.name.split(".")[0]
    if not folder.exists():
        with zipfile.ZipFile(path) as z:
            z.extractall(folder)
    return folder


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
            download(session, src["url"], target)
        if target.suffix == ".zip":
            unzip(target)
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
    print(f"done   {len(records)} files, {total_mb:.0f} MB, list in {RAW_DIR / 'sources.json'}")


if __name__ == "__main__":
    main()
