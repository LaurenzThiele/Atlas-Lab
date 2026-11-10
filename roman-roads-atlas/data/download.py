"""Download the raw data for "Every Roman road, as an old atlas plate".

What it does: I download the Itiner-e road network (every known road of the Roman Empire,
static 2024 version) from Zenodo, plus three Natural Earth layers for the base map: land,
lakes and rivers. I unzip the Natural Earth files and change nothing else.
Reads:  nothing (network only).
Writes: data/raw/itinere_roads.gpkg, data/raw/ne_10m_land/, data/raw/ne_10m_lakes/,
        data/raw/ne_10m_rivers_lake_centerlines/ (each with its zip next to it),
        data/raw/sources.json (source, download date, size and SHA-256).
Run:    uv run data/download.py   (from the piece folder; about 41 MB, no sign-up, no API key)

What you learn: why I pin a research dataset to a fixed version. Itiner-e also has a live
version at https://itiner-e.org that grows as researchers add roads, so any total I compute
from it would drift. The Zenodo record (DOI 10.5281/zenodo.17122148) is the frozen 2024
version described in de Soto et al. 2025, Scientific Data, so my numbers can be checked
against the paper. Zenodo serves the same roads as GeoJSON, Shapefile and GeoPackage. I take
the GeoPackage: one file, a third of the size of the GeoJSON, with the CRS stored inside.

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

ZENODO_RECORD = "https://zenodo.org/records/17122148"
ITINERE_URL = "https://zenodo.org/api/records/17122148/files/itinere_roads.gpkg/content"
ITINERE_MD5 = "3e2d318978e42dd551301f739e0d9a16"  # the checksum Zenodo lists for this file
NE_URL = "https://naciscdn.org/naturalearth/10m/physical"
NE_LICENCE = "Public domain (Natural Earth terms of use)"
NE_LICENCE_URL = "https://www.naturalearthdata.com/about/terms-of-use/"
NE_CREDIT = "Natural Earth"
# Whether files made from a source may be shared on their own (tracked in the repo, offered as a
# download), not only inside the finished map. Natural Earth is in the public domain, so its
# derived layers may be passed on freely.
NE_SHARE_NOTE = (
    "All versions of Natural Earth raster + vector map data found on this website are in the "
    "public domain."
)

SOURCES = [
    {
        "name": "Itiner-e: Roads of the Roman Empire, static version 2024 (v1.3)",
        "publisher": "de Soto, Pažout, Brughmans et al. (Aarhus University, UAB), via Zenodo",
        "url": ITINERE_URL,
        "file": "itinere_roads.gpkg",
        "format": "GeoPackage, road segments as lines",
        "licence": "CC BY 4.0",
        "licence_url": "https://creativecommons.org/licenses/by/4.0/",
        "credit": "Itiner-e, de Soto et al. 2025, Scientific Data, doi:10.1038/s41597-025-06140-z",
        # CC BY 4.0 lets anyone share and adapt the data, including files made from it, as long
        # as the credit goes with them. So my derived road layers may be shared, and I keep the
        # credit next to them in the README and in the map's Sources.
        "share_derived": True,
        "share_note": "You are free to: Share - copy and redistribute the material in any medium "
        "or format for any purpose, even commercially. Adapt - remix, transform, and build upon "
        "the material for any purpose, even commercially. Under the following terms: Attribution.",
    },
    {
        "name": "Natural Earth 1:10m land",
        "publisher": "Natural Earth",
        "url": f"{NE_URL}/ne_10m_land.zip",
        "file": "ne_10m_land.zip",
        "format": "Zipped Shapefile, polygons, WGS84",
        "licence": NE_LICENCE,
        "licence_url": NE_LICENCE_URL,
        "credit": NE_CREDIT,
        "share_derived": True,
        "share_note": NE_SHARE_NOTE,
    },
    {
        "name": "Natural Earth 1:10m lakes",
        "publisher": "Natural Earth",
        "url": f"{NE_URL}/ne_10m_lakes.zip",
        "file": "ne_10m_lakes.zip",
        "format": "Zipped Shapefile, polygons, WGS84",
        "licence": NE_LICENCE,
        "licence_url": NE_LICENCE_URL,
        "credit": NE_CREDIT,
        "share_derived": True,
        "share_note": NE_SHARE_NOTE,
    },
    {
        "name": "Natural Earth 1:10m rivers and lake centerlines",
        "publisher": "Natural Earth",
        "url": f"{NE_URL}/ne_10m_rivers_lake_centerlines.zip",
        "file": "ne_10m_rivers_lake_centerlines.zip",
        "format": "Zipped Shapefile, lines, WGS84",
        "licence": NE_LICENCE,
        "licence_url": NE_LICENCE_URL,
        "credit": NE_CREDIT,
        "share_derived": True,
        "share_note": NE_SHARE_NOTE,
    },
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


def file_hash(path: Path, algorithm: str) -> str:
    h = hashlib.new(algorithm)
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
        # Zenodo publishes an MD5 for every file. If mine differs, the download is broken or
        # the record changed, and every figure after this would be built on the wrong data.
        if src["file"] == "itinere_roads.gpkg" and file_hash(target, "md5") != ITINERE_MD5:
            raise ValueError(f"{target} does not match the Zenodo checksum: delete and rerun")
        if target.suffix == ".zip":
            print(f"unzip  {src['file']} -> {unzip(target).name}/")
        records.append(
            {
                **src,
                "record": ZENODO_RECORD if "zenodo" in src["url"] else "",
                "downloaded": date.fromtimestamp(target.stat().st_mtime).isoformat(),
                "size_bytes": size_bytes,
                "sha256": file_hash(target, "sha256"),
            }
        )
    (RAW_DIR / "sources.json").write_text(json.dumps(records, indent=2, ensure_ascii=False))
    total_mb = sum(r["size_bytes"] for r in records) / 1e6
    print(f"done   {len(records)} files, {total_mb:.0f} MB, list in {RAW_DIR / 'sources.json'}")


if __name__ == "__main__":
    main()
