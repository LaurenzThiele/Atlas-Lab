"""Download the raw data for "I built the real Vice City in my browser" (Miami in 3D).

What it does: I fetch three Overture Maps layers for Miami from release 2026-10-21.0:
  - buildings (theme=buildings, type=building) for the building box: Miami Beach, downtown,
    Brickell and the tip of Key Biscayne. Every footprint with its height, floors and sources.
  - land and water (theme=base) for a wider ground box, so the dark ground and the sea reach
    the horizon when the camera tilts up. Only the buildings stop at the building box.
Reads:  nothing (network only).
Writes: data/raw/overture_buildings_miami.parquet,
        data/raw/overture_land_miami_wide.parquet,
        data/raw/overture_water_miami_wide.parquet,
        data/raw/sources.json (source, download date, size, SHA-256).
Run:    uv run data/download.py   (from the piece folder; about 60 MB, no sign-up, no API key)

What you learn: Overture publishes the whole planet as GeoParquet on a public S3 bucket, about
400 GB for all themes. You never download all of it. Every row carries its own bounding box
(a `bbox` struct column), and the files are sorted in space, so the overturemaps library reads
only the row groups that touch your box. Three small files come out of a planet-sized dataset
in a few seconds. The same trick works for any city: change the two boxes.

Two quirks worth knowing:
  - Overture keeps only about the last two monthly releases online (roughly 60 days). I pin
    the release so the figures can be checked against it, but once 2026-10-21.0 is gone the
    download fails. Then set RELEASE to a newer one from `overturemaps releases list`; the
    counts will move a little.
  - The bbox filter keeps every feature whose own bounding box touches yours. Land comes as a
    few huge polygons (the coast of a whole continent), so the land file holds far more than
    Miami. The map clips it later; download.py only downloads.

A file that already exists is skipped. Delete it to download it again.
"""

import hashlib
import json
import os
from datetime import date
from pathlib import Path

from overturemaps import core
from overturemaps.writers import copy, get_writer

HERE = Path(__file__).parent
RAW_DIR = HERE / "raw"
USER_AGENT = "AtlasLab/1.0"  # used for the S3 reads below through AWS_SDK_UA_APP_ID
TIMEOUT_S = 300
CONNECT_TIMEOUT_S = 30

RELEASE = "2026-10-21.0"

# xmin, ymin, xmax, ymax in degrees (WGS 84 longitude and latitude, the order Overture uses).
# Building box: Miami Beach in the north-east, downtown and Brickell on the west side of the
# bay, the tip of Key Biscayne in the south.
BUILDING_BBOX = (-80.32, 25.70, -80.11, 25.88)
# Ground box: about 50 km further in every direction, so land and water fill the view up to the
# horizon in a tilted camera. Without it the map ends in a hard edge with black beyond it.
GROUND_BBOX = (-80.80, 25.30, -79.65, 26.30)

OVERTURE_PUBLISHER = "Overture Maps Foundation"
OVERTURE_DOCS_URL = "https://docs.overturemaps.org/getting-data/"
OVERTURE_ATTRIBUTION_URL = "https://docs.overturemaps.org/attribution/"
ODBL = "Open Data Commons Open Database License (ODbL) 1.0"
ODBL_SHARE_NOTE = (
    'Overture: buildings and base themes are "License for theme: ODbL" '
    f'({OVERTURE_ATTRIBUTION_URL}). ODbL 1.0, 4.4a: "Any Derivative Database that You Publicly Use '
    "must be only under the terms of: i. This License; ii. A later version of this License similar in "
    'spirit to this License; or iii. A compatible license." So files made from it may be passed '
    "on, with the credit and under ODbL (share-alike)."
)
# Only the sources that are really in this box (sources.dataset in the buildings file:
# OpenStreetMap, Microsoft ML Buildings and USGS Lidar; base land and water: OpenStreetMap).
CREDIT = (
    "© OpenStreetMap contributors, Overture Maps Foundation, Microsoft Global ML Building "
    "Footprints (ODbL), USGS 3D Elevation Program"
)


def s3_url(theme: str, type_: str) -> str:
    """The public S3 folder of one Overture type in this release (for sources.json)."""
    return f"s3://overturemaps-us-west-2/release/{RELEASE}/theme={theme}/type={type_}/"


SOURCES = [
    {
        "name": "Overture Maps buildings, Miami",
        "publisher": OVERTURE_PUBLISHER,
        "url": s3_url("buildings", "building"),
        "file": "overture_buildings_miami.parquet",
        "format": "GeoParquet, OGC:CRS84 (WGS 84 longitude, latitude), heights in metres",
        "licence": ODBL,
        "licence_url": OVERTURE_ATTRIBUTION_URL,
        "credit": CREDIT,
        "share_derived": True,
        "share_note": ODBL_SHARE_NOTE,
        "overture_type": "building",
        "bbox": BUILDING_BBOX,
    },
    {
        "name": "Overture Maps land, Miami (wide box)",
        "publisher": OVERTURE_PUBLISHER,
        "url": s3_url("base", "land"),
        "file": "overture_land_miami_wide.parquet",
        "format": "GeoParquet, OGC:CRS84 (WGS 84 longitude, latitude)",
        "licence": ODBL,
        "licence_url": OVERTURE_ATTRIBUTION_URL,
        "credit": "© OpenStreetMap contributors, Overture Maps Foundation",
        "share_derived": True,
        "share_note": ODBL_SHARE_NOTE,
        "overture_type": "land",
        "bbox": GROUND_BBOX,
    },
    {
        "name": "Overture Maps water, Miami (wide box)",
        "publisher": OVERTURE_PUBLISHER,
        "url": s3_url("base", "water"),
        "file": "overture_water_miami_wide.parquet",
        "format": "GeoParquet, OGC:CRS84 (WGS 84 longitude, latitude)",
        "licence": ODBL,
        "licence_url": OVERTURE_ATTRIBUTION_URL,
        "credit": "© OpenStreetMap contributors, Overture Maps Foundation",
        "share_derived": True,
        "share_note": ODBL_SHARE_NOTE,
        "overture_type": "water",
        "bbox": GROUND_BBOX,
    },
]


def check_release() -> None:
    """Stop early with a clear message if the pinned release is no longer online."""
    available, latest = core.get_available_releases()
    if RELEASE not in available:
        raise SystemExit(
            f"Release {RELEASE} is no longer online (available: {', '.join(available)}). "
            f"Set RELEASE = '{latest}' at the top of this file and run it again."
        )
    print(f"Overture release {RELEASE} (latest online: {latest})")


def download_overture(overture_type: str, bbox: tuple, target: Path) -> None:
    """Stream one Overture type inside a box to a GeoParquet file, through a .part file."""
    reader = core.record_batch_reader(
        overture_type,
        bbox=bbox,
        release=RELEASE,
        connect_timeout=CONNECT_TIMEOUT_S,
        request_timeout=TIMEOUT_S,
    )
    if reader is None:
        raise RuntimeError(f"No reader for {overture_type} in release {RELEASE}")
    part = target.with_name(target.name + ".part")
    with get_writer("geoparquet", str(part), schema=reader.schema) as writer:
        copy(reader, writer)
    if part.stat().st_size < 10_000:
        raise RuntimeError(f"{part.name} is only {part.stat().st_size} bytes: empty download?")
    part.replace(target)


def sha256(path: Path) -> str:
    """SHA-256 of a file, so a reader can check they have the same bytes as me."""
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_sources_json(entries: list[dict]) -> None:
    """Record every source with its download date, size and checksum."""
    out = RAW_DIR / "sources.json"
    out.write_text(json.dumps(entries, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {out.relative_to(HERE.parent)}")


def main() -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("AWS_SDK_UA_APP_ID", USER_AGENT)
    check_release()

    old = {}
    sources_json = RAW_DIR / "sources.json"
    if sources_json.exists():
        old = {e["file"]: e for e in json.loads(sources_json.read_text(encoding="utf-8"))}

    entries = []
    for source in SOURCES:
        target = RAW_DIR / source["file"]
        fresh = not target.exists()
        if fresh:
            print(f"Downloading {source['name']} ...")
            download_overture(source["overture_type"], source["bbox"], target)
        else:
            print(f"Skip {source['file']} (already there)")
        size_mb = target.stat().st_size / 1e6
        print(f"  {source['file']}: {size_mb:.1f} MB")
        entry = {k: v for k, v in source.items() if k != "overture_type"}
        entry["bbox"] = list(source["bbox"])
        entry["release"] = RELEASE
        previous = old.get(source["file"], {})
        entry["downloaded"] = (
            date.today().isoformat() if fresh else previous.get("downloaded", "unknown")
        )
        entry["bytes"] = target.stat().st_size
        entry["sha256"] = sha256(target)
        entries.append(entry)

    write_sources_json(entries)
    total_mb = sum(e["bytes"] for e in entries) / 1e6
    print(f"Done: {len(entries)} files, {total_mb:.1f} MB in data/raw/")


if __name__ == "__main__":
    main()
