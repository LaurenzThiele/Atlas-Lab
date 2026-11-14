"""Download the raw data for "Where Norway's power comes from" (ON THE LAND 01).

What it does: I fetch the three layers the reel stacks on top of each other, exactly as the
publishers serve them:
  - Copernicus DEM GLO-90 (about 90 m) for every 1 x 1 degree tile that touches mainland Norway.
    This is the relief that rises first. At the scale of a whole country on a phone screen,
    90 m is already far finer than one pixel, and it is a ninth of the size of GLO-30.
  - Global Power Plant Database v1.3.0 (WRI): one row per power plant with its fuel, capacity
    and location. These are the plants that light up, sized by capacity.
  - OpenStreetMap power lines of 100 kV and more inside Norway, queried from the Overpass API.
    These are the high-voltage lines that draw outward from the plants.
  - OpenStreetMap places tagged as cities inside Norway, for the labels the lines run to.
  - Natural Earth 1:10m countries: Norway's mainland outline, to cut lines that cross into Sweden,
    Finland or Russia at the border and to keep the relief to the mainland.
Reads:  nothing (network only).
Writes: data/raw/copernicus_dem_90/*.tif,
        data/raw/global_power_plant_database_v_1_3.zip (unzipped next to it),
        data/raw/osm_power_lines_norway_100kv.json, data/raw/osm_cities_norway.json,
        data/raw/ne_10m_admin_0_countries.zip,
        data/raw/sources.json (source, download date, size, SHA-256).
Run:    uv run data/download.py   (from the piece folder; about 250 MB, no sign-up, no API key)

What you learn: you can ask OpenStreetMap for one kind of feature in one country instead of
downloading the whole country extract (1.4 GB for Norway). The Overpass query below is the
filter: power=line, a voltage of 100,000 V or more, inside Norway's boundary. The answer is the
same ODbL data that Geofabrik packs into its daily extracts, only a few percent of the size.

A file that already exists is skipped. Delete it to download it again.
"""

import hashlib
import json
import time
import zipfile
from datetime import date
from pathlib import Path

import requests

HERE = Path(__file__).parent
RAW_DIR = HERE / "raw"
USER_AGENT = "AtlasLab/1.0"
TIMEOUT_S = 300
CONNECT_TIMEOUT_S = 30
CHUNK_BYTES = 1024 * 1024

# Mainland Norway spans about 58.0 to 71.2 N and 4.6 to 31.1 E. I list, for each row of
# 1 x 1 degree tiles (named after their south-west corner), the columns that touch the mainland
# border (Natural Earth 1:10m), so no tile of pure Sweden, Finland or open sea is fetched.
# Svalbard and Jan Mayen are left out: the reel is the mainland grid.
DEM90_TILES = {
    57: [6, 7],
    58: [5, 6, 7, 8, 9, 10, 11],
    59: [5, 6, 7, 8, 9, 10, 11, 12],
    60: [4, 5, 6, 7, 8, 9, 10, 11, 12],
    61: [4, 5, 6, 7, 8, 9, 10, 11, 12],
    62: [4, 5, 6, 7, 8, 9, 10, 11, 12],
    63: [7, 8, 9, 10, 11, 12],
    64: [9, 10, 11, 12, 13, 14],
    65: [11, 12, 13, 14],
    66: [12, 13, 14, 15, 16],
    67: [12, 13, 14, 15, 16, 17],
    68: [12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25],
    69: list(range(15, 31)),
    70: list(range(18, 32)),
    71: list(range(23, 29)),
}
DEM90_BASE_URL = "https://copernicus-dem-90m.s3.amazonaws.com"

# The AWS registry page for this bucket points to the Copernicus DEM licence: GLO-90 is free for
# the general public, commercial use included, as long as the notice is shown.
COPDEM_LICENCE = "Copernicus DEM licence (GLO-30 Public and GLO-90): free for any use, with notice"
COPDEM_LICENCE_URL = (
    "https://dataspace.copernicus.eu/explore-data/data-collections/"
    "copernicus-contributing-missions/collections-description/COP-DEM"
)
COPDEM_CREDIT = (
    "Produced using Copernicus WorldDEM-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space "
    "GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved"
)
COPDEM_SHARE_NOTE = (
    '"The GLO-30 and GLO-90 datasets are available worldwide with a free license." and '
    '"When communicating to the General Public or distributing the Copernicus WorldDEM-30 '
    "(GLO-30), the User shall inform the General Public of the source by using the following "
    'notice" (Copernicus Data Space, COP-DEM, User Obligations)'
)

# WRI's own stable link to the v1.3.0 zip (the one the database's README and the WRI dataset
# page point to). The database is no longer updated: v1.3.0 from June 2021 is the last release.
GPPD_URL = (
    "https://wri-dataportal-prod.s3.amazonaws.com/manual/global_power_plant_database_v_1_3.zip"
)
GPPD_FILE = "global_power_plant_database_v_1_3.zip"

# Overpass is a read-only query service on top of the live OpenStreetMap database. I try the
# main instance first and a public mirror if it is busy; both serve the same data.
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
OVERPASS_TRIES_PER_URL = 3
OVERPASS_WAIT_S = 20
# ISO3166-1 = NO picks Norway's national boundary relation. The voltage tag holds volts, and a
# line carrying two circuits lists both ("420000;132000"), so the regex accepts any 6-digit value
# (100,000 V and up) as one item of the list.
AREA_NO = 'area["ISO3166-1"="NO"][admin_level=2]->.no;'
LINES_QUERY = (
    "[out:json][timeout:600];"
    + AREA_NO
    + 'way["power"="line"]["voltage"~"(^|;)[1-9][0-9]{5}(;|$)"](area.no);out geom tags;'
)
CITIES_QUERY = "[out:json][timeout:300];" + AREA_NO + 'node["place"="city"](area.no);out body;'
LINES_FILE = "osm_power_lines_norway_100kv.json"
CITIES_FILE = "osm_cities_norway.json"

NE_URL = "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_0_countries.zip"
NE_FILE = "ne_10m_admin_0_countries.zip"

OSM_LICENCE = "Open Data Commons Open Database License (ODbL) 1.0"
OSM_LICENCE_URL = "https://www.openstreetmap.org/copyright"
OSM_CREDIT = "© OpenStreetMap contributors"
OSM_SHARE_NOTE = (
    '"You are free to copy, distribute, transmit and adapt our data, as long as you credit '
    "OpenStreetMap and its contributors. If you alter or build upon our data, you may distribute "
    'the result only under the same licence." (openstreetmap.org/copyright)'
)


def dem_tile_name(lat: int, lon: int) -> str:
    """Build a Copernicus DEM tile name: 30 arc seconds is GLO-90."""
    return f"Copernicus_DSM_COG_30_N{lat:02d}_00_E{lon:03d}_00_DEM"


DEM_SOURCES = [
    {
        "name": f"Copernicus DEM GLO-90 tile N{lat} E{lon:03d}",
        "publisher": "ESA / Copernicus, served by the AWS Open Data Registry (Sinergise)",
        "url": f"{DEM90_BASE_URL}/{dem_tile_name(lat, lon)}/{dem_tile_name(lat, lon)}.tif",
        "file": f"copernicus_dem_90/{dem_tile_name(lat, lon)}.tif",
        "format": "Cloud-optimised GeoTIFF, EPSG:4326, float32 heights in metres (EGM2008)",
        "licence": COPDEM_LICENCE,
        "licence_url": COPDEM_LICENCE_URL,
        "credit": COPDEM_CREDIT,
        "share_derived": True,
        "share_note": COPDEM_SHARE_NOTE,
    }
    for lat, lons in DEM90_TILES.items()
    for lon in lons
]

SOURCES = DEM_SOURCES + [
    {
        "name": "Global Power Plant Database v1.3.0",
        "publisher": "World Resources Institute (WRI)",
        "url": GPPD_URL,
        "file": GPPD_FILE,
        "format": "CSV (zipped), one row per plant, WGS84 lat/lon, capacity in MW",
        "licence": "Creative Commons Attribution 4.0 International (CC BY 4.0)",
        "licence_url": "https://creativecommons.org/licenses/by/4.0/",
        "credit": (
            "Global Energy Observatory, Google, KTH Royal Institute of Technology in Stockholm, "
            "Enipedia, World Resources Institute. 2021. Global Power Plant Database v1.3.0. "
            "Published on Resource Watch and Google Earth Engine."
        ),
        "share_derived": True,
        "share_note": (
            '"You are free to: Share, copy and redistribute the material in any medium or '
            "format; Adapt, remix, transform, and build upon the material for any purpose, even "
            'commercially." (CC BY 4.0, attribution required)'
        ),
    },
    {
        "name": "Natural Earth 1:10m Cultural Vectors, Admin 0 Countries",
        "publisher": "Natural Earth (NACIS)",
        "url": NE_URL,
        "file": NE_FILE,
        "format": "Shapefile (zipped), polygons, EPSG:4326",
        "licence": "Public domain",
        "licence_url": "https://www.naturalearthdata.com/about/terms-of-use/",
        "credit": "Made with Natural Earth",
        "share_derived": True,
        "share_note": (
            '"All versions of Natural Earth raster + vector map data found on this website are in '
            "the public domain. You may use the maps in any manner, including modifying the "
            'content and design, electronic dissemination, and offset printing."'
        ),
    },
    {
        "name": "OpenStreetMap power lines of 100 kV and more in Norway (Overpass API)",
        "publisher": "OpenStreetMap Foundation and contributors",
        "url": OVERPASS_URLS[0],
        "query": LINES_QUERY,
        "file": LINES_FILE,
        "format": "Overpass JSON, ways with full geometry (WGS84) and tags",
        "licence": OSM_LICENCE,
        "licence_url": OSM_LICENCE_URL,
        "credit": OSM_CREDIT,
        "share_derived": True,
        "share_note": OSM_SHARE_NOTE,
    },
    {
        "name": "OpenStreetMap cities in Norway (Overpass API)",
        "publisher": "OpenStreetMap Foundation and contributors",
        "url": OVERPASS_URLS[0],
        "query": CITIES_QUERY,
        "file": CITIES_FILE,
        "format": "Overpass JSON, nodes (WGS84) with tags",
        "licence": OSM_LICENCE,
        "licence_url": OSM_LICENCE_URL,
        "credit": OSM_CREDIT,
        "share_derived": True,
        "share_note": OSM_SHARE_NOTE,
    },
]


def check_magic(part: Path, target: Path) -> None:
    """A GeoTIFF starts with II*\\0 or MM\\0*, a zip with PK, Overpass JSON with {."""
    with part.open("rb") as f:
        magic = f.read(4)
    if target.suffix == ".zip":
        ok = magic == b"PK\x03\x04"
    elif target.suffix == ".json":
        ok = magic.lstrip()[:1] == b"{"
    else:
        ok = magic in (b"II*\x00", b"MM\x00*")
    if not ok:
        part.unlink()
        raise ValueError(f"{target.name}: the server did not send the expected file type")


def stream(response: requests.Response, part: Path) -> None:
    with part.open("wb") as f:
        for chunk in response.iter_content(CHUNK_BYTES):
            f.write(chunk)


def download(session: requests.Session, url: str, target: Path) -> None:
    """Stream to a .part file, so a broken run never leaves a file that looks finished."""
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + ".part")
    with session.get(url, stream=True, timeout=TIMEOUT_S) as r:
        r.raise_for_status()
        stream(r, part)
    check_magic(part, target)
    part.rename(target)


def overpass(session: requests.Session, query: str, target: Path) -> str:
    """Run one Overpass query. Busy servers answer 429 or 504, so I wait and retry, then move on
    to the mirror. Returns the URL that answered."""
    part = target.with_name(target.name + ".part")
    for url in OVERPASS_URLS:
        for attempt in range(1, OVERPASS_TRIES_PER_URL + 1):
            try:
                with session.post(
                    url, data={"data": query}, stream=True, timeout=(CONNECT_TIMEOUT_S, TIMEOUT_S)
                ) as r:
                    if r.status_code in (429, 502, 503, 504):
                        raise requests.HTTPError(f"{r.status_code} busy")
                    r.raise_for_status()
                    stream(r, part)
                check_magic(part, target)
                # Overpass sends a "remark" instead of an HTTP error when a query times out
                # on the server, so a finished file can still be cut short.
                if "remark" in json.loads(part.read_text(encoding="utf-8")):
                    part.unlink()
                    raise requests.HTTPError("server-side timeout (remark in answer)")
                part.rename(target)
                return url
            except (requests.ConnectionError, requests.Timeout, requests.HTTPError) as e:
                print(f"       {url} try {attempt}: {e}")
                time.sleep(OVERPASS_WAIT_S)
    raise RuntimeError(f"no Overpass server answered for {target.name}")


def unzip(path: Path) -> Path:
    """Unzip into a folder named after the zip (skipped if it is already there)."""
    folder = path.with_suffix("")
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
        record = dict(src)
        if target.exists():
            print(f"skip   {src['file']} (already there)")
        elif "query" in src:
            print(f"query  {src['file']} ...")
            record["url"] = overpass(session, src["query"], target)
        else:
            print(f"get    {src['file']} ...")
            download(session, src["url"], target)
        # Natural Earth is read straight from its zip; only the power plant zip is unpacked.
        if target.name == GPPD_FILE:
            unzip(target)
        records.append(
            {
                **record,
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
