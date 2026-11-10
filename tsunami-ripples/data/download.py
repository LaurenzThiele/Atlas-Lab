"""Download the raw data for "Every tsunami on record, as ripples".

What it does: I download every tsunami runup in the NOAA NCEI Global Historical Tsunami
Database (a runup is one place where a tsunami was seen or measured on the coast), plus the
database's own table of region codes. I save both exactly as the database serves them. I also
download the Natural Earth land polygons, so the globe can show where the land is.
Reads:  nothing (network only).
Writes: data/raw/ncei_tsunami_runups.json, data/raw/ncei_tsunami_regions.json,
        data/raw/ne_50m_land.geojson, data/raw/sources.json (source, download date, size and SHA-256).
Run:    uv run data/download.py   (from the piece folder; about 20 MB, no sign-up, no API key)

What you learn: how to save a live database as a fixed snapshot. The runup search page at
https://www.ngdc.noaa.gov/hazel/view/hazards/tsunami/runup-search builds its TSV export in the
browser from a public JSON API, 200 rows per page. I call that same API page by page and join
the pages into one file, so my snapshot holds exactly the rows and columns the export holds.
NCEI adds new runups after every tsunami, so the date and SHA-256 in sources.json tell you
which version of the database my numbers come from.

A file that already exists is skipped. Delete it to download it again.
"""

import hashlib
import json
import time
from datetime import date
from pathlib import Path

import requests

HERE = Path(__file__).parent
RAW_DIR = HERE / "raw"
USER_AGENT = "AtlasLab/1.0"
TIMEOUT_S = 60
CHUNK_BYTES = 1024 * 1024
RETRIES = 4  # 176 calls in a row: one dropped connection should not cost the whole run

API_URL = "https://www.ngdc.noaa.gov/hazel/hazard-service/api/v1"
RUNUPS_URL = f"{API_URL}/tsunamis/runups"
REGIONS_URL = f"{API_URL}/descriptors/tsunami/regions"
ITEMS_PER_PAGE = 200  # the API refuses anything above 200 rows per page
MIN_RUNUPS = 30_000  # the database held 35,136 runups in Nov 2026; far fewer means a bad pull

NCEI_DOI = "https://doi.org/10.7289/V5PN93H7"
NCEI_LICENCE = "US government work, public domain (no restrictions on use)"
NCEI_LICENCE_URL = NCEI_DOI  # the DOI resolves to the NCEI metadata record with use constraints
NCEI_CREDIT = (
    "NOAA National Centers for Environmental Information (NCEI), Global Historical Tsunami "
    "Database, doi:10.7289/V5PN93H7"
)
# share_derived says whether anyone may pass on the data, or files made from it, as files of their
# own. I only track a layer in the repo, or offer it under "Download the data", if every source
# behind it says True. A work of the US government has no copyright (17 U.S.C. 105), and the NCEI
# metadata record puts no limit on use, so the NCEI layers may be shared as files.
NCEI_SHARE_NOTE = (
    "US government work (17 U.S.C. 105). NCEI metadata, legal constraints: "
    '"Access to this dataset is unrestricted."'
)
NE_SHARE_NOTE = (
    '"All versions of Natural Earth raster + vector map data found on this website are in the '
    "public domain. You may use the maps in any manner, including modifying the content and "
    'design, electronic dissemination, and offset printing."'
)

# Natural Earth land, 1:50 million. I tried 1:10 million too: it is six times the size and on my
# closest views it barely changes the picture, because the land is only there for orientation.
LAND_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
    "ne_50m_land.geojson"
)
MIN_LAND_FEATURES = 1_000  # it held 1,420 polygons in Nov 2026; far fewer means a bad file

SOURCES = [
    {
        "name": "NCEI Global Historical Tsunami Database: all runups",
        "publisher": "NOAA National Centers for Environmental Information (NCEI)",
        "url": RUNUPS_URL,
        "file": "ncei_tsunami_runups.json",
        "format": "JSON (API pages joined into one list), lon/lat WGS84, heights in metres",
        "licence": NCEI_LICENCE,
        "licence_url": NCEI_LICENCE_URL,
        "credit": NCEI_CREDIT,
        "share_derived": True,
        "share_note": NCEI_SHARE_NOTE,
    },
    {
        "name": "NCEI Global Historical Tsunami Database: region codes",
        "publisher": "NOAA National Centers for Environmental Information (NCEI)",
        "url": REGIONS_URL,
        "file": "ncei_tsunami_regions.json",
        "format": "JSON lookup table (regionCode -> region name)",
        "licence": NCEI_LICENCE,
        "licence_url": NCEI_LICENCE_URL,
        "credit": NCEI_CREDIT,
        "share_derived": True,
        "share_note": NCEI_SHARE_NOTE,
    },
    {
        "name": "Natural Earth 1:50m land",
        "publisher": "Natural Earth (NACIS)",
        "url": LAND_URL,
        "file": "ne_50m_land.geojson",
        "format": "GeoJSON polygons, lon/lat WGS84",
        "licence": "Public domain",
        "licence_url": "https://www.naturalearthdata.com/about/terms-of-use/",
        "credit": "Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com",
        "share_derived": True,
        "share_note": NE_SHARE_NOTE,
    },
]


def get_json(session: requests.Session, url: str, params: dict | None = None) -> dict:
    """One API call, retried with a growing pause if the connection drops.

    I only retry network failures. An error page from the server (raise_for_status) stops the
    script at once, because asking again will not fix a bad request.
    """
    for attempt in range(1, RETRIES + 1):
        try:
            response = session.get(url, params=params, timeout=TIMEOUT_S)
        except (requests.ConnectionError, requests.Timeout) as err:
            if attempt == RETRIES:
                raise
            print(f"       retry {attempt}/{RETRIES - 1} after {type(err).__name__}")
            time.sleep(2**attempt)
            continue
        response.raise_for_status()
        return response.json()
    raise RuntimeError("unreachable")


def fetch_all_pages(session: requests.Session, url: str) -> list[dict]:
    """Walk the API page by page. The first page tells me how many pages and rows there are."""
    first = get_json(session, url, {"page": 1, "itemsPerPage": ITEMS_PER_PAGE})
    total_pages, total_items = first["totalPages"], first["totalItems"]
    items = list(first["items"])
    for page in range(2, total_pages + 1):
        if page % 25 == 0:
            print(f"       page {page}/{total_pages}")
        items.extend(
            get_json(session, url, {"page": page, "itemsPerPage": ITEMS_PER_PAGE})["items"]
        )
    # If a row was added or removed while I was paging, the count no longer matches.
    if len(items) != total_items:
        raise ValueError(f"got {len(items)} rows, the API says {total_items}: run again")
    return items


def save_json(items: list[dict], target: Path) -> None:
    """Write through a .part file, so a broken run never leaves a file that looks finished."""
    part = target.with_name(target.name + ".part")
    part.write_text(json.dumps(items, ensure_ascii=False))
    part.rename(target)


def download_file(session: requests.Session, url: str, target: Path) -> None:
    """Stream to disk through a .part file, for a plain file rather than an API."""
    part = target.with_name(target.name + ".part")
    with session.get(url, stream=True, timeout=TIMEOUT_S) as response:
        response.raise_for_status()
        with part.open("wb") as f:
            for chunk in response.iter_content(CHUNK_BYTES):
                f.write(chunk)
    part.rename(target)


def count_rows(path: Path) -> int:
    """Rows of a JSON list, or features of a GeoJSON file."""
    content = json.loads(path.read_text())
    return len(content["features"]) if isinstance(content, dict) else len(content)


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
            if src["url"] == LAND_URL:
                download_file(session, src["url"], target)
                if count_rows(target) < MIN_LAND_FEATURES:
                    raise ValueError(f"{target} has too few polygons: delete it and run again")
            else:
                items = fetch_all_pages(session, src["url"])
                if src["url"] == RUNUPS_URL and len(items) < MIN_RUNUPS:
                    raise ValueError(f"only {len(items)} runups, expected at least {MIN_RUNUPS}")
                save_json(items, target)
        size_bytes = target.stat().st_size
        if size_bytes == 0:
            raise ValueError(f"{target} is empty: delete it and run again")
        records.append(
            {
                **src,
                **({} if src["url"] == LAND_URL else {"doi": NCEI_DOI}),
                "downloaded": date.fromtimestamp(target.stat().st_mtime).isoformat(),
                "rows": count_rows(target),
                "size_bytes": size_bytes,
                "sha256": sha256(target),
            }
        )
    (RAW_DIR / "sources.json").write_text(json.dumps(records, indent=2, ensure_ascii=False))
    total_mb = sum(r["size_bytes"] for r in records) / 1e6
    print(f"done   {len(records)} files, {total_mb:.0f} MB, list in {RAW_DIR / 'sources.json'}")


if __name__ == "__main__":
    main()
