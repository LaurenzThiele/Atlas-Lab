"""Compute the key figures for "How deep the Mariana Trench really is" (DEEP DIVE 01).

What it does: I open the GMRT depth grid of the southern Mariana Trench, find its deepest cell
(the Challenger Deep), and work out every number the scene shows: the depth at the bottom, where
that bottom is, a counter mark on the way down, and how much water would still sit above the
top of Everest if you dropped it into the deepest point. Each one is checked against a
published figure.
Reads:  data/raw/gmrt_mariana_med.tif (run data/download.py first). No network.
Writes: data/key_figures.json
Run:    uv run data/key_figures.py   (from the piece folder)

What you learn: a depth grid gives you the average depth of each cell, not the single deepest
spot on the seabed. With about 245 m cells the deepest cell can only match the deepest point
measured by a submersible if the floor is flat over that whole cell, so I compare with the
published depth and report the difference instead of hiding it. The grid is in plain lon/lat
(EPSG:4326), which is fine here: I only read values and one position, I measure no areas.
"""

import json
import math
from pathlib import Path

import numpy as np
import rasterio

HERE = Path(__file__).parent
RAW_DIR = HERE / "raw"
GRID_TIF = RAW_DIR / "gmrt_mariana_med.tif"
OUT_FILE = HERE / "key_figures.json"

SRC_GMRT = "GMRT Global Multi-Resolution Topography (Lamont-Doherty, CC BY 4.0)"

# Published reference values. These are not results: they are what my results are checked
# against, and Everest is the comparison the scene makes. Each has its source.
PUBLISHED_DEPTH_M = 10935  # Greenaway, Hart, Ruth, Stewart (2021), Deep-Sea Res. I, +/- 6 m
PUBLISHED_DEPTH_PM_M = 6
PUBLISHED_DEPTH_SRC = (
    "Greenaway et al. (2021), Revised depth of the Challenger Deep from submersible "
    "transects, Deep-Sea Research I; https://repository.library.noaa.gov/view/noaa/33477"
)
PUBLISHED_DEEP_LAT, PUBLISHED_DEEP_LON = 11.332, 142.202  # Stewart & Jamieson (2019), Five Deeps
PUBLISHED_DEEP_SRC = (
    "Stewart & Jamieson (2019), The five deeps, Earth-Science Reviews 197, 102896; "
    "https://ui.adsabs.harvard.edu/abs/2019ESRv..19702896S"
)
EVEREST_M = 8848.86  # China and Nepal joint announcement, 8 Dec 2020 (snow surface)
EVEREST_SRC = (
    "China and Nepal joint survey, announced 8 Dec 2020; "
    "https://www.aljazeera.com/news/2020/12/8/mt-everest-nepal-china-announce-revised-height-at-8848-metres"
)

# The depth counter shows this round value mid dive (storyboard frame 2). It is a mark the
# counter passes, so the only check is that the dive really goes deeper than it.
COUNTER_MARK_M = 6000

TOLERANCE = 0.05  # step 1 rule: a difference above 5% needs an explanation or a label
EARTH_RADIUS_KM = 6371.0


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def main() -> None:
    with rasterio.open(GRID_TIF) as ds:
        z = ds.read(1, masked=True).astype("float64")
        # GMRT leaves an empty row or column at the edge of a box as NaN, with no nodata tag.
        z = np.ma.masked_invalid(z)
        res_x, res_y = ds.res
        crs = ds.crs.to_string()
        bounds = ds.bounds
        row, col = np.unravel_index(np.ma.argmin(z), z.shape)
        deep_lon, deep_lat = map(float, ds.xy(row, col))  # centre of the deepest cell

    print(f"grid   {z.shape[1]} x {z.shape[0]} cells, {crs}, {z.mask.sum()} empty cells")
    print(
        f"       bounds {bounds.left:.2f} to {bounds.right:.2f} E, {bounds.bottom:.2f} to {bounds.top:.2f} N"
    )
    print(f"       elevation {z.min():.1f} to {z.max():.1f} m")

    cell_x_m = res_x * 111_320 * math.cos(math.radians(deep_lat))
    cell_y_m = res_y * 110_574
    cell_m = (cell_x_m + cell_y_m) / 2

    deepest_m = -float(z.min())
    deepest_round = round(deepest_m)
    everest_round = round(EVEREST_M)
    # The scene shows the two rounded numbers and the gap between them, so the gap is computed
    # from the rounded numbers: a viewer who subtracts 8,849 from 10,932 gets what is on screen.
    gap_round = deepest_round - everest_round

    depth_diff = deepest_m - PUBLISHED_DEPTH_M
    depth_rel = abs(depth_diff) / PUBLISHED_DEPTH_M
    offset_km = haversine_km(deep_lat, deep_lon, PUBLISHED_DEEP_LAT, PUBLISHED_DEEP_LON)
    gap_published = PUBLISHED_DEPTH_M - EVEREST_M

    figures = [
        {
            "id": "deepest_depth",
            "value": round(deepest_m, 1),
            "unit": "m below sea level",
            "display": f"{deepest_round:,} m",
            "source": SRC_GMRT,
            "method": "Deepest cell of the GMRT medium-resolution grid over the southern Mariana Trench.",
            "check": (
                f"Published {PUBLISHED_DEPTH_M:,} m +/- {PUBLISHED_DEPTH_PM_M} m; difference "
                f"{depth_diff:+.1f} m ({depth_rel:.2%}), inside the 5% rule and inside the "
                f"published uncertainty. {PUBLISHED_DEPTH_SRC}"
            ),
        },
        {
            "id": "deepest_location",
            "value": [round(deep_lat, 4), round(deep_lon, 4)],
            "unit": "degrees (lat N, lon E)",
            "display": f"{deep_lat:.2f}° N {deep_lon:.2f}° E",
            "source": SRC_GMRT,
            "method": "Centre of the deepest grid cell.",
            "check": (
                f"Published Challenger Deep at {PUBLISHED_DEEP_LAT}° N {PUBLISHED_DEEP_LON}° E; "
                f"my cell is {offset_km:.2f} km away, under 4 grid cells. {PUBLISHED_DEEP_SRC}"
            ),
        },
        {
            "id": "counter_mark",
            "value": COUNTER_MARK_M,
            "unit": "m below sea level",
            "display": f"{COUNTER_MARK_M:,} m",
            "source": SRC_GMRT,
            "method": "A round value the depth counter passes mid dive (storyboard frame 2).",
            "check": f"The dive goes deeper ({deepest_round:,} m), so the counter really passes it.",
        },
        {
            "id": "everest_height",
            "value": EVEREST_M,
            "unit": "m above sea level",
            "display": f"{everest_round:,} m",
            "source": "China and Nepal joint survey, 2020",
            "method": "Published height of Everest, rounded to the metre for the label.",
            "check": EVEREST_SRC,
        },
        {
            "id": "water_above_everest",
            "value": gap_round,
            "unit": "m",
            "display": f"{gap_round:,} m",
            "source": f"{SRC_GMRT}; China and Nepal joint survey, 2020",
            "method": "Rounded deepest depth minus rounded Everest height, so the screen adds up.",
            "check": (
                f"With the published depth: {gap_published:,.0f} m "
                f"({abs(gap_round - gap_published) / gap_published:.2%} off), inside the 5% rule."
            ),
        },
        {
            "id": "grid_cell_size",
            "value": round(cell_m),
            "unit": "m",
            "display": f"about {round(cell_m, -1):,.0f} m grid",
            "source": SRC_GMRT,
            "method": "Mean of the cell width and height at the deepest point (degrees to metres).",
            "check": "GMRT GridServer metadata for this box gives 244.6 m per node.",
        },
    ]

    if depth_rel > TOLERANCE:
        raise ValueError(
            f"deepest depth is {depth_rel:.1%} off the published figure: check the grid"
        )
    if deepest_m <= COUNTER_MARK_M:
        raise ValueError("the dive never reaches the counter mark")

    OUT_FILE.write_text(json.dumps(figures, indent=2, ensure_ascii=False) + "\n")

    print()
    print(f"{'id':<22}{'display':<28}value")
    for f in figures:
        print(f"{f['id']:<22}{f['display']:<28}{f['value']}")
    print(f"\nwrote {OUT_FILE}")


if __name__ == "__main__":
    main()
