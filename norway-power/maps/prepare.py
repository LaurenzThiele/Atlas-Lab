"""Turn the raw downloads into the small layers the 3D model of Norway loads.

What it does: I put everything on one grid in EPSG:25833 (ETRS89 / UTM zone 33N, metres), the
national projection of Norway, and write five things the browser needs: the heights of the
mainland as a Terrarium PNG, a baked relief texture, the hydropower plants in the order they
light up, the 300 and 420 kV lines in the order they draw, and scene.json with the camera of
every beat and the figures the scene needs.
Reads:  data/raw/ (run data/download.py first) and data/key_figures.json
Writes: maps/layers/heights.png, relief.webp, plants.json, lines.json, scene.json, meta.json
Run:    uv run maps/prepare.py   (from the piece folder)

What you learn: how a long, thin country is put on one flat grid without bending it, how a
fine elevation model is averaged down to the cell size a browser can carry, and how a draw
order can tell a story (the network grows outward from the power plants).

This is the template for the "Infrastructure" series: change the PLACE settings (country, CRS,
grid, label points, cameras) and the layer filters, and the rest stays the same.
"""

import json
from datetime import date
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
import shapely
from PIL import Image
from pyproj import Geod, Transformer
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform_bounds
from scipy.ndimage import distance_transform_edt
from scipy.spatial import cKDTree
from shapely import line_merge
from shapely.geometry import LineString, MultiLineString, box

HERE = Path(__file__).parent
PIECE = HERE.parent
RAW_DIR = PIECE / "data" / "raw"
DEM_DIR = RAW_DIR / "copernicus_dem_90"
GPPD_CSV = RAW_DIR / "global_power_plant_database_v_1_3" / "global_power_plant_database.csv"
NE_ZIP = RAW_DIR / "ne_10m_admin_0_countries.zip"
LINES_JSON = RAW_DIR / "osm_power_lines_norway_100kv.json"
CITIES_JSON = RAW_DIR / "osm_cities_norway.json"
SOURCES_JSON = RAW_DIR / "sources.json"
KEY_FIGURES = PIECE / "data" / "key_figures.json"
OUT_DIR = HERE / "layers"

# ---------------------------------------------------------------- the place
COUNTRY_ISO3 = "NOR"
NEIGHBOURS_ISO3 = ["SWE", "FIN", "RUS", "DNK"]
# Mainland only: this box cuts Svalbard and Jan Mayen off the Natural Earth polygon.
MAINLAND_BOX = box(0.0, 57.0, 32.0, 71.5)
# EPSG:25833, ETRS89 / UTM zone 33N. It is the projection Norway's mapping agency uses for the
# whole country: one transverse Mercator strip centred on 15 E, so the long country keeps its
# true shape and its distances to within about 0.1 % in the south, far better than Web Mercator,
# which would draw Hammerfest (70.7 N) about 50 % larger than Kristiansand (58.1 N).
CRS = "EPSG:25833"
CENTRAL_MERIDIAN_DEG = 15  # of UTM zone 33, for turning grid metres back into degrees
PAGE_TYPE = "data-draw"
# The grid of the model, in metres in EPSG:25833: the extent the storyboard was drawn in.
GRID_X_M = (-120_000, 1_150_000)
GRID_Y_M = (6_400_000, 7_980_000)
HEIGHT_CELL_M = 1_000  # heights.png: the mesh and the click readings
TEXTURE_CELL_M = 500  # relief.webp: the baked colour on top of the mesh

# ---------------------------------------------------------------- the look
INK = (15 / 255, 20 / 255, 26 / 255)  # #0F141A, the background and the sea
HEIGHT_RAMP = ["#141c26", "#22324a", "#3a5677", "#6f8fb3", "#c9d6e6"]
RAMP_DOMAIN_M = (0, 1_900)
RAMP_GAMMA = 0.7  # lifts the lowlands so the valleys separate from the sea
RAMP_START = 0.18  # sea level starts a little up the ramp, so the land never melts into the sea
LIGHT_AZIMUTH_DEG = 315  # the cartographer's light from the north-west
LIGHT_ALTITUDE_DEG = 40
SHADE_EXAGGERATION = 2  # heights doubled for the shading only, so the relief reads from above
NEIGHBOUR_RGB = (0.16, 0.21, 0.28)  # a flat slate silhouette
NEIGHBOUR_FADE_KM = 100
NEIGHBOUR_STRENGTH = 0.35
WEBP_QUALITY = 90

# ---------------------------------------------------------------- the data layers
LINE_KV = (300, 420)
LAND_BUFFER_DEG = 0.02  # about 2 km, keeps the short spans that hop between islands
LINE_SIMPLIFY_M = 100
EXPECTED_HYDRO_PLANTS = 291
# Two city labels. The Overpass file holds their tags only (out tags), so the points come from
# the OpenStreetMap nodes' own coordinates, written here; the script checks that both nodes are
# in the file as place=city.
CITIES = {
    "Oslo": {"osm_node": 20981158, "lat": 59.9133, "lon": 10.7390},
    "Bergen": {"osm_node": 21261083, "lat": 60.3943, "lon": 5.3259},
}
# The largest plant, from data/key_figures.json's method line.
KVILLDAL = {"lat": 59.5118, "lon": 6.5846}

# ---------------------------------------------------------------- the camera tracks and the page
# Cameras in MapLibre terms (centre lon/lat, zoom with 512 px tiles, pitch, bearing), as the
# storyboard was planned. I add the centre in EPSG:25833 and the width of the 1080 px frame in
# km at the centre, which is what the 3D scene uses.
FPS = 30
LENGTH_S = 15.5
FRAMES = 465
FRAME_PX = (1080, 1920)
HERO_FRAME = 30
HOOK = {"centre": [14.5757, 65.0133], "zoom": 4.73, "pitch": 0, "bearing": 0, "fit": "hook"}
JOTUNHEIMEN = {
    "centre": [8.2, 61.25],
    "zoom": 6.82,
    "pitch": 58,
    "bearing": 20,
    "fit": "jotunheimen",
}
WIDE = {"centre": [10.5, 63.2], "zoom": 5.91, "pitch": 55, "bearing": 22, "fit": "wide"}
# The planned centres are Web Mercator midpoints, but the storyboard was drawn on the UTM grid,
# so its frames are not centred on them: the hook frame's middle lies about 305 km further north.
# I fitted the centre (EPSG:25833 metres) and the frame width at each planned zoom so the 3D
# frames put the same places where the storyboard does: the mainland from y 627 to 1799 and
# x 108 to 1045 in the hook, the summit at 61.6358 N 8.3133 E at x 560, y 880 in
# Jotunheimen, and Kvilldal at
# x 395, y 960 (bearing 22), Oslo at 795, 846 and Bergen at 283, 897 (bearing 26) in the wide
# view. The camera orbits around the fitted centre, so the subject stays put while it turns.
FRAME_FIT = {
    "hook": {"xy": [481_005, 7_515_813], "width_km": 1360.9, "zoom": 4.73},
    "jotunheimen": {"xy": [126_914, 6_819_121], "width_km": None, "zoom": 6.82},
    "wide": {"xy": [84_641, 6_609_259], "width_km": 603.0, "zoom": 5.91},
}
EXAGGERATION = {"hook": 0, "relief": 4, "wide": 9}
BEATS = [
    {
        "id": "hook",
        "start_s": 0.0,
        "end_s": 2.0,
        "ease": "none",
        "camera": {"from": HOOK, "to": {**HOOK, "zoom": 4.78}},
        "layers": ["relief_90m_flat", "neighbour_fade"],
    },
    {
        "id": "relief",
        "start_s": 2.0,
        "end_s": 4.5,
        "ease": "power2.inOut",
        "camera": {"from": HOOK, "to": JOTUNHEIMEN},
        "layers": ["relief_90m", "neighbour_fade", "top_fade"],
    },
    {
        "id": "plants",
        "start_s": 4.5,
        "end_s": 8.0,
        "ease": "power2.inOut",
        "camera": {"from": JOTUNHEIMEN, "to": WIDE},
        "layers": ["relief_90m", "neighbour_fade", "top_fade", "hydro_plants"],
    },
    {
        "id": "lines",
        "start_s": 8.0,
        "end_s": 11.5,
        "ease": "power2.inOut",
        "camera": {"from": WIDE, "to": {**WIDE, "bearing": 26}},
        "layers": [
            "relief_90m",
            "neighbour_fade",
            "top_fade",
            "hydro_plants",
            "lines_300_420kv",
            "cities",
        ],
    },
    {
        "id": "number",
        "start_s": 11.5,
        "end_s": 14.0,
        "ease": "power2.inOut",
        "camera": {"from": {**WIDE, "bearing": 26}, "to": {**WIDE, "bearing": 30}},
        "layers": ["relief_90m", "neighbour_fade", "top_fade", "hydro_plants", "lines_300_420kv"],
    },
    {
        "id": "end",
        "start_s": 14.0,
        "end_s": 15.5,
        "ease": "power2.inOut",
        "camera": {"from": {**WIDE, "bearing": 30}, "to": HOOK},
        "layers": ["relief_90m", "neighbour_fade", "wash_ink_75"],
    },
]
# The scripted camera track: one value from A to B between two times. The scene reads them as
# uniforms.
CAMERA_TWEENS = [
    {
        "target": "exaggeration",
        "from": 0,
        "to": 4,
        "start_s": 2.0,
        "end_s": 4.5,
        "ease": "power2.inOut",
    },
    {
        "target": "exaggeration",
        "from": 4,
        "to": 9,
        "start_s": 4.5,
        "end_s": 8.0,
        "ease": "power2.inOut",
    },
    {
        "target": "exaggeration",
        "from": 9,
        "to": 0,
        "start_s": 14.0,
        "end_s": 15.5,
        "ease": "power2.inOut",
    },
    {"target": "cities", "from": 0, "to": 1, "start_s": 10.0, "end_s": 10.2, "ease": "none"},
    {"target": "cities", "from": 1, "to": 0, "start_s": 11.3, "end_s": 11.5, "ease": "none"},
    {"target": "plant_pulse", "from": 0, "to": 1, "start_s": 11.6, "end_s": 12.6, "ease": "none"},
    {
        "target": "data_opacity",
        "from": 1,
        "to": 0,
        "start_s": 14.0,
        "end_s": 15.0,
        "ease": "power1.inOut",
    },
]
# The data track, shared by the page and the scripted camera track: the plants light up one by one from 4.5 s
# (the largest) to 7.8 s (the 291st), then the lines draw from 8.0 s to 11.3 s and hold.
DATA_TRACK = {
    "plants_start_s": 4.5,
    "plants_last_s": 7.8,
    "pop_frames": 6,
    "lines_start_s": 8.0,
    "lines_end_s": 11.3,
}
PAGE = {
    "default_view": {**WIDE, "exaggeration": 9},
    # The page runs the data track once after ready: frames 135 to 345 at 30 fps (7 s).
    "draw_frames": [135, 345],
}

GEOD = Geod(ellps="WGS84")
TO_GRID = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)


def check_inputs() -> None:
    for path in (DEM_DIR, GPPD_CSV, NE_ZIP, LINES_JSON, CITIES_JSON, SOURCES_JSON, KEY_FIGURES):
        if not path.exists():
            raise FileNotFoundError(f"{path} is missing: run uv run data/download.py first")


def grid_transform(cell_m: int) -> tuple[rasterio.Affine, tuple[int, int]]:
    """The affine transform and (rows, cols) of the model grid at one cell size."""
    cols = (GRID_X_M[1] - GRID_X_M[0]) // cell_m
    rows = (GRID_Y_M[1] - GRID_Y_M[0]) // cell_m
    return from_origin(GRID_X_M[0], GRID_Y_M[1], cell_m, cell_m), (rows, cols)


def countries() -> tuple[object, object]:
    """Mainland Norway and its neighbours from Natural Earth, in WGS84."""
    world = gpd.read_file(f"zip://{NE_ZIP}")
    norway = world[world["ADM0_A3"] == COUNTRY_ISO3]
    if norway.empty:
        raise ValueError("Norway not found in Natural Earth")
    land = norway.geometry.union_all().intersection(MAINLAND_BOX)
    neighbours = world[world["ADM0_A3"].isin(NEIGHBOURS_ISO3)].geometry.union_all()
    return land, neighbours


def to_grid(geom: object) -> object:
    """Reproject a shapely geometry from WGS84 to the grid CRS, all vertices in one call."""
    return shapely.transform(
        geom, lambda xy: np.column_stack(TO_GRID.transform(xy[:, 0], xy[:, 1]))
    )


def mosaic_dem(cell_m: int) -> np.ndarray:
    """Average every GLO-90 tile into the model grid.

    A 500 m cell holds about 30 of the 90 m cells. Resampling.average takes their mean, so every
    cell is the mean height of its square: the honest value for a cell this size (nearest
    neighbour would pick one 90 m cell at random and make the relief speckled). I warp each tile
    into its own window of the grid and add sums and counts, because a cell on a tile edge gets
    part of its area from each neighbouring tile.
    """
    transform, (rows, cols) = grid_transform(cell_m)
    total = np.zeros((rows, cols), dtype=np.float64)
    count = np.zeros((rows, cols), dtype=np.float64)
    tiles = sorted(DEM_DIR.glob("*.tif"))
    if len(tiles) < 100:
        raise ValueError(f"expected about 120 DEM tiles, found {len(tiles)}")
    for tif in tiles:
        with rasterio.open(tif) as src:
            west, south, east, north = transform_bounds(src.crs, CRS, *src.bounds)
            c0 = max(0, int((west - GRID_X_M[0]) // cell_m) - 2)
            c1 = min(cols, int((east - GRID_X_M[0]) // cell_m) + 3)
            r0 = max(0, int((GRID_Y_M[1] - north) // cell_m) - 2)
            r1 = min(rows, int((GRID_Y_M[1] - south) // cell_m) + 3)
            if c1 <= c0 or r1 <= r0:
                continue
            window = np.full((r1 - r0, c1 - c0), np.nan, dtype=np.float32)
            reproject(
                source=rasterio.band(src, 1),
                destination=window,
                dst_transform=transform * rasterio.Affine.translation(c0, r0),
                dst_crs=CRS,
                dst_nodata=np.nan,
                resampling=Resampling.average,
            )
            ok = np.isfinite(window)
            total[r0:r1, c0:c1][ok] += window[ok]
            count[r0:r1, c0:c1][ok] += 1
    heights = np.where(count > 0, total / np.maximum(count, 1), 0.0)
    print(f"DEM: {len(tiles)} tiles averaged into {cols} x {rows} cells of {cell_m} m")
    return heights.astype(np.float32)


def burn(geom: object, cell_m: int) -> np.ndarray:
    """Rasterise a polygon onto the grid: True where a cell's centre lies inside it."""
    transform, shape = grid_transform(cell_m)
    return rasterize([(to_grid(geom), 1)], out_shape=shape, transform=transform, fill=0).astype(
        bool
    )


def hex_rgb(hex_colour: str) -> np.ndarray:
    return np.array([int(hex_colour[i : i + 2], 16) / 255 for i in (1, 3, 5)])


def ramp_colour(heights_m: np.ndarray) -> np.ndarray:
    """Colour by height: the five ramp stops spread evenly, blended in sRGB like the CSS bar."""
    h = np.clip((heights_m - RAMP_DOMAIN_M[0]) / (RAMP_DOMAIN_M[1] - RAMP_DOMAIN_M[0]), 0, 1)
    pos = RAMP_START + (1 - RAMP_START) * h**RAMP_GAMMA
    stops = np.array([hex_rgb(c) for c in HEIGHT_RAMP])
    scaled = pos * (len(stops) - 1)
    i = np.clip(np.floor(scaled).astype(int), 0, len(stops) - 2)
    t = (scaled - i)[..., None]
    return stops[i] * (1 - t) + stops[i + 1] * t


def hillshade(heights_m: np.ndarray, cell_m: int) -> np.ndarray:
    """Lambert shading of the surface under a light from the north-west, 0 to 1.

    Rows run from north to south, so the northward slope is minus the row gradient. The light
    vector is in (east, north, up) with the azimuth clockwise from north.
    """
    z = heights_m * SHADE_EXAGGERATION
    d_row, d_col = np.gradient(z, cell_m)
    dz_east, dz_north = d_col, -d_row
    az = np.radians(LIGHT_AZIMUTH_DEG)
    alt = np.radians(LIGHT_ALTITUDE_DEG)
    light = np.array([np.cos(alt) * np.sin(az), np.cos(alt) * np.cos(az), np.sin(alt)])
    norm = np.sqrt(dz_east**2 + dz_north**2 + 1)
    shade = (-dz_east * light[0] - dz_north * light[1] + light[2]) / norm
    return np.clip(shade, 0, 1)


def write_heights(heights_m: np.ndarray) -> None:
    """Terrarium PNG: height = R * 256 + G + B / 256 - 32768.

    Three 8-bit channels hold a height to 1/256 m. Browsers decode an 8-bit RGB PNG exactly; a
    16-bit greyscale PNG would be cut to 8 bits when it is drawn into a canvas.
    """
    v = heights_m.astype(np.float64) + 32768
    r = np.floor(v / 256)
    g = np.floor(v - r * 256)
    b = np.floor((v - r * 256 - g) * 256)
    rgb = np.stack([r, g, b], axis=-1).astype(np.uint8)
    Image.fromarray(rgb, "RGB").save(OUT_DIR / "heights.png", optimize=True)


def write_relief(heights_m: np.ndarray, norway: np.ndarray, neighbours: np.ndarray) -> None:
    """Bake the top texture: colour by height times a soft hillshade, the sea in Ink, and the
    neighbours as a faint silhouette that fades into Ink within about 100 km of the border."""
    colour = ramp_colour(heights_m)
    shade = 0.22 + 1.1 * hillshade(heights_m, TEXTURE_CELL_M)
    land = np.clip(colour * shade[..., None], 0, 1)
    ink = np.array(INK)
    # Distance from Norway in km, for every cell outside it (a Euclidean distance transform
    # counts cells; one cell is 0.5 km).
    distance_km = distance_transform_edt(~norway) * TEXTURE_CELL_M / 1000
    weight = (np.exp(-distance_km / NEIGHBOUR_FADE_KM) * NEIGHBOUR_STRENGTH)[..., None]
    slate = ink * (1 - weight) + np.array(NEIGHBOUR_RGB) * weight
    rgb = np.where(norway[..., None], land, np.where(neighbours[..., None], slate, ink))
    Image.fromarray((rgb * 255 + 0.5).astype(np.uint8), "RGB").save(
        OUT_DIR / "relief.webp", quality=WEBP_QUALITY, method=6
    )


def grid_xy(lon: float, lat: float) -> list[float]:
    x, y = TO_GRID.transform(lon, lat)
    return [round(x, 1), round(y, 1)]


def write_plants() -> pd.DataFrame:
    """The hydro plants, largest first: that is the order they light up in."""
    plants = pd.read_csv(GPPD_CSV, low_memory=False)
    hydro = plants[(plants["country"] == COUNTRY_ISO3) & (plants["primary_fuel"] == "Hydro")]
    if len(hydro) != EXPECTED_HYDRO_PLANTS:
        raise ValueError(f"expected {EXPECTED_HYDRO_PLANTS} hydro plants, found {len(hydro)}")
    # Ties in capacity are broken by name, so the order is the same on every run.
    hydro = hydro.sort_values(["capacity_mw", "name"], ascending=[False, True]).reset_index()
    x, y = TO_GRID.transform(hydro["longitude"].to_numpy(), hydro["latitude"].to_numpy())
    out = [
        {
            "name": row["name"],
            "capacity_mw": float(row["capacity_mw"]),
            "x": int(round(px / 10) * 10),  # 10 m: the database gives 4 decimals of a degree
            "y": int(round(py / 10) * 10),
            "rank": i + 1,
        }
        for i, (row, px, py) in enumerate(zip(hydro.to_dict("records"), x, y, strict=True))
    ]
    if out[0]["name"] != "Kvilldal":
        raise ValueError(f"the largest plant is {out[0]['name']}, not Kvilldal")
    (OUT_DIR / "plants.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    total = sum(p["capacity_mw"] for p in out)
    print(f"plants: {len(out)} hydro plants, {total:,.0f} MW, largest {out[0]['name']}")
    return pd.DataFrame(out)


def max_kv(voltage: str) -> float:
    """The voltage tag holds volts, one value per circuit ("420000;132000"). I keep the highest,
    the class the pylons are built for, as data/key_figures.py does."""
    volts = [float(v) for v in voltage.replace(",", ";").split(";") if v.strip().isdigit()]
    return max(volts) / 1000 if volts else float("nan")


def parts(geom: object) -> list[LineString]:
    if geom.is_empty:
        return []
    if isinstance(geom, LineString):
        return [geom]
    if isinstance(geom, MultiLineString):
        return list(geom.geoms)
    # A cut can leave points or a collection: keep only its lines.
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, LineString)]


def write_lines(land: object, plants: pd.DataFrame, expected_km: float) -> float:
    """The 300 and 420 kV lines, cut to the mainland, in the order they draw.

    OpenStreetMap splits a line into many ways (at every change of tags). I join touching ways of
    the same voltage back into long lines, so a line draws as one stroke. Then each line starts at
    the end nearer a hydro plant, and the lines are sorted by that distance: the network grows
    outward from the plants.
    """
    data = json.loads(LINES_JSON.read_text(encoding="utf-8"))
    by_kv: dict[int, list[LineString]] = {kv: [] for kv in LINE_KV}
    for el in data["elements"]:
        if el["type"] != "way" or len(el.get("geometry", [])) < 2:
            continue
        kv = max_kv(el.get("tags", {}).get("voltage", ""))
        if round(kv) in LINE_KV:
            by_kv[round(kv)].append(LineString([(p["lon"], p["lat"]) for p in el["geometry"]]))
    # Cut at the border before anything else. Natural Earth's 1:10m coast is coarse, so the
    # buffer of about 2 km keeps the spans that hop between islands.
    clip = land.buffer(LAND_BUFFER_DEG)
    geodesic_km = 0.0
    lines = []
    for kv, ways in by_kv.items():
        cut = [p for w in ways for p in parts(w.intersection(clip))]
        # Length on the WGS84 ellipsoid, before any projection, exactly as key_figures.py
        # measures it: one projection cannot be true over six UTM zones.
        geodesic_km += sum(GEOD.geometry_length(p) for p in cut) / 1000
        merged = parts(line_merge(MultiLineString(cut)))
        lines += [(kv, to_grid(m)) for m in merged]
    off = abs(geodesic_km - expected_km) / expected_km
    print(
        f"lines: {geodesic_km:,.0f} km of {'/'.join(map(str, LINE_KV))} kV "
        f"(key figure {expected_km:,.0f} km, {off * 100:.2f} % off)"
    )
    if off > 0.01:
        raise ValueError("the line length is more than 1 % off the key figure")

    tree = cKDTree(plants[["x", "y"]].to_numpy())
    ordered = []
    for kv, line in lines:
        simple = line.simplify(LINE_SIMPLIFY_M, preserve_topology=False)
        coords = np.round(np.asarray(simple.coords)).astype(int)
        if len(coords) < 2 or simple.length < 1:
            continue
        d_start, _ = tree.query(coords[0])
        d_end, _ = tree.query(coords[-1])
        if d_end < d_start:
            coords = coords[::-1]
        ordered.append((min(d_start, d_end), kv, coords.tolist()))
    ordered.sort(key=lambda item: item[0])
    out = {
        "total_geodesic_km": round(geodesic_km, 1),
        "lines": [
            {"kv": kv, "order": i, "coords": coords} for i, (_, kv, coords) in enumerate(ordered)
        ],
    }
    (OUT_DIR / "lines.json").write_text(json.dumps(out, separators=(",", ":")))
    vertices = sum(len(line["coords"]) for line in out["lines"])
    print(f"lines: {len(ordered)} lines after joining ways, {vertices:,} vertices")
    return geodesic_km


def check_cities() -> None:
    data = json.loads(CITIES_JSON.read_text(encoding="utf-8"))
    nodes = {el["id"]: el.get("tags", {}) for el in data["elements"]}
    for name, city in CITIES.items():
        tags = nodes.get(city["osm_node"])
        if not tags or tags.get("name") != name or tags.get("place") != "city":
            raise ValueError(f"{name} (node {city['osm_node']}) is not a place=city in the file")


def camera_key(key: dict) -> dict:
    """Add what the 3D scene needs to a MapLibre-style camera key.

    MapLibre's zoom z with 512 px tiles means 40,075,017 * cos(lat) / (512 * 2^z) metres per
    pixel at the centre. Times the 1080 px of the frame that is the width of the view at its
    centre. UTM's scale error is below 0.1 % here, so the same width holds on the grid.
    """
    lon, lat = key["centre"]
    m_per_px = 40_075_016.686 * np.cos(np.radians(lat)) / (512 * 2 ** key["zoom"])
    xy = grid_xy(lon, lat)
    width_km = m_per_px * FRAME_PX[0] / 1000
    fit = FRAME_FIT.get(key.get("fit"))
    if fit:
        # The fitted centre, and the fitted width moved by the zoom step from the fitted zoom
        # (the hook's push in from 4.73 to 4.78 keeps its 0.05 step).
        xy = [float(v) for v in fit["xy"]]
        if fit["width_km"]:
            width_km = fit["width_km"] * 2 ** (fit["zoom"] - key["zoom"])
    return {**key, "xy": xy, "width_km": round(width_km, 3)}


def write_scene(heights_m: np.ndarray, figures: dict) -> None:
    _, (rows, cols) = grid_transform(HEIGHT_CELL_M)
    beats = [
        {**beat, "camera": {k: camera_key(v) for k, v in beat["camera"].items()}} for beat in BEATS
    ]
    scene = {
        "crs": CRS,
        "central_meridian": CENTRAL_MERIDIAN_DEG,
        "page_type": PAGE_TYPE,
        "grid": {
            "x_m": list(GRID_X_M),
            "y_m": list(GRID_Y_M),
            "height_cell_m": HEIGHT_CELL_M,
            "texture_cell_m": TEXTURE_CELL_M,
            "height_size": [cols, rows],
            "max_height_m": round(float(heights_m.max()), 1),
        },
        "fps": FPS,
        "length_s": LENGTH_S,
        "frames": FRAMES,
        "frame_px": list(FRAME_PX),
        "hero_frame": HERO_FRAME,
        "beats": beats,
        "camera_tweens": CAMERA_TWEENS,
        "data_track": DATA_TRACK,
        "page": {**PAGE, "default_view": camera_key(PAGE["default_view"])},
        "look": {
            "background": "#0F141A",
            "height_ramp": HEIGHT_RAMP,
            "height_ramp_domain_m": list(RAMP_DOMAIN_M),
            "plants": "#FFB000",
            "lines": "#F4F1EA",
            "cities": "#F4F1EA",
            "exaggeration": EXAGGERATION,
            "light": {"azimuth_deg": LIGHT_AZIMUTH_DEG, "altitude_deg": LIGHT_ALTITUDE_DEG},
        },
        "points": {
            "kvilldal": {**KVILLDAL, "xy": grid_xy(KVILLDAL["lon"], KVILLDAL["lat"])},
            "oslo": {
                "lat": CITIES["Oslo"]["lat"],
                "lon": CITIES["Oslo"]["lon"],
                "xy": grid_xy(CITIES["Oslo"]["lon"], CITIES["Oslo"]["lat"]),
            },
            "bergen": {
                "lat": CITIES["Bergen"]["lat"],
                "lon": CITIES["Bergen"]["lon"],
                "xy": grid_xy(CITIES["Bergen"]["lon"], CITIES["Bergen"]["lat"]),
            },
        },
        "figures": {
            "hydro_capacity_mw": figures["hydro_capacity"]["value"],
            "transmission_km": figures["transmission_km"]["value"],
        },
    }
    (OUT_DIR / "scene.json").write_text(json.dumps(scene, ensure_ascii=False, indent=1))


def write_meta() -> None:
    """Source names and download dates for the "Data fetched" line. The 120 DEM tiles are one
    dataset, so they become one entry with the latest of their dates."""
    sources = json.loads(SOURCES_JSON.read_text(encoding="utf-8"))
    dem = [s for s in sources if s["name"].startswith("Copernicus DEM GLO-90")]
    rest = [s for s in sources if s not in dem]
    out = [{"name": s["name"], "downloaded": s["downloaded"]} for s in rest]
    if dem:
        latest = max(date.fromisoformat(s["downloaded"]) for s in dem).isoformat()
        out.append({"name": f"Copernicus DEM GLO-90 ({len(dem)} tiles)", "downloaded": latest})
    (OUT_DIR / "meta.json").write_text(json.dumps({"sources": out}, indent=1))


def main() -> None:
    check_inputs()
    OUT_DIR.mkdir(exist_ok=True)
    figures = {f["id"]: f for f in json.loads(KEY_FIGURES.read_text(encoding="utf-8"))}
    land, neighbours_wgs84 = countries()

    # The relief: averaged to 500 m for the texture, then 2 x 2 cells averaged again to 1 km for
    # the mesh, so both describe the same surface.
    heights_500 = mosaic_dem(TEXTURE_CELL_M)
    norway = burn(land, TEXTURE_CELL_M)
    neighbours = burn(neighbours_wgs84, TEXTURE_CELL_M) & ~norway
    # The model is Norway: the sea and the neighbours lie flat at 0 m, and nothing goes below
    # sea level (the DEM has a few negative cells in mines and along the coast).
    heights_500 = np.where(norway, np.clip(heights_500, 0, None), 0).astype(np.float32)
    rows, cols = heights_500.shape
    heights_1k = heights_500.reshape(rows // 2, 2, cols // 2, 2).mean(axis=(1, 3))
    print(
        f"largest height in the 1 km grid: {heights_1k.max():,.0f} m "
        f"(500 m grid {heights_500.max():,.0f} m)"
    )
    if not 1_800 < heights_1k.max() < 2_500:
        raise ValueError("the highest cell is out of the sane range")

    write_heights(heights_1k)
    write_relief(heights_500, norway, neighbours)
    plants = write_plants()
    write_lines(land, plants, figures["transmission_km"]["value"])
    check_cities()
    write_scene(heights_1k, figures)
    write_meta()

    total = 0
    for path in sorted(OUT_DIR.iterdir()):
        size = path.stat().st_size
        total += size
        print(f"wrote {path.relative_to(PIECE)}  {size / 1e6:.2f} MB")
    print(f"maps/layers/ in total: {total / 1e6:.2f} MB")
    if total > 8e6:
        raise ValueError("maps/layers/ is over the 8 MB budget")


if __name__ == "__main__":
    main()
