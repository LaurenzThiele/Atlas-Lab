"""Turn the raw GMRT grid into the small layers the 3D scene in maps/ loads.

What it does: I fill the empty edge of the GMRT box, shrink the grid to a size a browser can
turn into a mesh, pack it into a PNG that stores heights exactly, cut a full-resolution depth
profile through the deepest point, and write the scene settings (camera path, timing, colours).
Reads:  data/raw/gmrt_mariana_med.tif, data/raw/sources.json, data/key_figures.json
Writes: maps/layers/relief.png    the seabed as a Terrarium-encoded RGB PNG
        maps/layers/section.json  the depth profile along the section line
        maps/layers/scene.json    place, camera path, beat timing, look (no text)
        maps/layers/meta.json     source names and download dates, for About this scene
        maps/layers/figures.json  display text of the figures the page shows, from key_figures
Run:    uv run maps/prepare.py   (from the piece folder, after uv run data/download.py)

What you learn: how to ship elevation to a browser without a tile server. A height in metres
does not fit in one 8-bit colour channel, so I spread it over three (the Terrarium encoding
that many web maps use) and decode it again in JavaScript. And why a 3D mesh and a cut face can
use different resolutions: the mesh is seen from far away, the cut face is a single line the
eye follows closely.
"""

import json
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image

HERE = Path(__file__).parent
PIECE = HERE.parent
RAW_DIR = PIECE / "data" / "raw"
GRID_FILE = RAW_DIR / "gmrt_mariana_med.tif"
SOURCES_FILE = RAW_DIR / "sources.json"
FIGURES_FILE = PIECE / "data" / "key_figures.json"
LAYERS_DIR = HERE / "layers"

MAX_WIDTH_PX = 800  # the mesh gets one vertex per pixel, so this caps it at 800 x 640
MAX_HEIGHT_PX = 640
TERRARIUM_OFFSET_M = 32768.0  # Terrarium stores height + 32768 so every value is positive

# I measure distances on a sphere of the mean Earth radius. Over a box 3 degrees across the
# difference to the WGS84 ellipsoid is well under 1 %, far below what the screen can show.
EARTH_RADIUS_KM = 6371.0
KM_PER_DEG = np.pi * EARTH_RADIUS_KM / 180.0

# The section line: north to south through the deepest cell. The cut face is built from it.
SECTION_LON = 142.2081
SECTION_LAT_FROM = 12.05
SECTION_LAT_TO = 10.75

# The scene in its composed 9:16 frame (1080 x 1920 px). The side view is set so sea level sits at
# y 470 px and the 141.6 km wide view keeps one scale on both axes (7.63 px per km).
FRAME_PX = (1080, 1920)
SIDE_VIEW_WIDTH_KM = 141.6
SIDE_VIEW_SEA_LEVEL_Y_PX = 470
EXAGGERATION = 6
ROCK_FLOOR_M = 11800  # the rock under the cut face is drawn down to this depth
PEAK_BASE_HALF_WIDTH_KM = 34

TOP_VIEW = {
    "centre": [142.2081, 11.3342],
    "zoom": 10.1,
    "pitch": 0,
    "bearing": 0,
    "projection": "perspective",
    "anchor_px": [540, 1012],
}
SIDE_VIEW = {
    "centre": [142.2081, 11.4],
    "zoom": None,
    "pitch": 90,
    "bearing": 90,
    "projection": "orthographic",
    "view_width_km": SIDE_VIEW_WIDTH_KM,
}

# The dive (Lau, 12 Nov 2026): the camera comes in low over the Pacific Plate from the south-east,
# circles over the plate to the west of Challenger Deep, drops into the trench and flies east
# along its axis (about 81 degrees here) between the walls to the deepest point. Ending on
# bearing 81 makes the swing into the side view (bearing 90) a small turn, and the camera backs
# out west through the half of the block the cut removes. "fov" is the vertical field of view of
# that key: 60 degrees for the low run, so both walls stay in frame. maps/scene.js checks the
# path stays above the seabed (cameraClearance).
DIVE_VIA = [
    {
        "centre": [142.5, 11.2],
        "zoom": 12.0,
        "pitch": 66,
        "bearing": -40,
        "fov": 50,
        "projection": "perspective",
        "at_s": 3.0,
    },
    {
        "centre": [142.0, 10.98],
        "zoom": 12.0,
        "pitch": 70,
        "bearing": 25,
        "fov": 50,
        "projection": "perspective",
        "at_s": 4.2,
    },
    {
        "centre": [142.05, 11.3],
        "zoom": 12.3,
        "pitch": 72,
        "bearing": 81,
        "fov": 60,
        "projection": "perspective",
        "at_s": 5.1,
    },
]
DIVE_END = {
    "centre": [142.2081, 11.3342],
    "zoom": 12.95,
    "pitch": 72,
    "bearing": 81,
    "fov": 60,
    "projection": "perspective",
}
# Halfway through the swing into the side view the camera climbs (pitch 66) while it narrows
# towards orthographic ("persp" 0.55), so it backs out above the walls, not through them.
SWING_VIA = {
    "centre": [142.19, 11.37],
    "zoom": 11.4,
    "pitch": 66,
    "bearing": 86,
    "fov": 45,
    "persp": 0.55,
    "projection": "perspective",
    "at_s": 6.25,
}

# The camera of every beat, the layers it shows and how the camera eases. "anchor_px" is where
# the centre point lands on the frame (the top view puts the deepest point at y 1012, a little
# below the middle). The dive passes through "via" at 4.2 s on one smooth curve.
BEATS = [
    {
        "id": "hook",
        "start_s": 0.0,
        "end_s": 2.0,
        "ease": "none",
        "camera": {"from": TOP_VIEW, "to": {**TOP_VIEW, "zoom": 10.2}},
        "layers": ["relief", "deep_marker"],
    },
    {
        "id": "dive",
        "start_s": 2.0,
        "end_s": 6.0,
        "ease": "smooth through via",
        "camera": {
            "from": {**TOP_VIEW, "zoom": 10.2},
            "via": DIVE_VIA,
            "to": {**DIVE_END, "at_s": 6.0},
        },
        "layers": ["relief"],
    },
    {
        "id": "bottom",
        "start_s": 6.0,
        "end_s": 8.4,
        "ease": "power2.inOut",
        "camera": {
            "from": DIVE_END,
            "via": [SWING_VIA],
            "to": {**SIDE_VIEW, "at_s": 6.6},
        },
        "layers": ["relief", "cut_face", "water_column", "sea_line", "profile_line"],
    },
    {
        "id": "everest",
        "start_s": 8.4,
        "end_s": 9.8,
        "ease": "none",
        "camera": {"from": SIDE_VIEW, "to": SIDE_VIEW},
        "layers": [
            "relief",
            "cut_face",
            "water_column",
            "sea_line",
            "profile_line",
            "everest_cone",
        ],
    },
    {
        "id": "gap",
        "start_s": 9.8,
        "end_s": 11.8,
        "ease": "none",
        "camera": {"from": SIDE_VIEW, "to": SIDE_VIEW},
        "layers": [
            "relief",
            "cut_face",
            "water_column",
            "sea_line",
            "profile_line",
            "everest_cone",
            "summit_line",
            "gap_highlight",
        ],
    },
    {
        "id": "loop",
        "start_s": 11.8,
        "end_s": 14.5,
        "ease": "power2.inOut",
        "camera": {"from": SIDE_VIEW, "to": TOP_VIEW},
        "layers": ["relief", "everest_cone", "cut_face"],
    },
]

# Everything else that moves, as plain tweens of one value from 0 to 1 (or back). The last
# beat returns every value to its opening state, so frame 435 is the same picture as frame 0.
TWEENS = [
    # The marker fades in over the first frames (so the loop joins on an empty frame), pulses
    # once a second, and is gone when the dive starts.
    {"target": "marker", "from": 0, "to": 1, "start_s": 0.0, "end_s": 0.2, "ease": "power2.out"},
    {"target": "marker_pulse", "from": 0, "to": 2, "start_s": 0.0, "end_s": 2.0, "ease": "none"},
    {"target": "marker", "from": 1, "to": 0, "start_s": 1.85, "end_s": 2.0, "ease": "power1.in"},
    # A soft fill light rises while the camera is down in the trench, so the walls in front of it
    # stay lit, and is gone again before the side view.
    {"target": "fill", "from": 0, "to": 1, "start_s": 2.4, "end_s": 3.6, "ease": "power1.inOut"},
    {"target": "fill", "from": 1, "to": 0, "start_s": 6.0, "end_s": 6.5, "ease": "power1.inOut"},
    # Indicators drawn in the scene (Lau, 12 Nov 2026): the Challenger Deep label once the dive
    # has it in view, then the depth and km axes of the slice, then Everest's summit tick and the
    # bracket of water above it. Each beat holds only as long as its figure takes to read.
    {"target": "ind_deep", "from": 0, "to": 1, "start_s": 5.0, "end_s": 5.3, "ease": "power1.out"},
    {"target": "ind_deep", "from": 1, "to": 0, "start_s": 6.0, "end_s": 6.15, "ease": "power1.in"},
    # The cut runs along the section line from north to south while the camera swings round.
    {"target": "cut", "from": 0, "to": 1, "start_s": 6.0, "end_s": 6.6, "ease": "power2.inOut"},
    {"target": "ind_axes", "from": 0, "to": 1, "start_s": 6.5, "end_s": 6.8, "ease": "power1.out"},
    # Everest rises from below the floor, then its summit line draws left to right.
    {"target": "peak", "from": 0, "to": 1, "start_s": 8.4, "end_s": 9.4, "ease": "power2.out"},
    {
        "target": "summit_line",
        "from": 0,
        "to": 1,
        "start_s": 9.4,
        "end_s": 9.8,
        "ease": "power1.inOut",
    },
    {
        "target": "ind_everest",
        "from": 0,
        "to": 1,
        "start_s": 9.4,
        "end_s": 9.6,
        "ease": "power1.out",
    },
    {"target": "gap", "from": 0, "to": 1, "start_s": 9.8, "end_s": 10.2, "ease": "power2.out"},
    {"target": "ind_gap", "from": 0, "to": 1, "start_s": 9.8, "end_s": 10.1, "ease": "power1.out"},
    # The way back: indicators, highlight and summit line go, Everest sinks, the cut closes.
    {"target": "ind_axes", "from": 1, "to": 0, "start_s": 11.8, "end_s": 12.0, "ease": "power1.in"},
    {
        "target": "ind_everest",
        "from": 1,
        "to": 0,
        "start_s": 11.8,
        "end_s": 12.0,
        "ease": "power1.in",
    },
    {"target": "ind_gap", "from": 1, "to": 0, "start_s": 11.8, "end_s": 12.0, "ease": "power1.in"},
    {"target": "gap", "from": 1, "to": 0, "start_s": 11.8, "end_s": 12.1, "ease": "power1.in"},
    {
        "target": "summit_line",
        "from": 1,
        "to": 0,
        "start_s": 11.8,
        "end_s": 12.1,
        "ease": "power1.in",
    },
    {"target": "peak", "from": 1, "to": 0, "start_s": 11.8, "end_s": 12.6, "ease": "power2.in"},
    {"target": "cut", "from": 1, "to": 0, "start_s": 12.0, "end_s": 12.8, "ease": "power2.inOut"},
    # The pulse counter goes back to 0 while the marker is still hidden, so the last frame
    # carries exactly the same values as the first.
    {"target": "marker_pulse", "from": 2, "to": 0, "start_s": 14.45, "end_s": 14.5, "ease": "none"},
]

# This piece is an explainer: the page opens on the interactive model and
# the animation runs only when the reader presses Play.
PAGE_TYPE = "explainer"
# The axes of the side view: depth ticks every 2,000 m down the left edge of the slice, km ticks
# every 50 km along its foot. Positions only; scene.js writes the labels.
INDICATORS = {"depth_ticks_m": [2000, 4000, 6000, 8000, 10000], "km_step": 50}

LOOK = {
    "background": "#0F141A",
    "depth_ramp": ["#040b15", "#08203a", "#13406b", "#2b6fa6", "#5aa3d6", "#a9d8f2"],
    "depth_ramp_domain_m": [10950, 1500],
    "water_fill": "#0d2747",
    "rock_fill": "#1b2633",
    "lines": "#56B4E9",
    "everest": "#F4F1EA",
    "summit_line": "#FFB000",
    "marker": "#FFB000",
    "marker_ring": "#0F141A",
    "gap_highlight": {"colour": "#56B4E9", "opacity": 0.2},
    "light": {"azimuth_deg": 315, "altitude_deg": 40},
}


def read_grid() -> tuple[np.ndarray, rasterio.Affine]:
    """Read the elevation grid (metres, negative below sea level) and its geotransform."""
    if not GRID_FILE.exists():
        raise FileNotFoundError(f"{GRID_FILE} is missing: run uv run data/download.py first")
    with rasterio.open(GRID_FILE) as src:
        if src.crs.to_epsg() != 4326:
            raise ValueError(f"expected EPSG:4326, got {src.crs}")
        elevation_m = src.read(1).astype(np.float64)
        transform = src.transform
    print(f"read {GRID_FILE.name}: {elevation_m.shape[1]} x {elevation_m.shape[0]} cells")
    return elevation_m, transform


def fill_gaps(elevation_m: np.ndarray) -> np.ndarray:
    """Fill NaN cells from their neighbours.

    GMRT leaves the last row or column of a requested box empty (NaN) and does not tag it as
    nodata, so a reader would never know. A NaN would break the mesh and the PNG, so I fill each
    empty cell with the mean of its filled neighbours, one ring at a time, until none are left.
    Only the outer edge is affected, far from anything the scene looks at.
    """
    filled = elevation_m.copy()
    print(f"filling {int(np.isnan(filled).sum())} empty cells at the edge from their neighbours")
    while np.isnan(filled).any():
        padded = np.pad(filled, 1, constant_values=np.nan)
        neighbours = np.stack(
            [
                padded[1 + dy : padded.shape[0] - 1 + dy, 1 + dx : padded.shape[1] - 1 + dx]
                for dy in (-1, 0, 1)
                for dx in (-1, 0, 1)
                if (dy, dx) != (0, 0)
            ]
        )
        valid = ~np.isnan(neighbours)
        count = valid.sum(axis=0)
        mean = np.where(count > 0, np.nansum(neighbours, axis=0) / np.maximum(count, 1), np.nan)
        gaps = np.isnan(filled) & (count > 0)
        if not gaps.any():
            raise ValueError("NaN cells with no filled neighbour: the grid is empty")
        filled[gaps] = mean[gaps]
    return filled


def downsample(elevation_m: np.ndarray) -> tuple[np.ndarray, int]:
    """Shrink the grid by a whole factor with an area average, to at most 800 x 640.

    An area average (the mean of each block of cells) keeps the volume of the relief honest:
    picking every second cell instead would let single spikes or holes decide what a block shows.
    The deepest point gets slightly shallower in the mesh, which is why the cut face and the
    numbers use the full-resolution grid.
    """
    rows, cols = elevation_m.shape
    factor = int(np.ceil(max(cols / MAX_WIDTH_PX, rows / MAX_HEIGHT_PX)))
    rows_out, cols_out = rows // factor, cols // factor
    # A few cells at the south and east edge that do not fill a whole block are dropped.
    blocks = elevation_m[: rows_out * factor, : cols_out * factor]
    small = blocks.reshape(rows_out, factor, cols_out, factor).mean(axis=(1, 3))
    return small, factor


def terrarium_png(elevation_m: np.ndarray, path: Path) -> None:
    """Write heights as an 8-bit RGB PNG: height = R * 256 + G + B / 256 - 32768.

    Why not a 16-bit greyscale PNG? A browser canvas only hands back 8 bits per channel, so the
    extra precision would be cut off on decoding. Three 8-bit channels survive exactly, as long
    as the PNG is lossless and has no colour profile for the browser to "correct".
    """
    value = elevation_m + TERRARIUM_OFFSET_M
    if value.min() < 0 or value.max() >= 65536:
        raise ValueError("height outside the Terrarium range")
    red = np.floor(value / 256.0)
    green = np.floor(value - red * 256.0)
    blue = np.floor((value - red * 256.0 - green) * 256.0)
    rgb = np.dstack([red, green, blue]).astype(np.uint8)
    Image.fromarray(rgb, mode="RGB").save(path, optimize=True)
    # Decode it again the way the browser will, to prove nothing was lost beyond 1/256 m.
    back = np.asarray(Image.open(path)).astype(np.float64)
    decoded = back[..., 0] * 256 + back[..., 1] + back[..., 2] / 256 - TERRARIUM_OFFSET_M
    error_m = np.abs(decoded - elevation_m).max()
    if error_m > 1 / 256 + 1e-9:
        raise ValueError(f"Terrarium round trip is off by {error_m:.4f} m")
    print(f"  round trip error {error_m * 1000:.1f} mm")


def section_profile(elevation_m: np.ndarray, transform: rasterio.Affine) -> list[list[float]]:
    """Sample the full-resolution grid along the section line, one point per grid row.

    I step through the rows whose centres lie between the two ends of the line and interpolate
    linearly between the two columns either side of the section longitude. The line runs through
    the centre of the deepest cell, so the deepest point keeps its exact value.
    """
    inverse = ~transform
    col_f, _ = inverse * (SECTION_LON, SECTION_LAT_FROM)
    col_f -= 0.5  # from the cell edge to the cell centre
    col0 = int(np.floor(col_f))
    weight = col_f - col0
    column = elevation_m[:, col0] * (1 - weight) + elevation_m[:, col0 + 1] * weight

    _, row_from = inverse * (SECTION_LON, SECTION_LAT_FROM)
    _, row_to = inverse * (SECTION_LON, SECTION_LAT_TO)
    points = []
    for row in range(int(np.ceil(row_from - 0.5)), int(np.floor(row_to - 0.5)) + 1):
        _, lat = transform * (col0 + 0.5, row + 0.5)
        distance_km = (SECTION_LAT_FROM - lat) * KM_PER_DEG
        depth_m = -column[row]
        points.append([round(float(distance_km), 2), round(float(depth_m))])
    return points


def relief_bounds(transform: rasterio.Affine, factor: int, shape: tuple[int, int]) -> dict:
    """Lon and lat of the centres of the first and last pixel of the small grid."""
    rows, cols = shape
    cell_lon = transform.a * factor
    cell_lat = -transform.e * factor
    west = transform.c + cell_lon / 2
    north = transform.f - cell_lat / 2
    return {
        "west": round(west, 6),
        "east": round(west + (cols - 1) * cell_lon, 6),
        "north": round(north, 6),
        "south": round(north - (rows - 1) * cell_lat, 6),
        "width": cols,
        "height": rows,
    }


def side_view_target_depth_m() -> float:
    """Depth of the side view's centre, so sea level lands at y 470 px on the 1920 px frame."""
    km_per_px = SIDE_VIEW_WIDTH_KM / FRAME_PX[0]
    below_sea_px = FRAME_PX[1] / 2 - SIDE_VIEW_SEA_LEVEL_Y_PX
    return below_sea_px * km_per_px / EXAGGERATION * 1000


def figure(figures: list[dict], figure_id: str) -> float:
    """Value of one key figure from data/key_figures.json."""
    for item in figures:
        if item["id"] == figure_id:
            return float(item["value"])
    raise KeyError(f"{figure_id} is not in {FIGURES_FILE}")


def write_json(data: object, path: Path) -> None:
    """Write compact JSON: these files are loaded by the browser, not read by people."""
    path.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))


def main() -> None:
    LAYERS_DIR.mkdir(exist_ok=True)
    elevation_m, transform = read_grid()
    elevation_m = fill_gaps(elevation_m)

    small_m, factor = downsample(elevation_m)
    lat0 = SECTION_LAT_FROM
    cell_w_m = transform.a * factor * KM_PER_DEG * np.cos(np.radians(lat0)) * 1000
    cell_h_m = -transform.e * factor * KM_PER_DEG * 1000
    print(
        f"mesh grid {small_m.shape[1]} x {small_m.shape[0]} (factor {factor}), "
        f"cells about {cell_w_m:.0f} x {cell_h_m:.0f} m"
    )
    terrarium_png(small_m, LAYERS_DIR / "relief.png")

    points = section_profile(elevation_m, transform)
    deepest = max(points, key=lambda p: p[1])
    print(
        f"section: {len(points)} points over {points[-1][0] - points[0][0]:.1f} km, "
        f"deepest {deepest[1]} m at {deepest[0]} km from the north end"
    )
    write_json(
        {
            "lon": SECTION_LON,
            "lat_from": SECTION_LAT_FROM,
            "lat_to": SECTION_LAT_TO,
            "columns": ["distance_km_from_north", "depth_m"],
            "points": points,
        },
        LAYERS_DIR / "section.json",
    )

    figures = json.loads(FIGURES_FILE.read_text())
    deepest_depth_m = figure(figures, "deepest_depth")
    if abs(deepest_depth_m - deepest[1]) > 1:
        raise ValueError("the section misses the deepest cell: check SECTION_LON")
    scene = {
        "page_type": PAGE_TYPE,
        # The page plays the frames up to here; the last beat (the way back to the opening view,
        # a slow return the page replaces with its own 1 s ease) is skipped there.
        "page_end_s": 11.8,
        "indicators": INDICATORS,
        "fps": 30,
        "frames": 435,
        "length_s": 14.5,
        "frame_px": list(FRAME_PX),
        "hero_frame": 30,
        "place": {
            "bbox": {"west": 140.6, "east": 143.8, "south": 10.2, "north": 12.6},
            "deepest_point": [142.2081, 11.3342],
            "section_line": {
                "lon": SECTION_LON,
                "lat_from": SECTION_LAT_FROM,
                "lat_to": SECTION_LAT_TO,
            },
        },
        "relief": relief_bounds(transform, factor, small_m.shape),
        "exaggeration": EXAGGERATION,
        "rock_floor_m": ROCK_FLOOR_M,
        "deepest_depth_m": deepest_depth_m,
        "peak": {
            "height_m": figure(figures, "everest_height"),
            "base_half_width_km": PEAK_BASE_HALF_WIDTH_KM,
        },
        "side_view_target_depth_m": round(side_view_target_depth_m(), 1),
        "look": LOOK,
        "beats": BEATS,
        "tweens": TWEENS,
    }
    write_json(scene, LAYERS_DIR / "scene.json")

    # The page shows a few figures as text (the lede, labels, notes). It takes their display text
    # from data/key_figures.json, so the screen always says what the analysis says.
    shown = ["deepest_depth", "deepest_location", "everest_height", "water_above_everest"]
    write_json(
        {
            f["id"]: {"value": f["value"], "display": f["display"]}
            for f in figures
            if f["id"] in shown
        },
        LAYERS_DIR / "figures.json",
    )

    sources = json.loads(SOURCES_FILE.read_text())
    meta = {"sources": [{"name": s["name"], "downloaded": s["downloaded"]} for s in sources]}
    write_json(meta, LAYERS_DIR / "meta.json")

    for path in sorted(LAYERS_DIR.iterdir()):
        print(f"wrote {path.relative_to(PIECE)}  {path.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
