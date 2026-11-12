"""Compute the key figures for "Why almost nobody lives in most of Egypt".

What it does: I cut Egypt out of the GHS-POP 2025 population grid, sort its 1 km cells from
the most to the least crowded, and walk down the list until I have 95% of all Egyptians. The
area of those cells, as a share of the whole country, is the hook: "95% of people live on
Y% of the land". I check my totals against published figures and compare with Egypt's average.
Reads:  data/raw/GHS_POP_E2025_GLOBE_R2023A_54009_100_V1_0_<tile>/*.tif and
        data/raw/ne_10m_admin_0_countries/ (run data/download.py first). No network.
Writes: data/key_figures.json
Run:    uv run data/key_figures.py   (from the piece folder)

What you learn: why "share of the land" depends on the size of the cells you count. People
do not live on every square metre of the Nile valley: the fields, the river and the roads
between villages are empty. On the 100 m grid, 95% of Egyptians fit on under 1% of the
country, because only rooftops count. On a 1 km grid the same people need about twice the
land, because a cell with a village counts as lived-in even if half of it is fields. Neither
number is wrong; they answer slightly different questions. I report the 1 km figure because
1 km2 is the standard grid of the Degree of Urbanisation, the UN-endorsed method GHSL itself
uses to say where people live, and I print the 100 m figure next to it so the choice is
visible. The grid is in World Mollweide (ESRI:54009), an equal-area projection, so every
cell has the same true area and a share of cells is a share of land.
"""

import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.features import geometry_mask
from rasterio.merge import merge

HERE = Path(__file__).parent
RAW_DIR = HERE / "raw"
GHS_GLOB = "GHS_POP_E2025_GLOBE_R2023A_54009_100_V1_0_R*_C*/*.tif"
EXPECTED_TILES = 4
COUNTRIES_SHP = RAW_DIR / "ne_10m_admin_0_countries" / "ne_10m_admin_0_countries.shp"
OUT_FILE = HERE / "key_figures.json"

COUNTRY_A3 = "EGY"
# World Mollweide, the grid's own CRS. Equal-area, so I can measure areas in it directly
# and never resample the population grid (resampling would smear people across cells).
GRID_CRS = "ESRI:54009"
CELL_M = 100  # GHS-POP cell size
AGG_CELLS = 10  # 10 x 10 cells of 100 m = the 1 km grid of the Degree of Urbanisation
NODATA = -200.0  # GHS-POP marks cells outside its land mask (sea, some lakes) with -200
SHARE_PEOPLE = 0.95  # the share of people I hold fixed; 95% is also the published figure

SRC_POP = "GHS-POP R2023A, epoch 2025 (European Commission JRC)"
SRC_BORDER = "Natural Earth 1:10m admin 0"

# Published figures I check against. The World Bank lists Egypt's surface area and the UN
# World Population Prospects 2024 estimate for 2025 (medium variant) in its WDI database.
WB_AREA_URL = "https://data.worldbank.org/indicator/AG.SRF.TOTL.K2?locations=EG"
WB_AREA_KM2 = 1_001_450  # "Surface area (sq. km)", Egypt, 2024
WB_POP_URL = "https://data.worldbank.org/indicator/SP.POP.TOTL?locations=EG"
WB_POP_2025 = 118_365_995  # "Population, total", Egypt, 2025 (UN WPP 2024)
MAX_DIFF = 0.10


def load_border() -> gpd.GeoSeries:
    """Egypt's border in the grid's CRS. Natural Earth draws the de facto border, so the
    Halaib triangle (administered by Egypt) is inside and Bir Tawil is not."""
    if not COUNTRIES_SHP.exists():
        raise FileNotFoundError(f"{COUNTRIES_SHP} is missing: run uv run data/download.py first")
    countries = gpd.read_file(COUNTRIES_SHP)
    egypt = countries[countries["ADM0_A3"] == COUNTRY_A3]
    if len(egypt) != 1:
        raise ValueError(f"expected one {COUNTRY_A3} row, found {len(egypt)}")
    return egypt.to_crs(GRID_CRS).geometry


def load_population(border: gpd.GeoSeries) -> tuple[np.ndarray, rasterio.Affine]:
    """Mosaic the four tiles over Egypt's bounding box, snapped to the 1 km grid.

    GHS-POP's tiles start at x = -18,041,000 m, y = 9,000,000 m, both multiples of 1 km, so
    snapping my window to whole kilometres makes every block of 10 x 10 cells line up with
    GHSL's own 1 km grid.
    """
    tiles = sorted(RAW_DIR.glob(GHS_GLOB))
    if len(tiles) != EXPECTED_TILES:
        raise FileNotFoundError(f"found {len(tiles)} GHS-POP tiles, expected {EXPECTED_TILES}")
    step_m = CELL_M * AGG_CELLS
    x0, y0, x1, y1 = border.total_bounds
    bounds = (
        np.floor(x0 / step_m) * step_m,
        np.floor(y0 / step_m) * step_m,
        np.ceil(x1 / step_m) * step_m,
        np.ceil(y1 / step_m) * step_m,
    )
    sources = [rasterio.open(t) for t in tiles]
    for src in sources:
        if src.crs.to_string() != GRID_CRS or src.res != (CELL_M, CELL_M):
            raise ValueError(f"{src.name}: expected {GRID_CRS} at {CELL_M} m, got {src.crs}")
    # The tiles must cover the whole border, or people would silently go missing.
    left = min(s.bounds.left for s in sources)
    right = max(s.bounds.right for s in sources)
    bottom = min(s.bounds.bottom for s in sources)
    top = max(s.bounds.top for s in sources)
    if not (left <= bounds[0] and bounds[2] <= right and bottom <= bounds[1] and bounds[3] <= top):
        raise ValueError("the downloaded tiles do not cover Egypt: check GHS_TILES")
    mosaic, transform = merge(sources, bounds=bounds, nodata=NODATA)
    for src in sources:
        src.close()
    return mosaic[0], transform


def egypt_cells(border: gpd.GeoSeries, shape: tuple[int, int], transform) -> np.ndarray:
    """True for every 100 m cell whose centre lies inside Egypt."""
    return ~geometry_mask(border, out_shape=shape, transform=transform)


def area_share_for(pop: np.ndarray, area_km2: np.ndarray, total_km2: float) -> float:
    """Smallest share of the country that holds SHARE_PEOPLE of its people.

    I rank cells by density (people per km2), not by head count: a border cell that is only
    a third inside Egypt has a third of the area, and ranking by head count would favour
    full cells. Then I add up area until the running population passes the threshold.
    """
    keep = area_km2 > 0
    pop, area_km2 = pop[keep], area_km2[keep]
    density = pop / area_km2
    order = np.argsort(-density, kind="stable")
    cum_pop = np.cumsum(pop[order])
    target = SHARE_PEOPLE * cum_pop[-1]
    k = np.searchsorted(cum_pop, target) + 1
    land_km2 = area_km2[order][:k].sum()
    return float(land_km2 / total_km2)


def to_1km(values: np.ndarray) -> np.ndarray:
    """Sum blocks of AGG_CELLS x AGG_CELLS cells. The window is snapped, so blocks fit."""
    h, w = values.shape
    if h % AGG_CELLS or w % AGG_CELLS:
        raise ValueError("window is not a whole number of 1 km cells")
    return values.reshape(h // AGG_CELLS, AGG_CELLS, w // AGG_CELLS, AGG_CELLS).sum(axis=(1, 3))


def check(label: str, mine: float, published: float) -> None:
    """Stop the script if my number and the published one differ by more than 10%."""
    diff = mine / published - 1
    print(f"check  {label}: mine {mine:,.0f}, published {published:,.0f}, diff {diff:+.2%}")
    if abs(diff) > MAX_DIFF:
        raise ValueError(f"{label} differs from the published figure by {diff:+.1%}")


def main() -> None:
    border = load_border()
    grid, transform = load_population(border)
    inside = egypt_cells(border, grid.shape, transform)
    # Nodata cells inside the border are sea along the coast and parts of the big lakes.
    # Nobody lives there, so they count as 0 people, but they stay in the country's area,
    # because the official surface area includes inland water too.
    pop = np.where(inside & (grid > 0), grid, 0.0)
    if grid[inside & (grid != NODATA)].min() < 0 or grid.max() > 200_000:
        raise ValueError("population values outside 0 to 200,000 per cell: check the grid")
    cell_km2 = (CELL_M / 1000) ** 2
    area_km2 = inside * cell_km2
    total_km2 = float(area_km2.sum())
    total_pop = float(pop.sum())

    check("Egypt area, km2", total_km2, WB_AREA_KM2)
    check("Egypt population 2025", total_pop, WB_POP_2025)

    share_100m = area_share_for(pop.ravel(), area_km2.ravel(), total_km2)
    share_1km = area_share_for(to_1km(pop).ravel(), to_1km(area_km2).ravel(), total_km2)
    if not 0 < share_100m < share_1km < 0.2:
        raise ValueError(f"unexpected land shares: 100 m {share_100m}, 1 km {share_1km}")
    print(f"info   {SHARE_PEOPLE:.0%} of people on {share_100m:.2%} of land (100 m cells)")
    print(f"info   {SHARE_PEOPLE:.0%} of people on {share_1km:.2%} of land (1 km cells)")

    land_km2 = share_1km * total_km2
    figures = [
        {
            "id": "share_people_pct",
            "value": round(SHARE_PEOPLE * 100, 1),
            "unit": "% of Egypt's population",
            "display": f"{SHARE_PEOPLE:.0%}",
            "source": SRC_POP,
            "method": "Fixed threshold, the same 95% that published sources give for the Nile "
            f"valley and delta; GHS-POP total inside the border is {total_pop / 1e6:.1f} million",
        },
        {
            "id": "share_land_pct",
            "value": round(share_1km * 100, 1),
            "unit": "% of Egypt's area",
            "display": f"{share_1km:.1%}",
            "source": f"{SRC_POP}; border {SRC_BORDER}",
            "method": "1 km cells (10 x 10 GHS-POP cells, Mollweide) ranked by density; area of "
            f"the densest cells holding 95% of people ({land_km2:,.0f} km2) / Egypt's area "
            f"({total_km2:,.0f} km2). On 100 m cells it is {share_100m:.1%}",
        },
    ]
    # How crowded is the land where Egyptians live? The people in the 95% squares over their
    # area, against all people over all of Egypt. Both come from the same grid and border, so
    # the ratio is fair. (Comparing the strip with whole countries would not be: a country's
    # density averages over its empty land too, and the strip was picked to leave that out.)
    inhabited_per_km2 = SHARE_PEOPLE * total_pop / land_km2
    egypt_per_km2 = total_pop / total_km2
    ratio = inhabited_per_km2 / egypt_per_km2
    print(
        f"info   inhabited strip {inhabited_per_km2:,.0f} per km2, all of Egypt "
        f"{egypt_per_km2:,.0f} per km2, {ratio:.1f} times"
    )
    figures += [
        {
            "id": "inhabited_density",
            "value": round(inhabited_per_km2),
            "unit": "people per km2 on the squares where 95% of Egyptians live",
            "display": f"{round(inhabited_per_km2, -1):,.0f}",
            "source": SRC_POP,
            "method": f"95% of the GHS-POP total ({SHARE_PEOPLE * total_pop / 1e6:.1f} million) "
            f"/ the area of the 95% squares ({land_km2:,.0f} km2)",
        },
        {
            "id": "egypt_density",
            "value": round(egypt_per_km2, 1),
            "unit": "people per km2 over all of Egypt",
            "display": f"{egypt_per_km2:,.0f}",
            "source": f"{SRC_POP}; border {SRC_BORDER}",
            "method": f"GHS-POP total ({total_pop / 1e6:.1f} million) / Egypt's area "
            f"({total_km2:,.0f} km2), the same grid and border as the other figures",
        },
        {
            "id": "density_ratio",
            "value": round(ratio, 1),
            "unit": "times Egypt's average density, on the squares where 95% live",
            "display": f"{ratio:.0f}",
            "source": f"{SRC_POP}; border {SRC_BORDER}",
            "method": "inhabited_density / egypt_density, both unrounded",
        },
    ]
    OUT_FILE.write_text(json.dumps(figures, indent=2, ensure_ascii=False) + "\n")
    print(f"\n{'id':<18} {'value':>8}  {'display':<8} unit")
    for f in figures:
        print(f"{f['id']:<18} {f['value']:>8}  {f['display']:<8} {f['unit']}")
    print(f"\nwrote  {OUT_FILE}")


if __name__ == "__main__":
    main()
