"""Download the raw data for "The rain that drowned Florence".

What it does: I download three free datasets for the Arno basin, the river that flooded Florence
on 4 November 1966:
  - HydroBASINS Europe, level 12: the smallest drainage units, each one knowing which unit it
    drains into. From these I later rebuild the whole area upstream of Florence.
  - HydroRIVERS Europe: every river line, each one knowing the line it flows into.
  - Copernicus DEM GLO-30: 30 m elevation tiles under the whole Arno, for the 3D terrain.
Reads:  nothing (network only).
Writes: data/raw/hybas_eu_lev12_v1c/ (unzipped), data/raw/HydroRIVERS_v10_eu_shp/ (unzipped),
        data/raw/copernicus_dem/*.tif, data/raw/sources.json (source, date, size, SHA-256).
Run:    uv run data/download.py   (from the piece folder; about 500 MB, 930 MB on disk once unzipped, no sign-up, no API key)

What you learn: how to pull a reproducible snapshot of open data. Each file streams to disk
through a ".part" file, so a dropped connection never leaves a half file that looks complete.
sources.json records the date and SHA-256 of every file, so anyone can check that their copy
matches mine. A file that already exists is skipped. Delete it to download it again.
"""

import hashlib
import json
import zipfile
from datetime import date
from pathlib import Path

import requests

HERE = Path(__file__).parent
RAW_DIR = HERE / "raw"
DEM_DIR_NAME = "copernicus_dem"
USER_AGENT = "AtlasLab/1.0"
TIMEOUT_S = 120
CHUNK_BYTES = 1024 * 1024

# The basin upstream of Florence spans roughly 42.9 to 44.1 N and 11.1 to 12.3 E, and the Arno runs
# on west to the sea at about 10.3 E. Copernicus DEM comes in 1 x 1 degree tiles named after their
# south-west corner, so these nine tiles cover the whole river, Pisa and the coast included.
DEM_LATS = [42, 43, 44]
DEM_LONS = [10, 11, 12]
DEM_BASE_URL = "https://copernicus-dem-30m.s3.amazonaws.com"

# HydroSHEDS v1 is not under a Creative Commons licence. It has its own licence agreement
# (Appendix A of the technical documentation): free for commercial and non-commercial use, and
# Exhibit B asks every product built on it to carry the WWF copyright statement below.
HYDROSHEDS_LICENCE = "HydroSHEDS v1 licence agreement: free for commercial and non-commercial use"
HYDROSHEDS_LICENCE_URL = (
    "https://data.hydrosheds.org/file/technical-documentation/HydroSHEDS_TechDoc_v1_4.pdf"
)
HYDROSHEDS_CREDIT = (
    "HydroSHEDS, © World Wildlife Fund, Inc. (2006-2022), used under licence. "
    "Lehner and Grill (2013), https://www.hydrosheds.org"
)
# Using the data in a map is fine, but passing it on as files is not: section 2.1.2 of the licence
# allows distribution only inside a derived product, never on its own. So I keep every layer made
# from HydroSHEDS out of the repo and out of the map's downloads; readers rebuild them instead.
HYDROSHEDS_SHARE_DERIVED = False
HYDROSHEDS_SHARE_NOTE = (
    "Appendix A, 2.1.2: a licence to distribute the Licensed Materials incorporated into any "
    "Derivative Works to End Users; in no event shall Licensee license or distribute the "
    "Licensed Materials as a stand-alone product."
)

# The AWS registry page for this bucket points to the Copernicus licence: GLO-30 Public is free
# for the general public, including commercial use, as long as the notice below is shown.
COPDEM_LICENCE = "Copernicus DEM licence (GLO-30 Public): free for any use, with the notice below"
COPDEM_LICENCE_URL = (
    "https://dataspace.copernicus.eu/explore-data/data-collections/"
    "copernicus-contributing-missions/collections-description/COP-DEM"
)
COPDEM_CREDIT = (
    "Copernicus DEM GLO-30, © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH "
    "2014-2018, provided under COPERNICUS by the European Union and ESA; all rights reserved"
)
# The GLO-30 licence (Article 4) grants reproduction, distribution and adaptation to anyone, so
# files made from the DEM, such as the contour lines, can be shared with the notice above.
COPDEM_SHARE_DERIVED = True
COPDEM_SHARE_NOTE = (
    "Article 4: the Licensor grants to the User the following non-exclusive rights of use "
    "regarding the Copernicus WorldDEM-30: (a) reproduction; (b) distribution; (c) communication "
    "to the General Public; (d) adaptation, modification and combination with other data and "
    "information."
)


def dem_tile_name(lat: int, lon: int) -> str:
    """Build the Copernicus DEM tile name for a 1 x 1 degree tile.

    I build the names instead of listing the bucket, because the naming rule is documented and
    fixed: 10 means 10 arc seconds of the 1 x 1 degree grid (about 30 m), and N43_00_E011_00 is
    the tile's south-west corner.
    """
    return f"Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM"


SOURCES = [
    {
        "name": "HydroBASINS Europe, level 12, v1c (standard, without lakes)",
        "publisher": "HydroSHEDS (WWF, McGill University)",
        "url": "https://data.hydrosheds.org/file/HydroBASINS/standard/hybas_eu_lev12_v1c.zip",
        "file": "hybas_eu_lev12_v1c.zip",
        "format": "Shapefile (zipped), polygons, EPSG:4326, areas in km²",
        "licence": HYDROSHEDS_LICENCE,
        "licence_url": HYDROSHEDS_LICENCE_URL,
        "credit": HYDROSHEDS_CREDIT,
        "share_derived": HYDROSHEDS_SHARE_DERIVED,
        "share_note": HYDROSHEDS_SHARE_NOTE,
    },
    {
        "name": "HydroRIVERS Europe, v1.0",
        "publisher": "HydroSHEDS (WWF, McGill University)",
        "url": "https://data.hydrosheds.org/file/HydroRIVERS/HydroRIVERS_v10_eu_shp.zip",
        "file": "HydroRIVERS_v10_eu_shp.zip",
        "format": "Shapefile (zipped), lines, EPSG:4326, lengths in km",
        "licence": HYDROSHEDS_LICENCE,
        "licence_url": HYDROSHEDS_LICENCE_URL,
        "credit": HYDROSHEDS_CREDIT,
        "share_derived": HYDROSHEDS_SHARE_DERIVED,
        "share_note": HYDROSHEDS_SHARE_NOTE,
    },
] + [
    {
        "name": f"Copernicus DEM GLO-30 tile N{lat} E{lon:03d}",
        "publisher": "ESA / Copernicus, served by the AWS Open Data Registry",
        "url": f"{DEM_BASE_URL}/{dem_tile_name(lat, lon)}/{dem_tile_name(lat, lon)}.tif",
        "file": f"{DEM_DIR_NAME}/{dem_tile_name(lat, lon)}.tif",
        "format": "Cloud-optimised GeoTIFF, EPSG:4326, heights in metres (EGM2008)",
        "licence": COPDEM_LICENCE,
        "licence_url": COPDEM_LICENCE_URL,
        "credit": COPDEM_CREDIT,
        "share_derived": COPDEM_SHARE_DERIVED,
        "share_note": COPDEM_SHARE_NOTE,
    }
    for lat in DEM_LATS
    for lon in DEM_LONS
]


def download(session: requests.Session, url: str, target: Path) -> None:
    """Stream one file to disk through a .part file, then rename it.

    I stream in 1 MB chunks so a 70 MB zip never sits in memory, and I only rename the .part
    file once the last chunk is written. If the script dies halfway, the .part file is left
    behind and the next run starts that file again instead of trusting a broken copy.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + ".part")
    with session.get(url, stream=True, timeout=TIMEOUT_S) as response:
        response.raise_for_status()
        with part.open("wb") as f:
            for chunk in response.iter_content(CHUNK_BYTES):
                f.write(chunk)
    part.rename(target)


def sha256(path: Path) -> str:
    """Hash a file in chunks, so the checksum in sources.json can be compared by anyone."""
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def unzip(path: Path) -> Path:
    """Unzip into a folder named after the zip and return that folder.

    The HydroSHEDS zips hold a shapefile, which is really four or more files (.shp geometry,
    .dbf attributes, .prj CRS, .shx index). They only work together, so I keep them in one folder.
    """
    out_dir = path.with_suffix("")
    if out_dir.exists():
        return out_dir
    with zipfile.ZipFile(path) as z:
        z.extractall(out_dir)
    return out_dir


def file_date(path: Path) -> str:
    """The day a file was last written, as YYYY-MM-DD in local time."""
    return date.fromtimestamp(path.stat().st_mtime).isoformat()


def main() -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    records = []
    # A file that is already there keeps the day it was really fetched: from the last sources.json,
    # or else from the file's own modification time. Stamping today on a skipped file would lie.
    sources_json = RAW_DIR / "sources.json"
    earlier = (
        {r["file"]: r.get("downloaded") for r in json.loads(sources_json.read_text())}
        if sources_json.exists()
        else {}
    )
    for source in SOURCES:
        target = RAW_DIR / source["file"]
        if target.exists():
            print(f"skip      {source['file']} (already there)")
            fetched_on = earlier.get(source["file"]) or file_date(target)
        else:
            print(f"download  {source['file']}")
            download(session, source["url"], target)
            fetched_on = date.today().isoformat()
        size_bytes = target.stat().st_size
        if size_bytes < 1_000_000:  # every file here is tens of MB; a tiny file is an error page
            raise RuntimeError(f"{target.name} is only {size_bytes} bytes, check the URL")
        if target.suffix == ".zip":
            print(f"unzip     {source['file']} -> {unzip(target).name}/")
        records.append(
            {
                **source,
                "downloaded": fetched_on,
                "size_bytes": size_bytes,
                "sha256": sha256(target),
            }
        )
    (RAW_DIR / "sources.json").write_text(json.dumps(records, indent=2, ensure_ascii=False))
    total_mb = sum(r["size_bytes"] for r in records) / 1e6
    print(f"done: {len(records)} files, {total_mb:.0f} MB, listed in data/raw/sources.json")


if __name__ == "__main__":
    main()
