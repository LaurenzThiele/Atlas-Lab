"""Turn the raw data into the small layers the 3D scene loads (ONE LINE 01: Switzerland).

What it does: I take the straight line through Basel and the Dufourspitze from
data/key_figures.py (so the line is defined in one place only) and build everything the browser
needs to draw it as a model: the height profile along the line, a 15 km strip of terrain east of
the line as a heightfield image, a shaded top-view map of Switzerland, the border outline, the
labelled points, and scene.json, which holds the camera path, the timing and the look.
Reads:  data/raw/ (run data/download.py first). No network.
Writes: maps/layers/profile.json, corridor.png, base.webp, border.json,
        points.json, scene.json, meta.json
Run:    uv run maps/prepare.py   (from the piece folder)

What you learn: how to treat a line as a GIS object (a start, a direction and a length in a
projected CRS), how to resample a DEM into the coordinates of that line, how heights travel to a
browser losslessly as an ordinary RGB PNG (Terrarium encoding), and how a shaded relief map is
made from a DEM with nothing but numpy.

ONE LINE is a series. The next episode (Lima to Brasília, the USA at 40° N, Belgium) copies the
constants block below, points it at its own data, runs this script and passes the new
scene.json to the same scene.js and timeline.js. Nothing in those two files knows about
Switzerland.
"""

import json
import sys
from itertools import pairwise
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.merge import merge
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject
from scipy.ndimage import distance_transform_edt, map_coordinates

HERE = Path(__file__).parent
PIECE = HERE.parent
RAW_DIR = PIECE / "data" / "raw"
OUT_DIR = HERE / "layers"

# The line itself lives in data/key_figures.py: the anchors, the country, the cut to the border
# and the 30 m profile. I import its functions instead of copying them, so the scene can never
# draw a different line from the one the numbers were computed on.
sys.path.insert(0, str(PIECE / "data"))
import key_figures as kf

# ---------------------------------------------------------------- constants (one episode)
DEM30_DIR = RAW_DIR / "copernicus_dem_30"
DEM90_DIR = RAW_DIR / "copernicus_dem_90"
BOUNDARIES_GPKG = kf.BOUNDARIES_GPKG
SOURCES_JSON = RAW_DIR / "sources.json"

# LV95 (EPSG:2056), the Swiss national grid: metres, and a straight line in it is the straight
# line the scene draws. Every distance below is measured in it.
CRS_PROJECTED = kf.CRS_CH
CRS_DEM = "EPSG:4326"
COUNTRY_ICC = kf.COUNTRY_ICC
COUNTRY_NAME = "Switzerland"
PLACE_NAME = "Switzerland, Basel to the Italian border at Monte Rosa"

CORRIDOR_KM = 15.0  # the strip of land kept east of the line
CORRIDOR_SIDE = "east of the line kept, west side cut away so the cut face looks west"
CORRIDOR_CELL_M = 60.0  # the heightfield image; the mesh uses every second cell (120 m)
BASE_MARGIN_M = 60_000  # map margin round the country
BASE_MAX_PX = 2048  # long side of the top-view map
BORDER_SIMPLIFY_M = 50
NEIGHBOUR_STRENGTH = 0.32  # neighbouring countries at the border, as a share of full colour
NEIGHBOUR_FADE_M = 35_000  # and faded to the background over this distance
SHADE_Z_FACTOR = 2.0  # heights doubled for the hillshade only, so the plateau reads

# The labelled places: id, the figure in key_figures.json, and how to find the point on the line.
# "start"/"end" are the line ends; "label" reuses a LABELS entry of key_figures.py (an official
# name point, a window along the line and the highest or lowest cell in it); "summit" is the
# second line anchor.
POINTS = [
    ("basel", "start_height", "start"),
    ("jura", "jura", "label"),
    ("lake_thun", "lake_thun", "label"),
    ("bernese_alps", "bernese_alps", "label"),
    ("rhone_valley", "rhone_valley", "label"),
    ("dufourspitze", "high_point", "summit"),
    ("monte_rosa", "end_height", "end"),
]

# The look, the same as the video's (from step 2). The ramp's five colours run from 200 m (darkest)
# to 4,600 m (lightest). I space them on a square-root height scale: the stops sit at 200, 475,
# 1,300, 2,675 and 4,600 m. A straight scale would spend most of its range on the high Alps and
# leave the plateau, where most of the line runs, nearly black on the Ink background.
LOOK = {
    "background": "#0F141A",
    "height_ramp": ["#141c26", "#22324a", "#3a5677", "#6f8fb3", "#c9d6e6"],
    "height_ramp_domain_m": [200, 4600],
    "height_ramp_scale": "sqrt",
    "cut_face": "#22344b",
    "wall_edge": "#4a6789",
    "profile_fill": "#2c4361",
    "profile_ahead": "#1b2633",
    "line": "#FFB000",
    "cursor": "#FFB000",
    "cursor_rim": "#0F141A",
    "slate": "#8A94A3",
    "paper": "#F4F1EA",
    "border": "#F4F1EA",
    "border_opacity": 0.35,
    "ticks_m": [1000, 2000, 3000, 4000],
    "tick_opacity": 0.4,
    "exaggeration": {"slice_3d": 9, "profile_2d": 17},
    "light": {"azimuth_deg": 315, "altitude_deg": 40},
}

# The animation: 14.5 s at 30 fps. Times in seconds.
PAGE_TYPE = "explainer"  # the page opens as the model; Play starts the animation
FPS = 30
LENGTH_S = 14.5
FRAME_PX = [1080, 1920]
HERO_FRAME = 30

# Camera keys, written like a web map camera (centre lon/lat, zoom, pitch, bearing) so they read
# like the storyboard notes. pitch 0 looks straight down, 90 looks level. Where the step 2 zoom
# and the approved storyboard frame disagree, the storyboard wins (the zooms were first guesses):
# the top view is 242 m per pixel (zoom 7.79), and its push-in keeps step 2's 0.07 zoom steps
# around that. anchor_px is where the centre sits on the 1080 x 1920 frame; subject_px is the part
# of the frame a wider or narrower browser window must keep in view.
LINE_MID = (7.7292, 46.74765)
TOP_SUBJECT = [0, 470, 1080, 1560]
SLICE_SUBJECT = [0, 500, 1080, 1060]
# The side view's subject reaches 80 px past the frame on both sides: on a narrow window the
# page then leaves room beside the profile for the "0 km" and "185 km" labels under its ends.
# The video maps its frame 1:1 and is not affected.
SIDE_SUBJECT = [-80, 420, 1160, 960]
TOP_ZOOM = 7.7905  # 242 m per pixel on the frame at the line's mid latitude
TOP = {
    "centre": LINE_MID,
    "pitch": 0,
    "bearing": 0,
    "projection": "perspective",
    "anchor_px": [540, 1040],
    "subject_px": TOP_SUBJECT,
}
SIDE = {
    "centre": LINE_MID,
    "pitch": 90,
    "bearing": 83.1,
    "projection": "orthographic",
    "anchor_px": [540, 940],
    "subject_px": SIDE_SUBJECT,
}
HOOK_FROM = {**TOP, "zoom": round(TOP_ZOOM - 0.035, 4)}
HOOK_TO = {**TOP, "zoom": round(TOP_ZOOM + 0.035, 4)}
# The slice: as the block rises, the camera drops low over the plateau on the west side of the
# line near Basel and travels south alongside the cut face, a little ahead of the cursor, then
# settles on the storyboard view. These keys name a point on the line (km along it) and the
# frame width in km; pitch 90 would be level, so 74 is a shallow look along the block.
SLICE_PATH = [
    {
        "along_km": 18.0,
        "view_width_km": 150.0,
        "pitch": 50,
        "bearing": 65,
        "projection": "perspective",
        "anchor_px": [470, 820],
        "subject_px": SLICE_SUBJECT,
        "at_s": 2.7,
    },
    {
        "along_km": 34.0,
        "view_width_km": 85.0,
        "pitch": 72,
        "bearing": 105,
        "projection": "perspective",
        "anchor_px": [500, 1010],
        "subject_px": SLICE_SUBJECT,
        "at_s": 3.5,
    },
    {
        "along_km": 68.0,
        "view_width_km": 120.0,
        "pitch": 69,
        "bearing": 97,
        "projection": "perspective",
        "anchor_px": [580, 980],
        "subject_px": SLICE_SUBJECT,
        "at_s": 4.7,
    },
]
# Fitted to the storyboard frame at 6.0 s (Jura peak at x 155, y 839; the cursor on Lake Thun at
# x 656, y 848; the slice between y 560 and 1000) with a fitting script, then written here.
SLICE_TO = {
    "centre": [7.76326, 46.54920],
    "zoom": 8.6587,
    "pitch": 63.8,
    "bearing": 83.1,
    "projection": "perspective",
    "anchor_px": [780, 912],
    "subject_px": SLICE_SUBJECT,
    "at_s": 6.0,
}

BEATS = [
    {
        "id": "hook",
        "start_s": 0.0,
        "end_s": 2.0,
        "layers": ["relief_90m", "country_mask", "border", "line", "line_ends"],
        "camera": {"from": HOOK_FROM, "to": HOOK_TO},
        "ease": "none",
    },
    {
        "id": "slice",
        "start_s": 2.0,
        "end_s": 6.5,
        "layers": ["relief_30m_corridor", "cut_face", "line_profile", "cursor"],
        "camera": {"from": HOOK_TO, "via": SLICE_PATH, "to": SLICE_TO},
        "ease": "cubic",
    },
    {
        "id": "profile",
        "start_s": 6.5,
        "end_s": 9.5,
        "layers": ["profile_fill", "line_profile", "cursor"],
        "camera": {"from": {**SLICE_TO, "at_s": 6.5}, "to": {**SIDE, "zoom": 7.6, "at_s": 7.2}},
        "ease": "power2.inOut",
    },
    {
        "id": "summit",
        "start_s": 9.5,
        "end_s": 13.0,
        "layers": ["profile_fill", "line_profile", "cursor", "summit_dot"],
        "camera": {
            "from": {**SIDE, "zoom": 7.6, "at_s": 9.5},
            "to": {**SIDE, "zoom": 7.6, "at_s": 13.0},
        },
        "ease": "none",
    },
    {
        "id": "end",
        "start_s": 13.0,
        "end_s": 14.5,
        "layers": ["relief_90m", "country_mask", "border", "line", "wash"],
        "camera": {"from": {**SIDE, "zoom": 7.6, "at_s": 13.0}, "to": {**HOOK_FROM, "at_s": 14.5}},
        "ease": "power2.inOut",
    },
]

# The cursor's position along the line (km) at set times, linear in between (step 2).
CURSOR_KM_KEYS = [
    [2.4, 0.0],
    [6.0, 98.6],
    [6.5, 98.6],
    [9.0, 121.6],
    [9.5, 121.6],
    [10.4, 142.0],
    [11.8, 183.4],
]

# Every other moving value of the scene: one value from A to B between two times, with an easing.
# The opening state is the first "from" of each value; the end beat brings each one back to it,
# so frame 435 is frame 0 and the animation loops.
TWEENS = [
    # the pulse along the line in the top view
    ("pulse_km", 0.0, 1.0, 0.1, 1.9, "power1.inOut"),
    ("pulse", 0.0, 1.0, 0.1, 0.4, "power1.out"),
    ("pulse", 1.0, 0.0, 1.6, 1.95, "power1.in"),
    # the corridor rises, the land west of the line fades, then the rest of the map
    ("ex", 0.0, 9.0, 2.0, 3.0, "power2.inOut"),
    ("corridor", 0.0, 1.0, 2.0, 2.3, "power1.out"),
    ("map_line", 1.0, 0.0, 2.0, 2.5, "power1.inOut"),
    ("base_west", 1.0, 0.0, 2.0, 3.0, "power1.inOut"),
    ("base", 1.0, 0.0, 3.0, 4.2, "power1.inOut"),
    ("cursor", 0.0, 1.0, 2.4, 2.6, "power1.out"),
    # the slice turns side on and flattens into the profile
    ("ex", 9.0, 17.0, 6.5, 7.2, "power2.inOut"),
    ("flatten", 0.0, 1.0, 6.5, 7.2, "power2.inOut"),
    ("profile_mix", 0.0, 1.0, 6.5, 6.8, "power1.inOut"),
    # the summit dot pulses once
    ("summit", 0.0, 1.0, 11.8, 11.85, "none"),
    ("summit_pulse", 0.0, 1.0, 11.8, 12.6, "power1.out"),
    # the end: everything folds back into the map, the camera returns to the top view
    ("cursor", 1.0, 0.0, 13.0, 13.3, "power1.in"),
    ("summit", 1.0, 0.0, 13.0, 13.3, "power1.in"),
    ("profile_mix", 1.0, 0.0, 13.0, 13.3, "power1.inOut"),
    ("ex", 17.0, 0.0, 13.0, 13.9, "power2.inOut"),
    ("flatten", 1.0, 0.0, 13.0, 13.9, "power2.inOut"),
    ("base", 0.0, 1.0, 13.3, 14.2, "power1.inOut"),
    ("base_west", 0.0, 1.0, 13.3, 14.2, "power1.inOut"),
    ("corridor", 1.0, 0.0, 13.2, 13.65, "power1.inOut"),
    ("map_line", 0.0, 1.0, 13.8, 14.4, "power1.inOut"),
]

# The page's start view: the finished model at x9 on its base map, from the west side of the
# line, facing the cut face.
# The map under it is dimmed to 55 % so the block stands out from its floor.
# The animation's own indicators (drawn in the scene, on the page and in the video alike).
# Place labels: each fades in when the cursor reaches its point and fades out after HOLD_S; the
# last one stays to the end of its beat. "dx, dy" put the label beside its point (px on the
# 1080 x 1920 frame) and "align" says which end of the text sits there, so the labels keep clear
# of the video's own text. The names are the places as a reader says them.
INDICATOR_FADE_S = 0.2
INDICATOR_HOLD_S = 1.0
INDICATOR_PLACES = [
    # id, name, view, dx, dy, align, stays to the end of the beat
    ("jura", "Jura", "slice", 40, -50, "start", False),
    ("lake_thun", "Lake Thun", "slice", -30, -60, "end", False),
    ("bernese_alps", "Blüemlisalp", "side", 16, 22, "start", False),
    ("rhone_valley", "Rhône valley", "side", -16, 16, "end", False),
    ("dufourspitze", "Dufourspitze", "side", -118, 78, "end", True),
]
# The axes of the side view: heights on the left edge, km along the foot.
AXES = {"heights_m": [1000, 2000, 3000, 4000], "km_step": 25, "in": [6.5, 7.2], "out": [13.0, 13.3]}
# Text on the frame stays inside this box (the video's safe area), px on the 1080 x 1920 frame.
SAFE_BOX_PX = [120, 290, 960, 1440]

START_VIEW = {"along_km": 92.7, "pitch": 55, "bearing": 83.1, "ex": 9, "base": 0.55}


# ---------------------------------------------------------------- helpers
def zoom_to_width_km(zoom: float, lat: float) -> float:
    """Width of the 1080 px frame in km at a web map zoom (512 px tiles, as MapLibre counts)."""
    metres_per_px = 40_075_016.7 * np.cos(np.radians(lat)) / (512 * 2**zoom)
    return float(metres_per_px * FRAME_PX[0] / 1000)


def terrarium(height_m: np.ndarray) -> np.ndarray:
    """Encode heights as RGB: height = R * 256 + G + B / 256 - 32768.

    Browsers decode an 8-bit RGB PNG byte for byte, so this carries heights with no loss. A
    16-bit greyscale PNG would be cut to 8 bits as soon as it is drawn into a canvas. I round to
    whole metres, so B is always 0: the 30 m DEM is not accurate to a fraction of a metre anyway,
    and a constant B channel halves the file, which keeps the page's first load small.
    NaN (no data) becomes 0, 0, 0, which decodes to -32768 m: the scene treats it as no data.
    """
    v = np.where(np.isfinite(height_m), np.round(height_m) + 32768.0, 0.0)
    v = np.clip(v, 0, 65535)
    r = np.floor(v / 256)
    g = v - r * 256
    return np.dstack([r, g, np.zeros_like(v)]).astype(np.uint8)


def merged(folder: Path) -> tuple[np.ndarray, rasterio.Affine]:
    tiles = sorted(folder.glob("*.tif"))
    if not tiles:
        raise FileNotFoundError(f"no DEM tiles in {folder}: run data/download.py")
    sources = [rasterio.open(t) for t in tiles]
    mosaic, transform = merge(sources, nodata=np.nan)
    for s in sources:
        s.close()
    return mosaic[0].astype(np.float32), transform


def sample_bilinear(grid: np.ndarray, transform, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Bilinear DEM height at lon/lat. The cell values belong to cell centres, so I shift by half
    a cell; outside the grid the result is NaN."""
    cols, rows = ~transform * (lon, lat)
    out = map_coordinates(grid, [rows - 0.5, cols - 0.5], order=1, mode="constant", cval=np.nan)
    return out


def srgb_ramp(height_m: np.ndarray) -> np.ndarray:
    """The look's ramp on the square-root height scale, blended in sRGB (0..1)."""
    lo, hi = LOOK["height_ramp_domain_m"]
    stops = np.array(
        [[int(c[i : i + 2], 16) / 255 for i in (1, 3, 5)] for c in LOOK["height_ramp"]]
    )
    t = np.sqrt(np.clip((height_m - lo) / (hi - lo), 0, 1)) * (len(stops) - 1)
    i = np.minimum(np.floor(t).astype(int), len(stops) - 2)
    f = (t - i)[..., None]
    return stops[i] * (1 - f) + stops[i + 1] * f


def hillshade(height_m: np.ndarray, cell_m: float) -> np.ndarray:
    """Lambert hillshade (0..1) for a light from azimuth 315 and altitude 40 degrees.

    The slope comes from the height gradient. Rows run north to south, so the north component
    of the gradient is the negative row gradient. Heights are doubled first (shading only), the
    usual trick to make low hills like the Jura read at a country-wide scale.
    """
    z = np.nan_to_num(height_m, nan=0.0) * SHADE_Z_FACTOR
    dz_drow, dz_dcol = np.gradient(z, cell_m)
    dz_de, dz_dn = dz_dcol, -dz_drow
    az = np.radians(LOOK["light"]["azimuth_deg"])
    alt = np.radians(LOOK["light"]["altitude_deg"])
    light = np.array([np.sin(az) * np.cos(alt), np.cos(az) * np.cos(alt), np.sin(alt)])
    norm = np.sqrt(dz_de**2 + dz_dn**2 + 1)
    shade = (-dz_de * light[0] - dz_dn * light[1] + light[2]) / norm
    return np.clip(shade, 0, 1)


def smoothstep(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def write_json(path: Path, data, compact: bool = False) -> None:
    text = json.dumps(
        data,
        ensure_ascii=False,
        separators=(",", ":") if compact else None,
        indent=None if compact else 1,
    )
    path.write_text(text)


# ---------------------------------------------------------------- the line and its profile
def build_line() -> dict:
    """The line as a GIS object: start, end, a unit direction, a length and a bearing in LV95."""
    names = kf.load_names()
    line = kf.border_to_border(names)
    (e0, n0), (e1, n1) = line.coords[0], line.coords[-1]
    length_m = line.length
    unit = np.array([e1 - e0, n1 - n0]) / length_m
    # Bearing clockwise from grid north. LV95 grid north is within half a degree of true north
    # here, which is far below anything the scene can show.
    bearing = float(np.degrees(np.arctan2(unit[0], unit[1])) % 360)
    # The normal pointing to the east side of the line (to the left when walking south).
    east = np.array([-unit[1], unit[0]])
    if east[0] < 0:
        east = -east
    prof = kf.profile(line)
    return {
        "names": names,
        "line": line,
        "start": np.array([e0, n0]),
        "end": np.array([e1, n1]),
        "mid": np.array([(e0 + e1) / 2, (n0 + n1) / 2]),
        "unit": unit,
        "east": east,
        "length_m": length_m,
        "bearing": bearing,
        "profile": prof,
    }


def write_profile(geo: dict) -> None:
    prof = geo["profile"]
    pairs = [[round(d / 1000, 2), round(h)] for d, h in zip(prof.dist_m, prof.height_m)]
    data = {
        "about": f"Ground height every {kf.STEP_M:.0f} m along the straight line through Basel "
        "and the Dufourspitze, from the Swiss border on the Rhine to the Italian border. "
        "[km from the start, metres above sea level].",
        "source": "Copernicus DEM GLO-30 (ESA / Copernicus)",
        "step_m": kf.STEP_M,
        "length_km": round(geo["length_m"] / 1000, 3),
        "points": pairs,
    }
    write_json(OUT_DIR / "profile.json", data, compact=True)
    print(f"profile  {len(pairs):,} samples, {pairs[0][1]} m to {max(p[1] for p in pairs):,} m")


# ---------------------------------------------------------------- the corridor heightfield
def write_corridor(geo: dict) -> dict:
    """Resample the DEM into line coordinates: along the line (x) and across it to the east (y).

    Each pixel is a point S + along * u + across * e in LV95 (S the start, u the direction, e the
    east normal). I convert those points to lon/lat and read the DEM there, so the image is the
    strip as if the line were the x axis. That makes the browser's job trivial: pixel (i, j) is
    simply i cells along and j cells across.
    """
    length_m = geo["length_m"]
    n_along = round(length_m / CORRIDOR_CELL_M) + 1
    n_across = round(CORRIDOR_KM * 1000 / CORRIDOR_CELL_M) + 1
    along = np.linspace(0, length_m, n_along)
    across = np.linspace(0, CORRIDOR_KM * 1000, n_across)
    a, c = np.meshgrid(along, across)  # rows = across, columns = along
    e = geo["start"][0] + a * geo["unit"][0] + c * geo["east"][0]
    n = geo["start"][1] + a * geo["unit"][1] + c * geo["east"][1]
    lon, lat = Transformer.from_crs(CRS_PROJECTED, CRS_DEM, always_xy=True).transform(e, n)

    dem30, t30 = merged(DEM30_DIR)
    height = sample_bilinear(dem30, t30, lon, lat)
    del dem30
    # The strip's south-east corner reaches past 8° E, which is why download.py fetches the GLO-30
    # tiles east of 8° E as well. Every cell must come from the 30 m model: stop if one does not.
    missing = ~np.isfinite(height)
    if missing.any():
        raise ValueError(
            f"{missing.mean():.2%} of the corridor has no GLO-30 data: run download.py"
        )
    print("corridor every cell from GLO-30")
    if not (150 < height.min() and height.max() < 4800):
        raise ValueError(f"corridor heights {height.min():.0f} to {height.max():.0f} m look wrong")

    # The cut face must meet the block exactly, so the first column across (the line itself)
    # takes the profile heights, interpolated to the 60 m cells.
    prof = geo["profile"]
    height[0, :] = np.interp(along, prof.dist_m, prof.height_m)

    Image.fromarray(terrarium(height), "RGB").save(OUT_DIR / "corridor.png", optimize=True)
    print(
        f"corridor {n_along} x {n_across} px, {CORRIDOR_CELL_M:.0f} m cells, "
        f"{height.min():.0f} to {height.max():.0f} m"
    )
    return {
        "along_km": round(length_m / 1000, 4),
        "across_km": CORRIDOR_KM,
        "width_px": n_along,
        "height_px": n_across,
        "cell_m": CORRIDOR_CELL_M,
    }


# ---------------------------------------------------------------- the top-view map
def country_shape():
    countries = gpd.read_file(BOUNDARIES_GPKG, layer="tlm_landesgebiet").to_crs(CRS_PROJECTED)
    return countries.loc[countries["icc"] == COUNTRY_ICC, "geometry"].union_all()


def reproject_dem90(bounds: tuple, cell_m: float, width: int, height: int) -> np.ndarray:
    """GLO-90 warped onto an LV95 grid. Bilinear: a DEM is a smooth surface, not classes."""
    dem90, t90 = merged(DEM90_DIR)
    out = np.full((height, width), np.nan, dtype=np.float32)
    reproject(
        dem90,
        out,
        src_transform=t90,
        src_crs=CRS_DEM,
        src_nodata=np.nan,
        dst_transform=from_origin(bounds[0], bounds[3], cell_m, cell_m),
        dst_crs=CRS_PROJECTED,
        dst_nodata=np.nan,
        resampling=Resampling.bilinear,
    )
    return out


def write_base(country) -> dict:
    """The shaded relief map under the model, with the neighbours fading into the background."""
    w, s, e, n = country.bounds
    bounds = (w - BASE_MARGIN_M, s - BASE_MARGIN_M, e + BASE_MARGIN_M, n + BASE_MARGIN_M)
    span_e, span_n = bounds[2] - bounds[0], bounds[3] - bounds[1]
    cell_m = max(span_e, span_n) / BASE_MAX_PX
    width, height = round(span_e / cell_m), round(span_n / cell_m)
    dem = reproject_dem90(bounds, cell_m, width, height)

    colour = srgb_ramp(np.nan_to_num(dem, nan=0.0))
    # Soft light: a flat surface keeps its ramp colour (0.45 + 0.85 * sin 40° = 1.0), slopes
    # facing the north-west light lift by up to a third, slopes facing away darken.
    shade = 0.45 + 0.85 * hillshade(dem, cell_m)
    colour = np.clip(colour * shade[..., None], 0, 1)
    # The top view is the stage for the Amber line, so the high Alps stay quieter here than on the
    # 3D model: from full colour on the plateau down to 72 % at the top of the ramp.
    lo, hi = LOOK["height_ramp_domain_m"]
    t = np.sqrt(np.clip((np.nan_to_num(dem, nan=0.0) - lo) / (hi - lo), 0, 1))
    ink0 = np.array([int(LOOK["background"][i : i + 2], 16) / 255 for i in (1, 3, 5)])
    colour = ink0 + (colour - ink0) * (1 - 0.28 * smoothstep(t / 0.8))[..., None]

    # Inside the country full strength; outside, 32 % at the border fading to nothing over 35 km,
    # measured with a distance transform on the rasterised country. Cells without DEM data (north
    # of 48° N, east of 11° E) fade out over 10 km so no data edge ever shows.
    from rasterio.features import rasterize

    inside = rasterize(
        [country],
        out_shape=(height, width),
        transform=from_origin(bounds[0], bounds[3], cell_m, cell_m),
    ).astype(bool)
    dist_out_m = distance_transform_edt(~inside) * cell_m
    strength = np.where(
        inside, 1.0, NEIGHBOUR_STRENGTH * (1 - smoothstep(dist_out_m / NEIGHBOUR_FADE_M))
    )
    valid = np.isfinite(dem)
    dist_invalid_m = distance_transform_edt(valid) * cell_m
    strength *= smoothstep(dist_invalid_m / 10_000)
    ink = np.array([int(LOOK["background"][i : i + 2], 16) / 255 for i in (1, 3, 5)])
    rgb = ink + (colour - ink) * strength[..., None]
    Image.fromarray(np.round(rgb * 255).astype(np.uint8), "RGB").save(
        OUT_DIR / "base.webp", quality=90, method=6
    )
    print(f"base     {width} x {height} px, {cell_m:.0f} m cells")
    extent = {"west_m": bounds[0], "south_m": bounds[1], "east_m": bounds[2], "north_m": bounds[3]}
    return {
        "base": {**extent, "width_px": width, "height_px": height},
    }


def write_border(country) -> None:
    simple = country.simplify(BORDER_SIMPLIFY_M, preserve_topology=True)
    rings = []
    for poly in getattr(simple, "geoms", [simple]):
        for ring in [poly.exterior, *poly.interiors]:
            rings.append([[round(x), round(y)] for x, y, *_ in ring.coords])
    data = {
        "crs": CRS_PROJECTED,
        "about": f"The border of {COUNTRY_NAME}, simplified to {BORDER_SIMPLIFY_M} m.",
        "rings": rings,
    }
    write_json(OUT_DIR / "border.json", data, compact=True)
    print(f"border   {len(rings)} rings, {sum(len(r) for r in rings):,} points")


# ---------------------------------------------------------------- labelled points
def find_points(geo: dict) -> list[dict]:
    """Where each labelled place sits on the line, found the way key_figures.py finds it."""
    prof = geo["profile"]
    names = geo["names"]
    labels = {lab["id"]: lab for lab in kf.LABELS}
    to_lonlat = Transformer.from_crs(CRS_PROJECTED, CRS_DEM, always_xy=True)
    out = []
    for pid, figure, how in POINTS:
        if how == "start":
            row = prof.iloc[0]
        elif how == "end":
            row = prof.iloc[-1]
        elif how == "summit":
            summit = kf.name_point(names, *kf.LINE_ANCHORS[1])
            km, _ = kf.along_km(geo["line"], summit["E"], summit["N"])
            near = prof[(prof.dist_m / 1000 - km).abs() <= 0.3]
            row = near.loc[near.height_m.idxmax()]
        else:
            lab = labels[figure]
            pt = kf.name_point(names, *lab["anchor"])
            km, _ = kf.along_km(geo["line"], pt["E"], pt["N"])
            win = prof[(prof.dist_m / 1000 - km).abs() <= lab["window_km"]]
            row = win.loc[win.height_m.idxmax() if lab["mode"] == "max" else win.height_m.idxmin()]
        lon, lat = to_lonlat.transform(row.e, row.n)
        out.append(
            {
                "id": pid,
                "figure": figure,
                "km": round(float(row.dist_m) / 1000, 2),
                "lon": round(float(lon), 5),
                "lat": round(float(lat), 5),
                "e": round(float(row.e)),
                "n": round(float(row.n)),
                "dem_m": round(float(row.height_m)),
            }
        )
    write_json(OUT_DIR / "points.json", out)
    for p in out:
        print(f"point    {p['id']:<13} km {p['km']:>6.2f}  {p['dem_m']:>5} m")
    return out


# ---------------------------------------------------------------- scene.json
def scene_xz(geo: dict, lon: float, lat: float) -> list[float]:
    """Scene coordinates in km: x east, z south, origin at the line's midpoint."""
    e, n = Transformer.from_crs(CRS_DEM, CRS_PROJECTED, always_xy=True).transform(lon, lat)
    return [round((e - geo["mid"][0]) / 1000, 4), round(-(n - geo["mid"][1]) / 1000, 4)]


def camera_key(geo: dict, key: dict) -> dict:
    out = dict(key)
    if "along_km" in key:
        # A point on the line: start + along * direction, in LV95, then to lon/lat.
        e, n = geo["start"] + geo["unit"] * key["along_km"] * 1000
        lon, lat = Transformer.from_crs(CRS_PROJECTED, CRS_DEM, always_xy=True).transform(e, n)
        out["centre"] = [round(lon, 5), round(lat, 5)]
    out["centre"] = list(out["centre"])
    out["xz"] = scene_xz(geo, *out["centre"])
    if key["projection"] == "orthographic":
        # The side view: the whole line across the frame width.
        out["view_width_km"] = round(geo["length_m"] / 1000, 4)
    elif "view_width_km" not in key:
        out["view_width_km"] = round(zoom_to_width_km(key["zoom"], out["centre"][1]), 4)
    out.setdefault("target_m", 0)
    return out


def geo_fit(geo: dict, base: dict) -> dict:
    """A cubic polynomial from scene x, z (km) to lon and lat, so the page can print the
    coordinates of a click without carrying a projection library. Fitted on a grid over the map;
    the largest error is printed (it must stay far below the 0.01° the note shows)."""
    xs = np.linspace(base["west_m"], base["east_m"], 40)
    ys = np.linspace(base["south_m"], base["north_m"], 40)
    e, n = np.meshgrid(xs, ys)
    lon, lat = Transformer.from_crs(CRS_PROJECTED, CRS_DEM, always_xy=True).transform(e, n)
    x = (e - geo["mid"][0]).ravel() / 1000
    z = -(n - geo["mid"][1]).ravel() / 1000
    terms = [x**i * z**j for i in range(4) for j in range(4 - i)]
    A = np.stack(terms, axis=1)
    c_lon, *_ = np.linalg.lstsq(A, lon.ravel(), rcond=None)
    c_lat, *_ = np.linalg.lstsq(A, lat.ravel(), rcond=None)
    err_m = max(
        np.abs(A @ c_lon - lon.ravel()).max() * 111_320 * np.cos(np.radians(46.7)),
        np.abs(A @ c_lat - lat.ravel()).max() * 111_320,
    )
    print(f"geo      lon/lat polynomial, largest error {err_m:.0f} m")
    powers = [[i, j] for i in range(4) for j in range(4 - i)]
    return {"powers": powers, "lon": c_lon.tolist(), "lat": c_lat.tolist()}


def cursor_time(keys: list[list[float]], km: float) -> float:
    """When the cursor (linear between its keys) first reaches a distance along the line."""
    for (t0, v0), (t1, v1) in pairwise(keys):
        if v0 <= km <= v1 and v1 > v0:
            return t0 + (t1 - t0) * (km - v0) / (v1 - v0)
    raise ValueError(f"the cursor never reaches km {km}")


def indicators(points: list[dict], keys: list[list[float]]) -> tuple[dict, list[tuple]]:
    """The indicator labels and axes for scene.json, and the tweens that fade them."""
    by_id = {p["id"]: p for p in points}
    beats = {b["id"]: b for b in BEATS}
    places = []
    tweens = []
    for pid, name, view, dx, dy, align, stays in INDICATOR_PLACES:
        p = by_id[pid]
        t_in = round(cursor_time(keys, p["km"]), 3)
        beat = next(b for b in BEATS if b["start_s"] <= t_in < b["end_s"])
        t_out = beat["end_s"] if stays else round(t_in + INDICATOR_FADE_S + INDICATOR_HOLD_S, 3)
        # The summit label shows the official height, as the video's big number does; every
        # other value is the DEM height on the line (the profile sample of key_figures.py).
        value_m = kf.SUMMIT_PUBLISHED_M if pid == "dufourspitze" else p["dem_m"]
        target = f"ind_{pid}"
        places.append(
            {
                "id": pid,
                "name": name,
                "value_m": value_m,
                "km": p["km"],
                "dem_m": p["dem_m"],
                "view": view,
                "dx": dx,
                "dy": dy,
                "align": align,
                "target": target,
            }
        )
        tweens.append((target, 0.0, 1.0, t_in, t_in + INDICATOR_FADE_S, "power1.out"))
        tweens.append((target, 1.0, 0.0, t_out, t_out + INDICATOR_FADE_S, "power1.in"))
    assert all(b in beats for b in ("slice", "profile", "summit"))
    tweens.append(("axes", 0.0, 1.0, *AXES["in"], "power2.inOut"))
    tweens.append(("axes", 1.0, 0.0, *AXES["out"], "power1.in"))
    axes = {"heights_m": AXES["heights_m"], "km_step": AXES["km_step"]}
    return {"places": places, "axes": axes, "safe_box_px": SAFE_BOX_PX}, tweens


def resolve_cursor_keys(points: list[dict]) -> list[list[float]]:
    """Step 2 rounds the cursor keys to 0.1 km. I move each key that names a labelled place onto
    that place's exact profile sample, so the counter lands on the figure's own cell (558 m at
    Lake Thun, 3,633 m on the Blüemlisalp), not on a neighbour 30 m away."""
    out = []
    for t, km in CURSOR_KM_KEYS:
        near = [p["km"] for p in points if abs(p["km"] - km) <= 0.06]
        out.append([t, near[0] if near else km])
    return out


def true_bearing(start: list[float], end: list[float]) -> float:
    from pyproj import Geod

    azimuth, _, _ = Geod(ellps="WGS84").inv(*start, *end)
    return float(azimuth % 360)


def write_scene(geo: dict, grids: dict, corridor: dict, points: list[dict]) -> None:
    to_lonlat = Transformer.from_crs(CRS_PROJECTED, CRS_DEM, always_xy=True)
    s_lonlat = [round(v, 5) for v in to_lonlat.transform(*geo["start"])]
    e_lonlat = [round(v, 5) for v in to_lonlat.transform(*geo["end"])]
    mid = geo["mid"]
    xz = lambda p: [round((p[0] - mid[0]) / 1000, 4), round(-(p[1] - mid[1]) / 1000, 4)]
    line = {
        "anchors": [{"name": n, "swissnames_kind": k} for n, k in kf.LINE_ANCHORS],
        "country_icc": COUNTRY_ICC,
        "crs": CRS_PROJECTED,
        "start": s_lonlat,
        "end": e_lonlat,
        "start_m": [round(float(v), 1) for v in geo["start"]],
        "end_m": [round(float(v), 1) for v in geo["end"]],
        "start_xz": xz(geo["start"]),
        "end_xz": xz(geo["end"]),
        "length_km": round(geo["length_m"] / 1000, 4),
        # Unit vectors in scene coordinates (x east, z south): along the line, and across it
        # towards the side the corridor keeps. The scene builds the strip from these two alone.
        "along_xz": [round(float(geo["unit"][0]), 6), round(float(-geo["unit"][1]), 6)],
        "corridor_normal_xz": [round(float(geo["east"][0]), 6), round(float(-geo["east"][1]), 6)],
        # True bearing on the ellipsoid (what a compass reads), and the bearing on the LV95 grid,
        # which the scene uses: grid north here sits 0.1° off true north.
        "bearing_deg": round(true_bearing(s_lonlat, e_lonlat), 1),
        "grid_bearing_deg": round(geo["bearing"], 2),
        "profile_step_m": kf.STEP_M,
        "samples": len(geo["profile"]),
    }
    cursor_keys = resolve_cursor_keys(points)
    indicator_config, indicator_tweens = indicators(points, cursor_keys)
    for p in indicator_config["places"]:
        start = next(t for t in indicator_tweens if t[0] == p["target"])[3]
        print(f"label    {p['name']:<13} {p['value_m']:>5} m  in at {start:.2f} s")
    beats = []
    for beat in BEATS:
        cam = {
            k: [camera_key(geo, x) for x in v] if isinstance(v, list) else camera_key(geo, v)
            for k, v in beat["camera"].items()
        }
        beats.append({**beat, "camera": cam})
    scene = {
        "fps": FPS,
        "frames": round(LENGTH_S * FPS),
        "length_s": LENGTH_S,
        "hero_frame": HERO_FRAME,
        "frame_px": FRAME_PX,
        "crs": CRS_PROJECTED,
        "origin_m": [round(float(mid[0]), 1), round(float(mid[1]), 1)],
        "place": {
            "name": PLACE_NAME,
            "line": line,
            "corridor_km": CORRIDOR_KM,
            "corridor_side": CORRIDOR_SIDE,
            "points_km": {p["id"]: p["km"] for p in points},
        },
        "corridor": corridor,
        **grids,
        "look": LOOK,
        "geo": geo_fit(geo, grids["base"]),
        "beats": beats,
        "cursor_keys": cursor_keys,
        "page_type": PAGE_TYPE,
        "indicators": indicator_config,
        "tweens": [
            {"target": t, "from": a, "to": b, "start_s": s, "end_s": e, "ease": ease}
            for t, a, b, s, e, ease in [*TWEENS, *indicator_tweens]
        ],
        "start_view": START_VIEW,
        # The top level of the model (the official summit height): a reading's note hangs here.
        "model_top_m": kf.SUMMIT_PUBLISHED_M,
    }
    write_json(OUT_DIR / "scene.json", scene)
    print(
        f"scene    {len(beats)} beats, {scene['frames']} frames, line {line['length_km']:.1f} km, "
        f"bearing {line['bearing_deg']:.1f}° (grid {line['grid_bearing_deg']:.1f}°)"
    )


def write_meta() -> None:
    raw = json.loads(SOURCES_JSON.read_text())
    sources = raw["sources"] if isinstance(raw, dict) else raw
    # One line per dataset: the DEM tiles of one product share a name up to "tile".
    seen = {}
    for s in sources:
        name = s["name"].split(" tile ")[0]
        seen.setdefault(name, s["downloaded"])
    meta = {"sources": [{"name": k, "downloaded": v} for k, v in seen.items()]}
    write_json(OUT_DIR / "meta.json", meta)


def main() -> None:
    OUT_DIR.mkdir(exist_ok=True)
    geo = build_line()
    print(f"line     {geo['length_m'] / 1000:.1f} km, bearing {geo['bearing']:.1f}°")
    write_profile(geo)
    corridor = write_corridor(geo)
    country = country_shape()
    grids = write_base(country)
    write_border(country)
    points = find_points(geo)
    write_scene(geo, grids, corridor, points)
    write_meta()

    total = 0
    print()
    for f in sorted(OUT_DIR.iterdir()):
        size = f.stat().st_size
        total += size
        print(f"wrote    {f.relative_to(PIECE)}  {size / 1024:,.0f} KB")
    print(f"total    {total / 1e6:.2f} MB (budget 6 MB)")
    if total > 6e6:
        raise ValueError("maps/layers/ is over 6 MB")


if __name__ == "__main__":
    main()
