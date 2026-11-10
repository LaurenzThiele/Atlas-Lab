"""Turn data/raw into the small layers the map loads.

What it does: I cut the Copernicus DEM into Terrarium terrain tiles, packed into one PMTiles
archive, draw 100 m contours (as GeoJSON for download and as vector tiles for the map), and
select the basin and the rivers that drain through Ponte Vecchio, using the same selection code
as the key figures. I also make the two procedural textures (halftone dots and paper grain).
Reads:  data/raw/ (HydroBASINS, HydroRIVERS, Copernicus DEM), data/key_figures.json
Writes: maps/layers/ (terrain.pmtiles, contours.pmtiles, GeoJSON layers, halftone.png,
        paper.png and paper.webp, key_figures.json, meta.json)
Run:    uv run maps/prepare.py   (from the piece folder)

Why Python: rasterio, GDAL and matplotlib do raster warping and contouring in a few lines, and the
browser only ever has to load the finished result.

What you learn: how to prepare a static 3D map that needs no tile server. Height can be stored as
ordinary image colours, thousands of tiles fit in one PMTiles file that the browser reads piece by
piece with HTTP range requests, contours are one matplotlib call away, and a river network can be
split into "above this bridge" and "below this bridge" by walking IDs instead of doing a GIS
overlay.
"""

import gzip
import io
import json
import shutil
import sys
from pathlib import Path

import geopandas as gpd
import matplotlib

matplotlib.use("Agg")  # I only want the contour geometry, so I never open a plot window.
import matplotlib.pyplot as plt
import numpy as np
import rasterio
import shapely
from mapbox_vector_tile import encode as encode_mvt
from PIL import Image
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import write as write_pmtiles_file
from rasterio.merge import merge
from rasterio.transform import from_bounds, from_origin
from rasterio.warp import Resampling, reproject
from shapely.geometry import LineString, MultiLineString, mapping

HERE = Path(__file__).parent
ROOT = HERE.parent
DATA_DIR = ROOT / "data"
SOURCES_JSON = DATA_DIR / "raw" / "sources.json"
DEM_DIR = DATA_DIR / "raw" / "copernicus_dem"
KEY_FIGURES_JSON = DATA_DIR / "key_figures.json"
LAYERS_DIR = HERE / "layers"

# I import the selection logic instead of rewriting it. The map and the published figures then
# come from the same lines of code, so they cannot drift apart.
sys.path.insert(0, str(DATA_DIR))
import key_figures as kf

EXTENT = (10.00, 42.70, 12.50, 44.35)  # lon_min, lat_min, lon_max, lat_max, EPSG:4326
DEM_FILES = [
    f"Copernicus_DSM_COG_10_N{lat}_00_E{lon:03d}_00_DEM.tif"
    for lat in (42, 43, 44)
    for lon in (10, 11, 12)
]
DEM_MIN_M, DEM_MAX_M = -50.0, 2_500.0  # sane range: below sea level to the Monti Reatini (2,216 m)

TERRAIN_ZOOMS = range(6, 11)  # z10 is about 110 m per pixel here: enough for a raised relief model
# Around Florence a close-up stretches z10 hillshade four to six times, and MapLibre's per-tile
# shading then shows the tile edges as faint lines. For a box around the city I add z11 and z12
# (about 28 m per pixel, the DEM's own 30 m). The box is widened to whole z11 tiles, so at both
# zooms the tiles cover exactly the same rectangle, and one mask in main.js can match it.
CITY_TERRAIN_BOX = (11.10, 43.64, 11.40, 43.90)  # lon_min, lat_min, lon_max, lat_max, EPSG:4326
CITY_TERRAIN_ZOOMS = range(11, 13)
TILE_PX = 256
# One archive for the whole pyramid, the city zooms included. A folder of tiles would be hundreds
# of small files; one PMTiles file is a single upload, and the browser still fetches only the tiles
# it needs, with HTTP range requests. Lossless WebP keeps every height exact and is about 30 %
# smaller than PNG.
TERRAIN_PMTILES = "terrain.pmtiles"
# EPSG:3857, Web Mercator: every web map tile pyramid is cut in it, because its square world
# divides into square tiles of 2^z x 2^z. It distorts area badly, so I never measure in it.
TILE_CRS = "EPSG:3857"
MERCATOR_HALF_WORLD_M = 20_037_508.342789244
# Terrarium stores 1/256 m steps, far finer than this DEM can resolve. Rounding to 25 cm leaves the
# valley floors smooth under the hillshade but makes the PNGs compress about a third better.
ELEVATION_STEP_M = 0.25
# The map does not show a rectangle of land but the area of interest: the basin above the bridge
# and the Arno from its spring to the sea, with a margin around both. I buffer in EPSG:32632
# (UTM 32N, metres on the ground), so "20 km" means 20 km everywhere on the map.
AOI_CRS = kf.LENGTH_CRS
AOI_BUFFER_M = 20_000
# Buffering out and back in by the same distance (a morphological "closing") fills the notches,
# such as the one between the basin and the lower Arno, so the outline runs in soft curves.
AOI_ROUND_M = 15_000
AOI_SIMPLIFY_M = 100  # the outline is smooth, so a 100 m tolerance changes nothing you can see
# The relief settles down to the paper over the last 5 km inside the outline. Without this, the 3D
# surface would drop off in a sheer wall where the data ends.
RELIEF_FEATHER_M = 5_000

# I contour in EPSG:32632 (UTM 32N): its pixels are square metres on the ground, so "90 m" and
# "simplify by 40 m" mean what they say. In degrees, a pixel is narrower than it is tall here.
CONTOUR_CRS = kf.LENGTH_CRS
CONTOUR_PIXEL_M = 90
CONTOUR_INTERVAL_M = 100
CONTOUR_INDEX_M = 500
CONTOUR_SIMPLIFY_M = 40
CONTOUR_MIN_LENGTH_M = 400  # shorter loops are radar speckle on one hilltop, not landscape
# Around the city the map gets close enough to see the corners a 90 m grid leaves in a contour.
CITY_RADIUS_M = 8_000
CITY_CONTOUR_CHAIKIN_PASSES = 2
# The contours are too big for one GeoJSON download at the start (about 4 MB), so the map reads
# them as vector tiles: each tile holds only its own lines, simplified for its zoom. I simplify by
# 0.2 px of a 512 px tile, the same tolerance MapLibre used when it tiled the GeoJSON itself, and
# stop at z14 like it did, so the lines look the same at every zoom.
CONTOURS_PMTILES = "contours.pmtiles"
CONTOUR_TILE_ZOOMS = range(15)
CONTOUR_TILE_PX = 512
CONTOUR_TOLERANCE_PX = 0.2
CONTOUR_BUFFER_PX = 8  # lines run a little past the tile edge, so no seam shows where tiles meet
MVT_EXTENT = 8192  # tile coordinates per tile side; MapLibre's own GeoJSON tiles use the same

PISA = (10.40, 43.72)
# The display Arno. HydroRIVERS draws rivers on its 15 arc-second grid, so the raw line is a
# staircase of straight runs and sudden steps about 450 m apart. Cutting corners keeps the runs; a
# Gaussian over a few steps lets the river's real course come through them instead.
ARNO_LABEL_LON = 11.212  # where the label "Arno" sits on the display line
DISPLAY_SPACING_M = 100
DISPLAY_SIGMA_M = 700
# HydroRIVERS is a 15 arc-second network, so its Arno misses the real bridge by a little. Over this
# length (km) the display line bends to pass through it.
BRIDGE_BEND_KM = 1.2
MAX_BRIDGE_MISS_KM = 0.4
COORD_DECIMALS = 5  # about 1 m on the ground, far finer than any source line here
MAX_LAYERS_MB = 20

# The published text for every figure. The script stops if the data ever says otherwise.
EXPECTED_DISPLAY = {
    "death_toll": "35",
    "flood_date": "4 November 1966",
    "worst_flood": "worst flood in centuries",
    "basin_area": "4,600 km²",
    "times_florence": "45 times the size of Florence",
    "arno_length": "241 km",
    "florence_area": "102 km²",
}
EXPECTED_BASIN_UNITS = 33
EXPECTED_STEM_REACHES = 74

PIENA_RGB = (0x1E, 0x35, 0x50)
INCHIOSTRO_RGB = (0x2A, 0x27, 0x23)
HALFTONE_PX = 32
HALFTONE_CELL_PX = 8  # 32 / 8 = 4 cells per tile
HALFTONE_DOT_RADIUS_PX = 1.35
HALFTONE_SUPERSAMPLE = 8
PAPER_PX = 512
PAPER_SEED = 1966  # a fixed seed: same input, same output


def lon_to_tile(lon: float, zoom: int) -> int:
    return int((lon + 180.0) / 360.0 * 2**zoom)


def lat_to_tile(lat: float, zoom: int) -> int:
    lat_rad = np.radians(lat)
    return int((1.0 - np.log(np.tan(lat_rad) + 1.0 / np.cos(lat_rad)) / np.pi) / 2.0 * 2**zoom)


def tile_bounds_m(x: int, y: int, zoom: int) -> tuple[float, float, float, float]:
    """Bounds of one web map tile in Web Mercator metres."""
    size_m = 2 * MERCATOR_HALF_WORLD_M / 2**zoom
    west = -MERCATOR_HALF_WORLD_M + x * size_m
    north = MERCATOR_HALF_WORLD_M - y * size_m
    return west, north - size_m, west + size_m, north


def read_dem() -> tuple[np.ndarray, rasterio.Affine, object]:
    """Mosaic the six 1-degree DEM tiles into one array and check the heights make sense."""
    paths = [DEM_DIR / name for name in DEM_FILES]
    for path in paths:
        if not path.exists():
            raise FileNotFoundError(f"{path} is missing. Run: uv run data/download.py")
    sources = [rasterio.open(path) for path in paths]
    try:
        mosaic, transform = merge(sources)
        crs = sources[0].crs
    finally:
        for source in sources:
            source.close()
    dem_m = mosaic[0].astype("float32")
    if dem_m.min() < DEM_MIN_M or dem_m.max() > DEM_MAX_M:
        raise ValueError(f"DEM heights {dem_m.min()} to {dem_m.max()} m are outside the sane range")
    print(f"DEM mosaic {dem_m.shape[1]} x {dem_m.shape[0]} px, up to {dem_m.max():.0f} m")
    return dem_m, transform, crs


def encode_terrarium(height_m: np.ndarray) -> np.ndarray:
    """Pack heights into the three 8-bit colour channels of a PNG.

    Terrarium reads back as: height = R*256 + G + B/256 - 32768. So R holds the coarse steps of
    256 m, G the single metres and B the fractions. A PNG is lossless and every browser can decode
    it, which is why plain image tiles can carry elevation with no special file format.
    """
    stepped_m = np.round(height_m / ELEVATION_STEP_M) * ELEVATION_STEP_M
    value = np.round((stepped_m + 32768.0) * 256.0).astype(np.uint32)
    return np.dstack([(value >> 16) & 255, (value >> 8) & 255, value & 255]).astype(np.uint8)


def area_of_interest(basin: shapely.Geometry, stem_line: LineString) -> shapely.Geometry:
    """The basin and the whole Arno with a margin, as one smooth outline in AOI_CRS metres."""
    parts = gpd.GeoSeries([basin, stem_line], crs="EPSG:4326").to_crs(AOI_CRS)
    aoi_m = parts.buffer(AOI_BUFFER_M).union_all()
    aoi_m = aoi_m.buffer(AOI_ROUND_M).buffer(-AOI_ROUND_M).simplify(AOI_SIMPLIFY_M)
    if aoi_m.geom_type != "Polygon":
        raise ValueError(f"the area of interest should be one polygon, not a {aoi_m.geom_type}")
    aoi = gpd.GeoSeries([aoi_m], crs=AOI_CRS).to_crs("EPSG:4326").iloc[0]
    if not shapely.box(*EXTENT).contains(aoi):
        raise ValueError(f"the area of interest {aoi.bounds} leaves the work extent {EXTENT}")
    print(f"area of interest: {aoi_m.area / 1e6:,.0f} km², {len(aoi_m.exterior.coords)} vertices")
    return aoi_m


def relief_weight(
    bounds_m: tuple[float, float, float, float], edge: shapely.Geometry
) -> np.ndarray:
    """1 inside the relief, falling smoothly to 0 at the outline, for every pixel of a tile.

    edge is the outline of the area of interest in Web Mercator. Web Mercator stretches the ground
    by 1 / cos(latitude), so I multiply each distance by cos(latitude) to get real metres back.
    That is the scale factor every Mercator map carries, and here it is about 1.4.
    """
    west_m, _, east_m, north_m = bounds_m
    pixel_m = (east_m - west_m) / TILE_PX
    x_m = west_m + (np.arange(TILE_PX) + 0.5) * pixel_m
    y_m = north_m - (np.arange(TILE_PX) + 0.5) * pixel_m
    grid_x, grid_y = np.meshgrid(x_m, y_m)
    # The inverse Web Mercator formula: y runs up the page, and latitudes bunch up towards the poles.
    lat = 2.0 * np.arctan(np.exp(grid_y / MERCATOR_HALF_WORLD_M * np.pi)) - np.pi / 2.0
    weight = np.zeros((TILE_PX, TILE_PX), dtype="float32")
    inside = shapely.contains_xy(edge, grid_x, grid_y)
    if not inside.any():
        return weight
    points = shapely.points(grid_x[inside], grid_y[inside])
    ground_m = shapely.distance(points, edge.exterior) * np.cos(lat[inside])
    t = np.clip(ground_m / RELIEF_FEATHER_M, 0.0, 1.0)
    weight[inside] = t * t * (3.0 - 2.0 * t)  # smoothstep: no crease at either end
    return weight


def terrain_tiles(
    dem_m: np.ndarray,
    transform: rasterio.Affine,
    crs: object,
    aoi_m: shapely.Geometry,
    extent: tuple[float, float, float, float] = EXTENT,
    zooms: range = TERRAIN_ZOOMS,
) -> dict[tuple[int, int, int], bytes]:
    """Warp the DEM into every tile of the pyramid (zooms) that touches the extent.

    Returns {(z, x, y): lossless WebP bytes}.
    """
    west, south, east, north = extent
    # Tiles outside the outline are still written, flat at 0 m: they compress to almost nothing,
    # and MapLibre then never meets a missing tile inside the bounds it was given.
    edge = gpd.GeoSeries([aoi_m], crs=AOI_CRS).to_crs(TILE_CRS).iloc[0]
    shapely.prepare(edge)  # an index on the polygon, because every tile asks 65,536 questions
    tiles = {}
    for zoom in zooms:
        for x in range(lon_to_tile(west, zoom), lon_to_tile(east, zoom) + 1):
            for y in range(lat_to_tile(north, zoom), lat_to_tile(south, zoom) + 1):
                bounds = tile_bounds_m(x, y, zoom)
                # The array starts at zero and the source has no nodata value, so anything outside
                # the DEM mosaic simply stays at 0 m: flat paper.
                height_m = np.zeros((TILE_PX, TILE_PX), dtype="float32")
                reproject(
                    source=dem_m,
                    destination=height_m,
                    src_transform=transform,
                    src_crs=crs,
                    dst_transform=from_bounds(*bounds, TILE_PX, TILE_PX),
                    dst_crs=TILE_CRS,
                    resampling=Resampling.bilinear,
                )
                height_m *= relief_weight(bounds, edge)
                image = io.BytesIO()
                Image.fromarray(encode_terrarium(height_m), "RGB").save(
                    image, "WEBP", lossless=True, quality=100, method=6
                )
                tiles[(zoom, x, y)] = image.getvalue()
    print(f"terrain: {len(tiles)} tiles, z{zooms[0]} to z{zooms[-1]}")
    return tiles


def write_pmtiles(
    name: str,
    tiles: dict[tuple[int, int, int], bytes],
    tile_type: TileType,
    compression: Compression,
    bounds: tuple[float, float, float, float],
    metadata: dict,
) -> None:
    """Pack tiles into one PMTiles archive.

    PMTiles numbers every tile along a Hilbert curve (the tile ID) and keeps a directory from ID to
    byte offset at the front of the file. A reader fetches that directory once, then any tile with
    one range request. Writing in ID order keeps neighbouring tiles next to each other on disk.
    """
    zooms = sorted({z for z, _, _ in tiles})
    west, south, east, north = bounds
    header = {
        "tile_type": tile_type,
        "tile_compression": compression,
        "min_lon_e7": int(west * 1e7),
        "min_lat_e7": int(south * 1e7),
        "max_lon_e7": int(east * 1e7),
        "max_lat_e7": int(north * 1e7),
        "center_zoom": zooms[0],
        "center_lon_e7": int((west + east) / 2 * 1e7),
        "center_lat_e7": int((south + north) / 2 * 1e7),
    }
    with write_pmtiles_file(LAYERS_DIR / name) as writer:
        for (z, x, y), data in sorted(tiles.items(), key=lambda item: zxy_to_tileid(*item[0])):
            writer.write_tile(zxy_to_tileid(z, x, y), data)
        writer.finalize(header, metadata)
    size_mb = (LAYERS_DIR / name).stat().st_size / 1e6
    print(f"{name}: {len(tiles)} tiles, z{zooms[0]} to z{zooms[-1]}, {size_mb:.2f} MB")


def city_tile_box() -> tuple[float, float, float, float]:
    """The city box widened to whole tiles of its first zoom, a hair inside their outer edges.

    z12 tiles nest four to a z11 tile, so z12 then covers exactly the same rectangle.
    """
    zoom = CITY_TERRAIN_ZOOMS[0]
    west, south, east, north = CITY_TERRAIN_BOX
    x0, x1 = lon_to_tile(west, zoom), lon_to_tile(east, zoom) + 1
    y0, y1 = lat_to_tile(north, zoom), lat_to_tile(south, zoom) + 1
    w, s, e, n = *tile_bounds_m(x0, y1 - 1, zoom)[:2], *tile_bounds_m(x1 - 1, y0, zoom)[2:]
    lon = lambda x_m: x_m / MERCATOR_HALF_WORLD_M * 180.0
    lat = lambda y_m: np.degrees(
        2.0 * np.arctan(np.exp(y_m / MERCATOR_HALF_WORLD_M * np.pi)) - np.pi / 2.0
    )
    inset = 1e-6  # stay inside, so the next row or column of tiles is not counted
    return lon(w) + inset, float(lat(s)) + inset, lon(e) - inset, float(lat(n)) - inset


def round_geometry(geometry: shapely.Geometry) -> shapely.Geometry:
    """Round coordinates to COORD_DECIMALS, which alone halves the size of a GeoJSON file."""
    return shapely.transform(geometry, lambda xy: np.round(xy, COORD_DECIMALS))


def plain(value: object) -> object:
    """Turn a numpy number into a plain Python one, which is what JSON can write."""
    return value.item() if isinstance(value, np.generic) else value


def write_geojson(name: str, features: list[dict]) -> None:
    """Write a compact FeatureCollection: no spaces, because this file travels over the network."""
    collection = {"type": "FeatureCollection", "features": features}
    path = LAYERS_DIR / name
    path.write_text(json.dumps(collection, separators=(",", ":"), ensure_ascii=False))


def feature(geometry: shapely.Geometry, properties: dict) -> dict:
    return {
        "type": "Feature",
        "properties": {key: plain(value) for key, value in properties.items()},
        "geometry": mapping(round_geometry(geometry)),
    }


def write_contours(
    dem_m: np.ndarray, transform: rasterio.Affine, crs: object, aoi_m: shapely.Geometry
) -> list[tuple[shapely.Geometry, bool]]:
    """Draw 100 m contours inside the area of interest, thinned to fit in a few megabytes.

    Writes contours.geojson (the download) and returns [(lines in EPSG:4326, is index contour)]
    for the vector tiles.
    """
    # I only grid the box around the outline: the contours outside it would be cut off anyway.
    bounds_m = aoi_m.bounds
    width_px = int((bounds_m[2] - bounds_m[0]) / CONTOUR_PIXEL_M)
    height_px = int((bounds_m[3] - bounds_m[1]) / CONTOUR_PIXEL_M)
    coarse_m = np.full((height_px, width_px), np.nan, dtype="float32")
    # Averaging 30 m pixels into 90 m ones removes most radar noise from forest and buildings.
    # Contours from the raw 30 m surface look nervous and take many times the bytes.
    reproject(
        source=dem_m,
        destination=coarse_m,
        src_transform=transform,
        src_crs=crs,
        src_nodata=-32767.0,
        dst_transform=from_origin(bounds_m[0], bounds_m[3], CONTOUR_PIXEL_M, CONTOUR_PIXEL_M),
        dst_crs=CONTOUR_CRS,
        dst_nodata=np.nan,
        resampling=Resampling.average,
    )
    x_m = bounds_m[0] + (np.arange(width_px) + 0.5) * CONTOUR_PIXEL_M
    y_m = bounds_m[3] - (np.arange(height_px) + 0.5) * CONTOUR_PIXEL_M
    top_m = int(np.nanmax(coarse_m) // CONTOUR_INTERVAL_M) * CONTOUR_INTERVAL_M
    levels_m = list(range(CONTOUR_INTERVAL_M, top_m + 1, CONTOUR_INTERVAL_M))

    figure_, axes = plt.subplots()
    # Masking stops matplotlib from drawing false contours along the edge of the data.
    contours = axes.contour(x_m, y_m, np.ma.masked_invalid(coarse_m), levels=levels_m)
    plt.close(figure_)

    features = []
    levels = []
    shapely.prepare(aoi_m)
    bridge_m = gpd.GeoSeries([kf.PONTE_VECCHIO], crs="EPSG:4326").to_crs(CONTOUR_CRS).iloc[0]
    city_area = bridge_m.buffer(CITY_RADIUS_M)
    for elev_m, path in zip(levels_m, contours.get_paths(), strict=True):
        lines = []
        for points in path.to_polygons(closed_only=False):
            if len(points) < 2:
                continue
            line = LineString(points)
            if line.length >= CONTOUR_MIN_LENGTH_M:
                # Simplifying in metres, before going back to degrees, keeps the tolerance honest.
                line = line.simplify(CONTOUR_SIMPLIFY_M)
                if line.intersects(city_area):
                    coords = chaikin(np.asarray(line.coords), CITY_CONTOUR_CHAIKIN_PASSES)
                    line = LineString(coords)
                lines.append(line)
        if not lines:
            continue
        # I cut along the outline in metres, where the outline was drawn, then go back to degrees.
        clipped_m = MultiLineString(lines).intersection(aoi_m)
        if clipped_m.is_empty:
            continue
        geometry = gpd.GeoSeries([clipped_m], crs=CONTOUR_CRS).to_crs("EPSG:4326").iloc[0]
        # One feature per level, not per line: the properties are written once, not 100,000 times.
        properties = {"elev_m": elev_m, "index": elev_m % CONTOUR_INDEX_M == 0}
        features.append(feature(geometry, properties))
        levels.append((geometry, properties["index"]))
    write_geojson("contours.geojson", features)
    print(f"contours: {len(features)} levels, {levels_m[0]} to {levels_m[-1]} m")
    return levels


def contour_tiles(levels: list[tuple[shapely.Geometry, bool]]) -> dict[tuple[int, int, int], bytes]:
    """Cut the contours into Mapbox Vector Tiles, one simplification per zoom.

    Each tile gets two features at most, the plain and the index contours, as multi-lines: the
    map styles only by "index", so every other property would be bytes for nothing. Tiles are
    gzipped, as the PMTiles spec expects for vector tiles.
    """
    lines_m, flags = [], []
    for geometry, is_index in levels:
        projected = gpd.GeoSeries([geometry], crs="EPSG:4326").to_crs(TILE_CRS).iloc[0]
        for part in shapely.get_parts(projected):
            lines_m.append(part)
            flags.append(is_index)
    lines_m, flags = np.array(lines_m), np.array(flags)
    west, south, east, north = shapely.total_bounds(
        gpd.GeoSeries(lines_m, crs=TILE_CRS).to_crs("EPSG:4326").values
    )
    tiles = {}
    for zoom in CONTOUR_TILE_ZOOMS:
        tile_m = 2 * MERCATOR_HALF_WORLD_M / 2**zoom
        tolerance_m = CONTOUR_TOLERANCE_PX * tile_m / CONTOUR_TILE_PX
        buffer_m = CONTOUR_BUFFER_PX * tile_m / CONTOUR_TILE_PX
        simplified = shapely.simplify(lines_m, tolerance_m, preserve_topology=False)
        tree = shapely.STRtree(simplified)
        for x in range(lon_to_tile(west, zoom), lon_to_tile(east, zoom) + 1):
            for y in range(lat_to_tile(north, zoom), lat_to_tile(south, zoom) + 1):
                bounds = tile_bounds_m(x, y, zoom)
                box = (
                    bounds[0] - buffer_m,
                    bounds[1] - buffer_m,
                    bounds[2] + buffer_m,
                    bounds[3] + buffer_m,
                )
                hits = tree.query(shapely.box(*box))
                if len(hits) == 0:
                    continue
                features = []
                for is_index in (False, True):
                    chosen = hits[flags[hits] == is_index]
                    clipped = shapely.clip_by_rect(simplified[chosen], *box)
                    parts = [
                        line
                        for line in shapely.get_parts(clipped)
                        if line.geom_type == "LineString" and not line.is_empty
                    ]
                    if parts:
                        features.append(
                            {"geometry": MultiLineString(parts), "properties": {"index": is_index}}
                        )
                if features:
                    tile = encode_mvt(
                        [{"name": "contours", "features": features}],
                        default_options={"quantize_bounds": bounds, "extents": MVT_EXTENT},
                    )
                    tiles[(zoom, x, y)] = gzip.compress(tile, mtime=0)
    return tiles


def reach_features(
    reaches: gpd.GeoDataFrame, stem_ids: set[int], with_length: bool = False
) -> list[dict]:
    """One GeoJSON feature per river reach, with only the fields the map styles and queries.

    Every field is repeated in every reach, so an unused one costs bytes on every load. The reach
    length is kept only for the Arno, whose reaches are summed into its length.
    """
    features = []
    for row in reaches.itertuples():
        properties = {
            "HYRIV_ID": row.HYRIV_ID,
            "NEXT_DOWN": row.NEXT_DOWN,
            "UPLAND_SKM": row.UPLAND_SKM,
            "dist_to_florence_km": round(float(row.dist_to_florence_km), 1),
            # Above a certain zoom the map draws a smoothed Arno, so the raw reach must step aside.
            "main_stem": row.HYRIV_ID in stem_ids,
        }
        if with_length:
            properties["LENGTH_KM"] = row.LENGTH_KM
        features.append(feature(row.geometry, properties))
    return features


def stem_in_flow_order(rivers: gpd.GeoDataFrame, stem: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Put the main stem reaches in order from the spring to the sea.

    arno_main_stem() returns the reaches in file order, which is arbitrary. To draw the river as
    one line I need the graph order: start at the reach nobody else on the stem drains into.
    """
    by_id = stem.set_index("HYRIV_ID")
    feeds = set(by_id["NEXT_DOWN"])
    start = [reach_id for reach_id in by_id.index if reach_id not in feeds]
    if len(start) != 1:
        raise ValueError(f"expected one upstream end of the Arno, found {len(start)}")
    ordered = []
    current = start[0]
    while current != 0:
        ordered.append(current)
        current = int(by_id.loc[current, "NEXT_DOWN"])
    return by_id.loc[ordered].reset_index().set_crs(rivers.crs, allow_override=True)


def chaikin(coords: np.ndarray, passes: int) -> np.ndarray:
    """Round a polyline by repeatedly cutting its corners.

    Each pass replaces every segment by points at 1/4 and 3/4 of its length. I use it for the
    contours around the city, where the 90 m grid would otherwise show as corners. It keeps long
    straight runs straight, which is why the Arno gets a Gaussian instead (smooth_display_line).
    """
    for _ in range(passes):
        q = 0.75 * coords[:-1] + 0.25 * coords[1:]
        r = 0.25 * coords[:-1] + 0.75 * coords[1:]
        cut = np.empty((q.shape[0] * 2, 2))
        cut[0::2], cut[1::2] = q, r
        coords = np.vstack([coords[0], cut, coords[-1]])  # keep the spring and the mouth fixed
    return coords


def bend_through_bridge(coords: np.ndarray) -> np.ndarray:
    """Bend the display line so that it passes through Ponte Vecchio.

    The bridge is a real position and the river line is a coarse model, so at city zoom the dot
    would sit beside the river. I move the nearest vertex onto the bridge and let its neighbours
    follow with a bell curve, which leaves no kink. Like the smoothing, this is for display only:
    the line that the 241 km is measured on is never touched.
    """
    km_per_deg = np.array([111.32 * np.cos(np.radians(kf.PONTE_VECCHIO.y)), 110.57])
    bridge = np.array([kf.PONTE_VECCHIO.x, kf.PONTE_VECCHIO.y])
    nearest = int(np.argmin(np.hypot(*((coords - bridge) * km_per_deg).T)))
    miss = bridge - coords[nearest]
    miss_km = float(np.hypot(*(miss * km_per_deg)))
    if miss_km > MAX_BRIDGE_MISS_KM:
        raise ValueError(f"the Arno line misses Ponte Vecchio by {miss_km:.2f} km")
    steps_km = np.hypot(*(np.diff(coords, axis=0) * km_per_deg).T)
    along_km = np.concatenate([[0.0], np.cumsum(steps_km)])
    weight = np.exp(-(((along_km - along_km[nearest]) / BRIDGE_BEND_KM) ** 2))
    print(f"display Arno bent by {miss_km * 1000:.0f} m to pass through Ponte Vecchio")
    return coords + weight[:, None] * miss


def smooth_display_line(line: LineString) -> np.ndarray:
    """A smooth Arno for display: resampled every 100 m and averaged with a 700 m Gaussian.

    I work in UTM metres, so the smoothing is equally strong in both directions. The ends stay
    where they are (spring and mouth), and the length of the river is still measured on the raw
    reaches, never on this line.
    """
    line_m = gpd.GeoSeries([line], crs="EPSG:4326").to_crs(kf.LENGTH_CRS).iloc[0]
    steps = np.arange(0, line_m.length, DISPLAY_SPACING_M)
    points = np.array([line_m.interpolate(d).coords[0] for d in [*steps, line_m.length]])
    half = int(3 * DISPLAY_SIGMA_M / DISPLAY_SPACING_M)
    offsets = np.arange(-half, half + 1) * DISPLAY_SPACING_M
    kernel = np.exp(-0.5 * (offsets / DISPLAY_SIGMA_M) ** 2)
    kernel /= kernel.sum()
    # Mirror the line at both ends before averaging, so the ends do not get pulled inwards.
    padded = np.vstack(
        [2 * points[0] - points[half:0:-1], points, 2 * points[-1] - points[-2 : -half - 2 : -1]]
    )
    smooth = np.column_stack([np.convolve(padded[:, i], kernel, mode="valid") for i in range(2)])
    smooth[0], smooth[-1] = points[0], points[-1]
    back = gpd.GeoSeries([LineString(smooth)], crs=kf.LENGTH_CRS).to_crs("EPSG:4326").iloc[0]
    return np.asarray(back.coords)


def merged_stem_line(stem: gpd.GeoDataFrame) -> LineString:
    """Join the ordered reaches into one line, checking that each one starts where the last ended."""
    coords = list(stem.geometry.iloc[0].coords)
    for line in stem.geometry.iloc[1:]:
        points = list(line.coords)
        if points[0] != coords[-1]:
            raise ValueError("the main stem reaches do not connect end to start")
        coords.extend(points[1:])
    return LineString(coords)


def network_km(reaches: gpd.GeoDataFrame) -> float:
    """Total length of a river network in km, measured in UTM like the Arno's 241 km.

    I measure the geometry as written, not the LENGTH_KM field: the downstream reaches are cut at
    the outline, and a cut reach is shorter than HydroRIVERS says.
    """
    return float(reaches.to_crs(kf.LENGTH_CRS).length.sum()) / 1e3


def write_meta(upstream_km: float, downstream_km: float) -> None:
    """Write when each dataset was fetched, and how long the two river networks are.

    The dates are the last line of About this map. sources.json lists every downloaded file; the
    nine DEM tiles are one dataset, so I group the files by dataset and keep the latest day any of
    its files was fetched. The lengths go next to the river entries in the Layers list.
    """
    if not SOURCES_JSON.exists():
        raise FileNotFoundError(f"{SOURCES_JSON} is missing. Run: uv run data/download.py")
    fetched: dict[str, str] = {}
    for source in json.loads(SOURCES_JSON.read_text()):
        if not source.get("downloaded"):
            raise ValueError(f"{source['file']} has no download date. Run: uv run data/download.py")
        # "Copernicus DEM GLO-30 tile N42 E010" -> "Copernicus DEM GLO-30"
        dataset = source["name"].split(" tile ")[0]
        fetched[dataset] = max(fetched.get(dataset, ""), source["downloaded"])
    meta = {
        "sources": [{"name": name, "downloaded": day} for name, day in fetched.items()],
        "network_km": {
            "upstream_rivers": round(upstream_km, 1),
            "downstream_rivers": round(downstream_km, 1),
        },
    }
    (LAYERS_DIR / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n")
    print(f"meta: {len(fetched)} datasets, fetched {', '.join(sorted(set(fetched.values())))}")
    print(f"networks: {upstream_km:,.1f} km upstream, {downstream_km:,.1f} km downstream")


def write_points(display_line: LineString) -> None:
    falterona = (kf.ARNO_SPRING.x, kf.ARNO_SPRING.y)
    vecchio = (kf.PONTE_VECCHIO.x, kf.PONTE_VECCHIO.y)
    # The river's own name sits on the drawn line, in the Cascine stretch west of the bridge, where
    # the city close-ups have room for it.
    cascine = display_line.intersection(
        shapely.LineString([(ARNO_LABEL_LON, 43.6), (ARNO_LABEL_LON, 43.9)])
    )
    if cascine.geom_type != "Point":
        raise ValueError(f"the Arno crosses {ARNO_LABEL_LON} E more than once: {cascine.geom_type}")
    points = [
        ("ponte_vecchio", "Ponte Vecchio", "bridge", vecchio),
        ("arno_spring", "Arno spring", "spring", falterona),
        ("pisa", "Pisa", "label", PISA),
        ("casentino", "Casentino", "label", (11.80, 43.75)),
        ("mugello", "Mugello", "label", (11.40, 43.98)),
        ("monte_falterona", "Monte Falterona", "label", falterona),
        ("firenze", "Firenze", "label", vecchio),
        ("arno", "Arno", "label", (cascine.x, cascine.y)),
    ]
    features = [
        feature(shapely.Point(xy), {"id": point_id, "label": label, "kind": kind})
        for point_id, label, kind, xy in points
    ]
    write_geojson("points.geojson", features)


def write_halftone() -> None:
    """A tileable dot screen at 45 degrees, the way 1960s newspapers printed a grey tone.

    One tile holds four cells of two dots each: one at the cell's corner and one at its centre,
    so the rows of dots run diagonally. Print screens were turned that way because the eye notices
    horizontal rows far more than diagonal ones. On the 3D terrain the fill is draped as a texture
    and comes out about four times larger on screen, so the dots have to start out this small to
    read as a newspaper screen rather than as polka dots. Drawing at 8 times the size and shrinking
    gives them a soft, anti-aliased edge. The grid fits the tile exactly, so it repeats seamlessly.
    """
    size = HALFTONE_PX * HALFTONE_SUPERSAMPLE
    y, x = np.mgrid[0:size, 0:size] / HALFTONE_SUPERSAMPLE + 0.5 / HALFTONE_SUPERSAMPLE
    # Measured from the nearest lattice point, on both interlaced grids.
    half_cell_px = HALFTONE_CELL_PX / 2

    def lattice_distance_px(offset_px: float) -> np.ndarray:
        dx = (x - offset_px + half_cell_px) % HALFTONE_CELL_PX - half_cell_px
        dy = (y - offset_px + half_cell_px) % HALFTONE_CELL_PX - half_cell_px
        return np.hypot(dx, dy)

    inside = (lattice_distance_px(0.0) <= HALFTONE_DOT_RADIUS_PX) | (
        lattice_distance_px(half_cell_px) <= HALFTONE_DOT_RADIUS_PX
    )
    alpha = inside.reshape(
        HALFTONE_PX, HALFTONE_SUPERSAMPLE, HALFTONE_PX, HALFTONE_SUPERSAMPLE
    ).mean(axis=(1, 3))
    rgba = np.zeros((HALFTONE_PX, HALFTONE_PX, 4), dtype=np.uint8)
    rgba[..., :3] = PIENA_RGB
    rgba[..., 3] = np.round(alpha * 255).astype(np.uint8)
    Image.fromarray(rgba, "RGBA").save(LAYERS_DIR / "halftone.png", optimize=True)


def write_paper() -> None:
    """A tileable paper grain made from seeded noise, so no texture image has to be downloaded.

    I shape random numbers in frequency space: a Fourier transform treats an image as periodic, so
    the result wraps around seamlessly with no seam to hide. Weighting the low frequencies more
    gives the soft blotches of paper fibre instead of the hard speckle of plain noise.
    """
    rng = np.random.default_rng(PAPER_SEED)
    noise = rng.standard_normal((PAPER_PX, PAPER_PX))
    freq_y = np.fft.fftfreq(PAPER_PX)[:, None]
    freq_x = np.fft.rfftfreq(PAPER_PX)[None, :]
    radius = np.hypot(freq_y, freq_x)
    radius[0, 0] = radius[0, 1]  # no division by zero at the mean
    grain = np.fft.irfft2(np.fft.rfft2(noise) / radius**0.6, s=noise.shape)
    grain = (grain - grain.mean()) / grain.std()
    alpha = np.clip(0.5 + grain / 5.0, 0.0, 1.0)
    rgba = np.zeros((PAPER_PX, PAPER_PX, 4), dtype=np.uint8)
    rgba[..., :3] = INCHIOSTRO_RGB
    rgba[..., 3] = np.round(alpha * 255).astype(np.uint8)
    image = Image.fromarray(rgba, "RGBA")
    # The map loads the WebP: lossless, so not one grain changes, and about 30 % smaller.
    image.save(LAYERS_DIR / "paper.webp", "WEBP", lossless=True, quality=100, method=6)
    image.save(LAYERS_DIR / "paper.png", optimize=True)


def read_key_figures() -> dict[str, dict]:
    """Load the published figures and stop if any display text is not the expected one."""
    if not KEY_FIGURES_JSON.exists():
        raise FileNotFoundError(f"{KEY_FIGURES_JSON} is missing. Run: uv run data/key_figures.py")
    figures = {entry["id"]: entry for entry in json.loads(KEY_FIGURES_JSON.read_text())}
    for fig_id, display in EXPECTED_DISPLAY.items():
        if figures[fig_id]["display"] != display:
            raise ValueError(f"{fig_id}: display {figures[fig_id]['display']!r}, not {display!r}")
    return figures


def check_figures(basin: shapely.Geometry, stem: gpd.GeoDataFrame, figures: dict) -> None:
    """Measure the layers as written and compare them with the published numbers.

    I round the coordinates first, then measure, so this checks the geometry a reader downloads.
    """
    area_m2 = gpd.GeoSeries([round_geometry(basin)], crs="EPSG:4326").to_crs(kf.AREA_CRS).area
    area_km2 = float(area_m2.iloc[0]) / 1e6
    rounded_stem = stem.geometry.map(round_geometry).set_crs("EPSG:4326", allow_override=True)
    length_km = float(rounded_stem.to_crs(kf.LENGTH_CRS).length.sum()) / 1e3
    area_display = f"{round(area_km2, -2):,.0f} km²"
    length_display = f"{round(length_km):.0f} km"
    if area_display != figures["basin_area"]["display"]:
        raise ValueError(f"basin polygon rounds to {area_display}")
    if length_display != figures["arno_length"]["display"]:
        raise ValueError(f"main stem rounds to {length_display}")
    if abs(area_km2 - figures["basin_area"]["value"]) > 0.5:
        raise ValueError(f"basin polygon {area_km2:.1f} km² differs from key_figures.json")
    if abs(length_km - figures["arno_length"]["value"]) > 0.1:
        raise ValueError(f"main stem {length_km:.1f} km differs from key_figures.json")
    print(f"checked: basin {area_km2:.1f} km² = {area_display}, Arno {length_km:.1f} km")


def main() -> None:
    figures = read_key_figures()
    LAYERS_DIR.mkdir(exist_ok=True)

    basins = kf.read_layer(kf.BASINS_SHP)
    rivers = kf.read_layer(kf.RIVERS_SHP)

    # The basin: I dissolve the units, so the shared edges inside it disappear.
    units = kf.basin_upstream_of_florence(basins)
    if len(units) != EXPECTED_BASIN_UNITS:
        raise ValueError(f"expected {EXPECTED_BASIN_UNITS} basin units, found {len(units)}")
    basin = units.union_all()
    write_geojson("basin.geojson", [feature(basin, {"name": "Basin upstream of Ponte Vecchio"})])

    # wash_order: the kilometres along the network from a unit's outlet down to the Florence unit.
    # DIST_MAIN counts from the sea, so subtracting Florence's value restarts the count at the city.
    florence_id = int(units[units.contains(kf.PONTE_VECCHIO)]["HYBAS_ID"].iloc[0])
    florence_dist_km = float(units.set_index("HYBAS_ID").loc[florence_id, "DIST_MAIN"])
    unit_features = [
        feature(
            row.geometry,
            {"HYBAS_ID": row.HYBAS_ID, "wash_order": round(row.DIST_MAIN - florence_dist_km, 1)},
        )
        for row in units.itertuples()
    ]
    write_geojson("basin_units.geojson", unit_features)

    # Rivers. DIST_DN_KM counts down to the sea, so subtracting the Florence reach's value gives
    # the distance to the bridge. Below the bridge it goes negative: that water has already passed.
    florence_reach_id = kf.florence_reach(rivers)
    by_id = rivers.set_index("HYRIV_ID")
    florence_dist_dn_km = float(by_id.loc[florence_reach_id, "DIST_DN_KM"])
    rivers = rivers.assign(dist_to_florence_km=rivers["DIST_DN_KM"] - florence_dist_dn_km)
    next_down = rivers.set_index("HYRIV_ID")["NEXT_DOWN"]

    # Quirk to watch: HYBAS_L12 assigns each reach to a basin unit, and NEXT_DOWN links the reaches
    # to each other. Two independent routes to "inside the basin", so I insist they agree.
    upstream_ids = kf.upstream_ids(florence_reach_id, next_down)
    in_units = set(rivers.loc[rivers["HYBAS_L12"].isin(units["HYBAS_ID"]), "HYRIV_ID"])
    if upstream_ids != in_units:
        raise ValueError(
            f"river graph and basin units disagree on {len(upstream_ids ^ in_units)} reaches"
        )
    upstream = rivers[rivers["HYRIV_ID"].isin(upstream_ids)]

    # The main stem. Quirk: HydroRIVERS' own main path upstream of Arezzo turns into the Val di
    # Chiana, because in the data it drains more than the upper Arno. That is why the Arno is
    # traced down from its spring on Monte Falterona and not up from its mouth.
    stem_raw = kf.arno_main_stem(rivers)
    if len(stem_raw) != EXPECTED_STEM_REACHES:
        raise ValueError(f"expected {EXPECTED_STEM_REACHES} main stem reaches, got {len(stem_raw)}")
    stem = stem_in_flow_order(rivers, stem_raw)
    stem_ids = set(stem["HYRIV_ID"])

    # Below Florence: everything that drains to the same sea outlet but not through the bridge.
    mouth_id = int(stem["HYRIV_ID"].iloc[-1])
    network_ids = kf.upstream_ids(mouth_id, next_down)
    downstream = rivers[rivers["HYRIV_ID"].isin(network_ids - upstream_ids)]
    stem_line = merged_stem_line(stem)
    # The tributaries below Florence reach far beyond the Arno (the Elsa almost to Siena). I cut
    # them at the outline, so no river runs out over the blank paper where the relief has ended.
    aoi_m = area_of_interest(basin, stem_line)
    aoi = gpd.GeoSeries([aoi_m], crs=AOI_CRS).to_crs("EPSG:4326").iloc[0]
    downstream = gpd.clip(downstream, aoi)

    write_geojson("rivers_upstream.geojson", reach_features(upstream, stem_ids))
    write_geojson("rivers_downstream.geojson", reach_features(downstream, stem_ids))
    write_geojson("arno.geojson", reach_features(stem, stem_ids, with_length=True))

    display_line = LineString(bend_through_bridge(smooth_display_line(stem_line)))
    write_geojson("arno_display.geojson", [feature(display_line, {"name": "Arno"})])
    print(
        f"rivers: {len(upstream)} upstream, {len(downstream)} downstream, "
        f"{len(stem)} on the main stem; furthest reach "
        f"{upstream['dist_to_florence_km'].max():.1f} km from the bridge"
    )
    check_figures(basin, stem, figures)

    write_points(display_line)
    write_meta(network_km(upstream), network_km(downstream))
    write_halftone()
    write_paper()
    (LAYERS_DIR / "key_figures.json").write_text(
        json.dumps(list(figures.values()), indent=2, ensure_ascii=False) + "\n"
    )

    dem_m, transform, crs = read_dem()
    levels = write_contours(dem_m, transform, crs, aoi_m)
    write_pmtiles(
        CONTOURS_PMTILES,
        contour_tiles(levels),
        TileType.MVT,
        Compression.GZIP,
        EXTENT,
        {"vector_layers": [{"id": "contours", "fields": {"index": "Boolean"}}]},
    )
    # The whole relief pyramid and the sharper city zooms go into one archive. The map keeps
    # them apart by zoom and bounds, as it did when they were two folders.
    tiles = terrain_tiles(dem_m, transform, crs, aoi_m)
    tiles |= terrain_tiles(dem_m, transform, crs, aoi_m, city_tile_box(), CITY_TERRAIN_ZOOMS)
    write_pmtiles(TERRAIN_PMTILES, tiles, TileType.WEBP, Compression.NONE, EXTENT, {})
    # The tile folders of earlier versions of this script, if they are still here.
    for old in ("terrain", "terrain_city"):
        shutil.rmtree(LAYERS_DIR / old, ignore_errors=True)

    total_bytes = 0
    for path in sorted(LAYERS_DIR.iterdir()):
        if path.is_dir():
            size_bytes = sum(item.stat().st_size for item in path.rglob("*") if item.is_file())
        else:
            size_bytes = path.stat().st_size
        total_bytes += size_bytes
        print(f"  {path.name:<28}{size_bytes / 1e6:>8.2f} MB")
    print(f"  {'total':<28}{total_bytes / 1e6:>8.2f} MB")
    if total_bytes > MAX_LAYERS_MB * 1e6:
        raise ValueError(f"maps/layers/ is over the {MAX_LAYERS_MB} MB limit")


if __name__ == "__main__":
    main()
