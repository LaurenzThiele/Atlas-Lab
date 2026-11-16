"""Turn the raw Overture files into the small layers the 3D map of Miami loads.

What it does: I keep every above-ground building that touches the building box, give it a height
(its own `height`, else floors x 3.5 m, else 4 m) and write all 187,203 footprints as vector
tiles in one PMTiles file. I clip land and water to the wider ground box, simplify them to what
the map can show and write them as a second PMTiles file, plus plain GeoJSON copies to download.
I also check the five hand-placed labels against the data and measure the areas the key prints.
Reads:  data/raw/overture_buildings_miami.parquet, data/raw/overture_land_miami_wide.parquet,
        data/raw/overture_water_miami_wide.parquet, data/raw/sources.json,
        data/key_figures.json
Writes: maps/layers/buildings.pmtiles   (layer "buildings", zoom 11 to 15)
        maps/layers/base.pmtiles        (layers "land" and "water", zoom 4 to 13)
        maps/layers/labels.geojson      (the five place names)
        maps/layers/figures.json        (copy of data/key_figures.json)
        maps/layers/meta.json           (sources and dates, areas, the tallest building)
        maps/layers/download/land.geojson.zip, maps/layers/download/water.geojson.zip
Run:    uv run maps/prepare.py   (from the piece folder; needs tippecanoe 2.17 or newer and its
        tile-join on PATH)

What you learn: why vector tiles are the right shape for a whole city. 187,203 footprints are
far too many for one GeoJSON file in a browser (about 60 MB to parse before anything shows).
Cut into tiles, the map loads only the part of the city on screen, at the detail the zoom can
show: a few kilometres of streets near the camera in full detail, and the far skyline from
coarser tiles. You also see how Overture's height field is filled in a real city, and how much
a careful fallback changes (very little in Miami: 97.8% of heights are measured).
"""

import json
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

import geopandas as gpd
import pandas as pd
import shapely
from shapely.geometry import Point, box
from shapely.ops import unary_union

HERE = Path(__file__).parent
PIECE_DIR = HERE.parent
RAW_DIR = PIECE_DIR / "data" / "raw"
BUILDINGS_FILE = RAW_DIR / "overture_buildings_miami.parquet"
LAND_FILE = RAW_DIR / "overture_land_miami_wide.parquet"
WATER_FILE = RAW_DIR / "overture_water_miami_wide.parquet"
SOURCES_FILE = RAW_DIR / "sources.json"
KEY_FIGURES_FILE = PIECE_DIR / "data" / "key_figures.json"
OUT_DIR = HERE / "layers"
DOWNLOAD_DIR = OUT_DIR / "download"

# The same two boxes as data/download.py (lon, lat in degrees, WGS 84).
BUILDING_BBOX = (-80.32, 25.70, -80.11, 25.88)
GROUND_BBOX = (-80.80, 25.30, -79.65, 26.30)

# The height rule, the same as data/key_figures.py, so the map and the figures agree.
FLOOR_HEIGHT_M = 3.5
DEFAULT_HEIGHT_M = 4.0

# Areas and distances in UTM zone 17N (EPSG:32617): metric, and Miami (80.2° W) sits close to
# the zone's central meridian (81° W), so areas are true to well under 0.1%.
METRIC_CRS = 32617

# Zoom ranges. Buildings run from 11 to 15 (see LOW_LEVELS below); past 15 the map overzooms the
# z15 tiles, which already hold every vertex to about 0.3 m. Land and water start at 4 so that a
# camera tilted up to the horizon finds ground in its far, coarse tiles.
BASE_ZOOMS = (4, 13)

# Three tile sets, joined into one file. A tilted camera fills the far half of the screen from
# the coarse z11 and z12 tiles, where one screen pixel is 17 to 34 m across. A 10 m house there is
# a third of a pixel, yet with every outline in full those tiles were up to 1.3 MB each. So z11
# is cut at 512 units per tile (about a screen pixel) and z12 at 1,024 (half a pixel):
# houses shrink to a unit or less, and tippecanoe's tiny-polygon reduction turns the smallest
# into specks that keep their total area, so the suburbs keep their tone and street grid. Towers
# stay whole blocks. These tiles carry only what drawing needs (fid, h, src) and lo=1, so a click
# on a speck knows to fly in first. z13 to z15 hold every footprint in full.
LOW_LEVELS = [(11, 9), (12, 10)]  # (zoom, detail): 2^detail units across a tile
FULL_ZOOMS = (13, 15)

# Land and water are simplified before tiling, to about 2 m: the size of one pixel at zoom 15
# here. tippecanoe simplifies again for each lower zoom. The downloads get the same geometry.
SIMPLIFY_M = 2.0
COORD_DECIMALS = 5  # about 1 m, the precision of the downloads


# The five place names, placed by hand. kind "land" must lie on land and off water, kind
# "water" on water: I check both against the data below, so a label never names the wrong thing.
LABELS = [
    {"name": "Miami Beach", "kind": "land", "lon": -80.133, "lat": 25.800},
    {"name": "Downtown", "kind": "land", "lon": -80.196, "lat": 25.775},
    {"name": "Brickell", "kind": "land", "lon": -80.193, "lat": 25.760},
    {"name": "Biscayne Bay", "kind": "water", "lon": -80.165, "lat": 25.765},
    # Moved about 150 m north-east from -80.158, 25.712, which falls in a lagoon in Crandon Park.
    {"name": "Key Biscayne", "kind": "land", "lon": -80.157, "lat": 25.713},
]

# The tallest building, as the prompt for this map gives it, to check the data still agrees.
TALLEST_CENTROID = (-80.19036, 25.76304)
TALLEST_TOLERANCE_DEG = 0.0002  # about 20 m


def read_overture(path: Path) -> gpd.GeoDataFrame:
    """Read one Overture GeoParquet file in EPSG:4326."""
    if not path.exists():
        raise SystemExit(f"Missing {path.name}: run uv run data/download.py first")
    gdf = gpd.read_parquet(path)
    # Overture writes OGC:CRS84, which is WGS 84 with longitude first. I convert to EPSG:4326
    # rather than set it: set_crs(4326) raises a CRS mismatch. The numbers do not change.
    return gdf.to_crs(4326)


def footprint_datasets(sources: object) -> str:
    """Who drew the outline: the source entries that cover the whole feature (empty property).

    Overture lists one entry per contribution. An entry with property "/properties/height" only
    gave the height (USGS lidar, for example); the footprint is the entry with no property.
    """
    if sources is None:
        return ""
    names = [s["dataset"] for s in sources if not s.get("property")]
    return ", ".join(dict.fromkeys(names))  # keep order, drop repeats


def primary_name(names: object) -> str:
    if isinstance(names, dict) and names.get("primary"):
        return str(names["primary"])
    return ""


def load_buildings() -> gpd.GeoDataFrame:
    """Every above-ground footprint that touches the building box, with its height and origin."""
    gdf = read_overture(BUILDINGS_FILE)
    above = ~gdf["is_underground"].fillna(False).astype(bool)
    # The download kept footprints whose bounding box touches the box; I keep the ones whose
    # outline does. Two rows drop out here, the same two key_figures.py leaves out.
    inside = gdf.intersects(box(*BUILDING_BBOX))
    gdf = gdf[above & inside].copy()

    has_height = gdf["height"].notna()
    has_floors = gdf["num_floors"].notna() & ~has_height
    gdf["src"] = "default"
    gdf.loc[has_floors, "src"] = "floors"
    gdf.loc[has_height, "src"] = "height"
    gdf["h"] = DEFAULT_HEIGHT_M
    gdf.loc[has_floors, "h"] = gdf.loc[has_floors, "num_floors"] * FLOOR_HEIGHT_M
    gdf.loc[has_height, "h"] = gdf.loc[has_height, "height"]
    # 101 footprints have a measured height under 5 cm (most likely lidar returns from a flat
    # roof slab or a carport): they round to 0.0 m and lie flat. I keep them as the data says.
    gdf["h"] = gdf["h"].round(1)
    if gdf["h"].min() < 0 or gdf["h"].max() > 400:
        raise ValueError(f"Height out of range: {gdf['h'].min()} to {gdf['h'].max()} m")

    # A stable integer id for each building, so the map can mark the clicked one (feature state
    # needs an id, and MapLibre takes it from this property with promoteId). Sorting by
    # Overture's own id first makes the same input give the same fid every run.
    gdf = gdf.sort_values("id").reset_index(drop=True)
    gdf["fid"] = gdf.index.astype("int64")
    gdf["name"] = gdf["names"].map(primary_name)
    gdf["floors"] = gdf["num_floors"].astype("Int64")
    gdf["by"] = gdf["sources"].map(footprint_datasets)
    return gdf[["fid", "h", "src", "name", "floors", "by", "geometry"]]


def check_buildings(gdf: gpd.GeoDataFrame, figures: dict) -> dict:
    """The counts must match data/key_figures.json exactly, or the map would contradict it."""
    counts = gdf["src"].value_counts()
    expected = {
        "buildings": len(gdf),
        "real_height": int(counts.get("height", 0)),
        "height_from_floors": int(counts.get("floors", 0)),
        "height_default": int(counts.get("default", 0)),
        "towers_100m": int((gdf["h"] >= 100).sum()),
    }
    for id_, value in expected.items():
        if figures[id_]["value"] != value:
            raise ValueError(f"{id_}: map has {value}, key_figures.json {figures[id_]['value']}")
    print(f"Buildings: {len(gdf):,} ({', '.join(f'{k} {v:,}' for k, v in counts.items())})")

    tallest = gdf.loc[gdf["h"].idxmax()]
    # The centroid in a metric CRS, then back to degrees: a centroid in degrees is slightly off.
    centre = gpd.GeoSeries([tallest.geometry], crs=4326).to_crs(METRIC_CRS).centroid
    lon, lat = centre.to_crs(4326).iloc[0].coords[0]
    if (
        abs(lon - TALLEST_CENTROID[0]) > TALLEST_TOLERANCE_DEG
        or abs(lat - TALLEST_CENTROID[1]) > TALLEST_TOLERANCE_DEG
    ):
        raise ValueError(f"Tallest building centroid moved: {lon:.5f}, {lat:.5f}")
    if float(tallest["h"]) != figures["tallest"]["value"]:
        raise ValueError("The tallest building's height differs from key_figures.json")
    print(
        f"Tallest: {tallest['name']} {tallest['h']} m at {lon:.5f}, {lat:.5f} (fid {tallest['fid']})"
    )
    return {
        "fid": int(tallest["fid"]),
        "lon": round(lon, 5),
        "lat": round(lat, 5),
        "h": float(tallest["h"]),
        "src": tallest["src"],
        "name": tallest["name"],
        "floors": None if pd.isna(tallest["floors"]) else int(tallest["floors"]),
        "by": tallest["by"],
    }


def clip_polygons(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Polygons only, cut to the ground box, simplified to about one z15 pixel."""
    gdf = gdf[gdf.geom_type.isin(["Polygon", "MultiPolygon"])].copy()
    # Land comes as a few continent-sized polygons: the bbox filter of the download keeps the
    # whole coast of Florida. Clipping to the ground box cuts them down to what the map shows.
    gdf["geometry"] = gdf.geometry.intersection(box(*GROUND_BBOX))
    gdf = gdf[~gdf.geometry.is_empty]
    # I simplify in metres (UTM), not in degrees, so the tolerance means the same thing in x
    # and y. preserve_topology keeps rings valid where a channel narrows to a few metres.
    metric = gdf.to_crs(METRIC_CRS)
    metric["geometry"] = metric.geometry.simplify(SIMPLIFY_M, preserve_topology=True)
    gdf = metric.to_crs(4326)
    gdf = gdf[~gdf.geometry.is_empty & gdf.geom_type.isin(["Polygon", "MultiPolygon"])]
    return gdf.reset_index(drop=True)


def load_ground() -> tuple[gpd.GeoDataFrame, gpd.GeoDataFrame]:
    land = read_overture(LAND_FILE)
    # The "land" subtype is the land mass itself, cut out of the sea along the coastline. The
    # other subtypes (trees, wetland, sand ...) are smaller features on top of it, not drawn.
    land = clip_polygons(land[land["subtype"] == "land"])[["geometry"]]
    water = read_overture(WATER_FILE)
    water = clip_polygons(water)[["subtype", "geometry"]]
    print(f"Land: {len(land):,} polygons, water: {len(water):,} polygons, in the ground box")
    return land, water


def area_km2(gdf: gpd.GeoDataFrame) -> int:
    """Area as drawn, overlaps counted once (the ocean and the bay overlap at their seam)."""
    merged = unary_union(gdf.to_crs(METRIC_CRS).geometry.values)
    return round(merged.area / 1e6)


def check_labels(land: gpd.GeoDataFrame, water: gpd.GeoDataFrame) -> None:
    """Each land label must sit on land and off water, each water label on water."""
    land_shape = unary_union(land.geometry.values)
    water_shape = unary_union(water.geometry.values)
    for label in LABELS:
        point = Point(label["lon"], label["lat"])
        on_land = land_shape.contains(point) and not water_shape.contains(point)
        on_water = water_shape.contains(point) or not land_shape.contains(point)
        ok = on_land if label["kind"] == "land" else on_water
        print(
            f"  label {label['name']:<13} on {'land' if on_land else 'water'}: {'ok' if ok else 'WRONG'}"
        )
        if not ok:
            raise ValueError(f"Label {label['name']} is not on {label['kind']}: move it")


def write_labels(path: Path) -> None:
    features = [
        {
            "type": "Feature",
            "properties": {"name": label["name"], "kind": label["kind"]},
            "geometry": {"type": "Point", "coordinates": [label["lon"], label["lat"]]},
        }
        for label in LABELS
    ]
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features}) + "\n")


def write_buildings_seq(gdf: gpd.GeoDataFrame, path: Path, low: bool = False) -> None:
    """GeoJSON lines for tippecanoe, written by hand so empty values can stay out.

    A missing property costs no bytes in the tiles, an empty string does. With low=True only the
    properties the far tiles need are written, plus lo=1.
    """
    geometries = shapely.to_geojson(gdf.geometry.values, indent=None)
    columns = ["fid", "h", "src", "name", "floors", "by"]
    with path.open("w", encoding="utf-8") as out:
        for row, geometry in zip(gdf[columns].itertuples(index=False), geometries):
            props = {"fid": int(row.fid), "h": float(row.h), "src": row.src}
            if low:
                props["lo"] = 1
            elif row.name:
                props["name"] = row.name
            if not low and not pd.isna(row.floors):
                props["floors"] = int(row.floors)
            if not low and row.by:
                props["by"] = row.by
            feature = '{"type":"Feature","properties":'
            out.write(f'{feature}{json.dumps(props, ensure_ascii=False)},"geometry":{geometry}}}\n')


def write_geojson_seq(gdf: gpd.GeoDataFrame, path: Path) -> None:
    """Newline-delimited GeoJSON, the fastest input for tippecanoe (it reads it in parallel)."""
    gdf.to_file(path, driver="GeoJSONSeq", layer_options={"COORDINATE_PRECISION": 7})


def write_download(gdf: gpd.GeoDataFrame, path: Path, scratch: Path) -> None:
    """A plain GeoJSON copy for readers, at about 1 m precision, in a zip of its own.

    Zipped, because the water alone is 5.5 MB of text and the whole published map has to stay
    under 25 MB. The zip holds one file, <name>.geojson, with a fixed date so reruns match.
    """
    geojson = scratch / path.name.removesuffix(".zip")
    gdf.to_file(
        geojson,
        driver="GeoJSON",
        layer_options={"COORDINATE_PRECISION": COORD_DECIMALS, "RFC7946": "YES"},
    )
    info = zipfile.ZipInfo(geojson.name, date_time=(2026, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(info, geojson.read_bytes(), compresslevel=9)


def join_tiles(out: Path, parts: list[Path]) -> None:
    """Join tile sets of different zoom ranges into one PMTiles file, with tippecanoe's tile-join."""
    tile_join = shutil.which("tile-join")
    if tile_join is None:
        raise SystemExit("tile-join not found: it comes with tippecanoe")
    if out.exists():
        out.unlink()
    command = [tile_join, "-o", str(out), "--no-tile-size-limit", "--quiet", "--force"]
    subprocess.run(command + [str(part) for part in parts], check=True)


def run_tippecanoe(
    out: Path, layers: dict[str, Path], zooms: tuple[int, int], extra: list[str]
) -> None:
    """Cut the layers into vector tiles in one PMTiles file."""
    tippecanoe = shutil.which("tippecanoe")
    if tippecanoe is None:
        raise SystemExit("tippecanoe not found: install it from https://github.com/felt/tippecanoe")
    if out.exists():
        out.unlink()
    command = [tippecanoe, "-o", str(out), "-Z", str(zooms[0]), "-z", str(zooms[1])]
    for name, path in layers.items():
        command += ["-L", f"{name}:{path}"]
    command += ["--quiet", "--force", *extra]
    subprocess.run(command, check=True)


# Buildings, z13 to z15: every footprint, never thinned. Below zoom 15 I let tippecanoe simplify
# the outlines 4 times more than its default of one tile pixel: about 2 m at z14 and 4 m at z13,
# still under a screen pixel there, so a house keeps the 4 or 5 corners the eye can see. Zoom 15,
# the most detailed, keeps every corner (simplify-only-low-zooms).
FULL_TILE_OPTIONS = [
    "--no-feature-limit",
    "--no-tile-size-limit",
    "--simplification=4",
    "--simplify-only-low-zooms",
]
# Buildings, z11 and z12: the coarse detail of LOW_LEVELS, with tiny-polygon reduction left on
# (tippecanoe's default), which is what keeps the specks.
LOW_TILE_OPTIONS = ["--no-feature-limit", "--no-tile-size-limit"]
# Land and water: few, large polygons; detect-shared-borders keeps neighbouring water bodies
# from opening hairline gaps when each is simplified on its own.
BASE_TILE_OPTIONS = ["--no-feature-limit", "--no-tile-size-limit", "--detect-shared-borders"]


def read_figures() -> dict:
    if not KEY_FIGURES_FILE.exists():
        raise SystemExit("Missing data/key_figures.json: run uv run data/key_figures.py first")
    return {f["id"]: f for f in json.loads(KEY_FIGURES_FILE.read_text(encoding="utf-8"))}


def read_sources() -> list[dict]:
    if not SOURCES_FILE.exists():
        raise SystemExit("Missing data/raw/sources.json: run uv run data/download.py first")
    return json.loads(SOURCES_FILE.read_text(encoding="utf-8"))


def print_sizes(paths: list[Path]) -> None:
    print("\nWritten:")
    for path in paths:
        print(f"  {path.relative_to(PIECE_DIR)!s:<44} {path.stat().st_size / 1e6:8.2f} MB")


def main() -> None:
    OUT_DIR.mkdir(exist_ok=True)
    DOWNLOAD_DIR.mkdir(exist_ok=True)
    figures = read_figures()

    buildings = load_buildings()
    tallest = check_buildings(buildings, figures)
    land, water = load_ground()
    check_labels(land, water)
    areas = {"land_km2": area_km2(land), "water_km2": area_km2(water)}
    print(f"Areas as drawn: land {areas['land_km2']:,} km², water {areas['water_km2']:,} km²")

    outputs = []
    with tempfile.TemporaryDirectory() as scratch:
        scratch = Path(scratch)
        write_buildings_seq(buildings, scratch / "full.geojsons")
        write_buildings_seq(buildings, scratch / "low.geojsons", low=True)
        run_tippecanoe(
            scratch / "full.pmtiles",
            {"buildings": scratch / "full.geojsons"},
            FULL_ZOOMS,
            FULL_TILE_OPTIONS,
        )
        parts = []
        for zoom, detail in LOW_LEVELS:
            part = scratch / f"z{zoom}.pmtiles"
            options = [*LOW_TILE_OPTIONS, f"--full-detail={detail}", f"--low-detail={detail}"]
            run_tippecanoe(part, {"buildings": scratch / "low.geojsons"}, (zoom, zoom), options)
            parts.append(part)
        out = OUT_DIR / "buildings.pmtiles"
        join_tiles(out, [*parts, scratch / "full.pmtiles"])
        outputs.append(out)

        write_geojson_seq(land, scratch / "land.geojsons")
        write_geojson_seq(water[["geometry"]], scratch / "water.geojsons")
        out = OUT_DIR / "base.pmtiles"
        layers = {"land": scratch / "land.geojsons", "water": scratch / "water.geojsons"}
        run_tippecanoe(out, layers, BASE_ZOOMS, BASE_TILE_OPTIONS)
        outputs.append(out)

        for name, gdf in [("land", land), ("water", water)]:
            out = DOWNLOAD_DIR / f"{name}.geojson.zip"
            write_download(gdf, out, scratch)
            outputs.append(out)

    out = OUT_DIR / "labels.geojson"
    write_labels(out)
    outputs.append(out)

    # The map reads every number from these two files, never from text typed into the page.
    out = OUT_DIR / "figures.json"
    out.write_text(json.dumps(list(figures.values()), indent=1, ensure_ascii=False) + "\n")
    outputs.append(out)
    meta = {
        "sources": [{"name": s["name"], "downloaded": s["downloaded"]} for s in read_sources()],
        "areas": areas,
        "tallest": tallest,
    }
    out = OUT_DIR / "meta.json"
    out.write_text(json.dumps(meta, indent=1, ensure_ascii=False) + "\n")
    outputs.append(out)

    print_sizes(outputs)


if __name__ == "__main__":
    main()
