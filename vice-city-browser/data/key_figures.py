"""Compute the key figures for "I built the real Vice City in my browser" (Miami in 3D).

What it does: I count the buildings in the Miami box, sort them by where their height comes
from (a real `height`, else floors x 3.5 m, else a 4 m default, the same order the map uses),
find the tallest one and count the towers of 100 m or more. I also derive the number of frames
the reel is filmed in from its length and frame rate.
Reads:  data/raw/overture_buildings_miami.parquet, data/raw/sources.json
Writes: data/key_figures.json
Run:    uv run data/key_figures.py   (from the piece folder, after data/download.py)

What you learn: how complete open 3D city data really is. Overture merges OpenStreetMap,
Microsoft's machine-learned footprints and USGS lidar footprints into one layer, and every row
says which source it came from. You can count, before you draw anything, how many heights are
measured and how many you would have to guess. In Miami almost all of them are real.
"""

import json
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import box

HERE = Path(__file__).parent
RAW_DIR = HERE / "raw"
BUILDINGS_FILE = RAW_DIR / "overture_buildings_miami.parquet"
SOURCES_FILE = RAW_DIR / "sources.json"
OUT_FILE = HERE / "key_figures.json"

# Same box as download.py. Overture's bbox filter keeps every footprint whose own bounding box
# touches the box, so I cut once more on the real geometry: a footprint counts when it touches
# the box. That is what the map shows.
BUILDING_BBOX = (-80.32, 25.70, -80.11, 25.88)

FLOOR_HEIGHT_M = 3.5  # my fallback for one storey when only num_floors is known
DEFAULT_HEIGHT_M = 4.0  # my fallback when a building has neither height nor floors
TOWER_HEIGHT_M = 100.0  # "tower" threshold for the count of tall buildings

# The reel: 30 s at 30 frames per second, stepped through one frame at a time.
REEL_DURATION_S = 30
REEL_FPS = 30

SOURCE_TAG = "Overture Maps buildings 2026-10-21.0"


def load_buildings() -> gpd.GeoDataFrame:
    """Read the buildings and keep the ones the map draws: above ground, touching the box."""
    if not BUILDINGS_FILE.exists():
        raise SystemExit(f"Missing {BUILDINGS_FILE.name}: run uv run data/download.py first")
    gdf = gpd.read_parquet(BUILDINGS_FILE)
    # Overture writes its CRS as OGC:CRS84 (longitude first). That is WGS 84 with the axis order
    # spelled out, so I convert to EPSG:4326 instead of setting it; set_crs(4326) would raise a
    # CRS mismatch. Coordinates stay the same, longitude then latitude.
    gdf = gdf.to_crs(4326)
    lon_ok = gdf.total_bounds[0] > -81 and gdf.total_bounds[2] < -79.5
    lat_ok = gdf.total_bounds[1] > 25 and gdf.total_bounds[3] < 26.5
    if not (lon_ok and lat_ok):
        raise ValueError(f"Buildings are not around Miami: bounds {gdf.total_bounds}")
    above = ~gdf["is_underground"].fillna(False).astype(bool)
    inside = gdf.intersects(box(*BUILDING_BBOX))
    print(
        f"Rows in file: {len(gdf):,}; underground: {(~above).sum()}; outside box: {(~inside).sum()}"
    )
    return gdf[above & inside].copy()


def add_heights(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Give every building a height and note where it came from."""
    has_height = gdf["height"].notna()
    has_floors = gdf["num_floors"].notna() & ~has_height
    gdf["height_from"] = "default"
    gdf.loc[has_floors, "height_from"] = "num_floors"
    gdf.loc[has_height, "height_from"] = "height"
    gdf["height_m"] = DEFAULT_HEIGHT_M
    gdf.loc[has_floors, "height_m"] = gdf.loc[has_floors, "num_floors"] * FLOOR_HEIGHT_M
    gdf.loc[has_height, "height_m"] = gdf.loc[has_height, "height"]
    if gdf["height_m"].max() > 400 or gdf["height_m"].min() <= 0:
        raise ValueError(f"Height out of range: {gdf['height_m'].min()} to {gdf['height_m'].max()}")
    return gdf


def building_name(names: object) -> str:
    """Overture keeps names in a struct; the primary name is the one on the ground."""
    if isinstance(names, dict) and names.get("primary"):
        return str(names["primary"])
    return "unnamed"


def release_of(sources_file: Path) -> str:
    """The Overture release the raw file came from, as download.py recorded it."""
    if not sources_file.exists():
        raise SystemExit("Missing data/raw/sources.json: run uv run data/download.py first")
    entries = json.loads(sources_file.read_text(encoding="utf-8"))
    return next(e["release"] for e in entries if e["file"] == BUILDINGS_FILE.name)


def figure(id_: str, value: float | str, unit: str, display: str, method: str) -> dict:
    """One entry of key_figures.json."""
    return {
        "id": id_,
        "value": value,
        "unit": unit,
        "display": display,
        "source": SOURCE_TAG,
        "method": method,
    }


def main() -> None:
    release = release_of(SOURCES_FILE)
    if release not in SOURCE_TAG:
        raise ValueError(f"Raw data is from release {release}, the figures say {SOURCE_TAG}")
    gdf = add_heights(load_buildings())

    n_total = len(gdf)
    groups = gdf["height_from"].value_counts()
    n_height = int(groups.get("height", 0))
    n_floors = int(groups.get("num_floors", 0))
    n_default = int(groups.get("default", 0))
    if n_height + n_floors + n_default != n_total:
        raise ValueError("Height groups do not add up to the total")
    share_height_pct = 100 * n_height / n_total

    tallest = gdf.loc[gdf["height_m"].idxmax()]
    tallest_name = building_name(tallest["names"])
    tallest_m = float(tallest["height_m"])
    n_towers = int((gdf["height_m"] >= TOWER_HEIGHT_M).sum())
    median_m = float(gdf["height_m"].median())
    frames = REEL_DURATION_S * REEL_FPS

    # Which datasets the footprints come from: this decides the credit line. A building can list
    # more than one source (a Microsoft footprint with an OSM height), so the counts overlap.
    datasets = pd.Series(
        [s["dataset"] for row in gdf["sources"] if row is not None for s in row]
    ).value_counts()

    figures = [
        figure(
            "buildings",
            n_total,
            "buildings",
            f"{n_total:,}",
            "Above-ground Overture footprints that touch the building box",
        ),
        figure(
            "real_height",
            n_height,
            "buildings",
            f"{n_height:,} ({share_height_pct:.1f}%)",
            "Buildings with a value in the `height` field; share of all buildings in the box",
        ),
        figure(
            "height_from_floors",
            n_floors,
            "buildings",
            f"{n_floors:,}",
            f"No `height` but `num_floors`: height = floors x {FLOOR_HEIGHT_M} m",
        ),
        figure(
            "height_default",
            n_default,
            "buildings",
            f"{n_default:,}",
            f"Neither `height` nor `num_floors`: given {DEFAULT_HEIGHT_M:.0f} m",
        ),
        figure(
            "tallest",
            tallest_m,
            "m",
            f"{tallest_m:.0f} m ({tallest_name})",
            "Largest height in the box, with its names.primary",
        ),
        figure(
            "towers_100m",
            n_towers,
            "buildings",
            f"{n_towers}",
            f"Buildings {TOWER_HEIGHT_M:.0f} m or taller (after the height fallbacks)",
        ),
        figure(
            "frames",
            frames,
            "frames",
            f"{frames}",
            f"Reel length {REEL_DURATION_S} s x {REEL_FPS} fps (film setting, not data)",
        ),
    ]
    figures[-1]["source"] = "Reel setting"

    OUT_FILE.write_text(json.dumps(figures, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"\nMedian height {median_m:.1f} m. Footprint sources in the box:")
    for name, count in datasets.items():
        print(f"  {name:<28} {count:>8,}")
    print(f"\n{'id':<20} {'display':<32} source")
    for f in figures:
        print(f"{f['id']:<20} {f['display']:<32} {f['source']}")
    print(f"\nWrote {OUT_FILE.relative_to(HERE.parent)}")


if __name__ == "__main__":
    main()
