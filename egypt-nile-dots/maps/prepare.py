"""Turn the population grid and Natural Earth into the small layers the map loads.

What it does: I cut Egypt out of the GHS-POP 2025 grid, draw one dot for every 250 people at a
random spot inside the 100 m cell where they live, sum the grid to 1 km squares and rank them
from the most to the fewest people per km2, and cut a flat printed plate (land, sea, border,
Nile, lakes) out of Natural Earth.
Reads:  data/raw/ (run uv run data/download.py first), data/key_figures.py (imported, so the map
        and the key figures always come from the same code) and data/key_figures.json
Writes: maps/layers/dots.bin, dots.json      one dot per 250 people, in typed arrays
        maps/layers/squares.bin, squares.json the 1 km squares with people, densest first
        maps/layers/share_curve.json          land share for every share of people, 50 to 99%
        maps/layers/land.json, egypt_border.json, nile_lakes.json   the plate (GeoJSON)
        maps/layers/labels.json, key_figures.json, meta.json
        maps/layers/download/                 the files offered under "Download the data"
Run:    uv run maps/prepare.py   (from the piece folder; about a minute)

What you learn: how a dot-density map is built from a raster (stochastic rounding, so that no
fraction of a person is lost or invented, and random placement inside each cell, so the dots do
not draw the grid), why the density ranking needs real areas for border squares, and how to
pack half a million points into a few typed arrays a browser can hand straight to the GPU,
with a run-length trick that halves the file.
"""

import json
import shutil
import sys
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from pyproj import Transformer
from shapely.geometry import box, mapping

HERE = Path(__file__).parent
PIECE_DIR = HERE.parent
DATA_DIR = PIECE_DIR / "data"
RAW_DIR = DATA_DIR / "raw"
OUT_DIR = HERE / "layers"
DOWNLOAD_DIR = OUT_DIR / "download"

# I import the GIS of the key figures instead of writing it a second time: the same border, the
# same mosaic and the same ranking, so the map can never disagree with the key figures.
sys.path.insert(0, str(DATA_DIR))
from key_figures import (
    AGG_CELLS,
    CELL_M,
    GRID_CRS,
    SHARE_PEOPLE,
    area_share_for,
    egypt_cells,
    load_border,
    load_population,
    to_1km,
)

KEY_FIGURES = DATA_DIR / "key_figures.json"
SOURCES_JSON = RAW_DIR / "sources.json"
COUNTRIES_SHP = RAW_DIR / "ne_10m_admin_0_countries" / "ne_10m_admin_0_countries.shp"
RIVERS_SHP = RAW_DIR / "ne_10m_rivers_lake_centerlines" / "ne_10m_rivers_lake_centerlines.shp"
LAKES_SHP = RAW_DIR / "ne_10m_lakes" / "ne_10m_lakes.shp"

SEED = 7  # one seed for the whole drawing, so every build places every dot in the same spot
PEOPLE_PER_DOT = 250
DOTS_TOLERANCE = 0.005  # dots x 250 must stay within 0.5% of the people in the grid
SQUARE_M = CELL_M * AGG_CELLS  # 1 km
SHARE_RANGE_PCT = range(50, 101)  # the slider: 50% to 100% of people

# The plate. The map itself is about Egypt, but a tilted view of a tall phone frame looks far
# past Egypt's borders, so I cut the neighbours from a wider box than Egypt needs (12 to 48 E,
# 10 to 42 N). A narrower cut would leave bare sea-coloured background where Libya or the
# Levant should be. The rivers and lakes come from the same box.
PLATE_BOX = (12.0, 10.0, 48.0, 42.0)
EGYPT_A3 = "EGY"
# EPSG:22992, Egypt Red Belt: a metric Transverse Mercator made for Egypt. I simplify and
# measure in metres, and this projection keeps lengths true to well under 1% across the
# country, where degrees would mean different distances east-west and north-south.
METRIC_CRS = "EPSG:22992"
SIMPLIFY_M = 200  # about one pixel at zoom 9, the closest the plate is meant to be seen
DECIMALS = 5  # about 1 m, far finer than the 1:10m source
NILE_NAMES = ("Nile", "Rosetta Branch", "Damietta Branch")

# Label anchors (lon, lat). kind sets the face and colour in style.css: towns in Reem Kufi,
# seas in italic Plex in Egyptian blue, deserts and countries spaced out in dune shadow, water
# names (subject labels that can switch to red ochre) in Reem Kufi in Egyptian blue.
LABELS = [
    ("Cairo", 31.2357, 30.0444, "town"),
    ("Giza", 31.2089, 30.0131, "town"),
    ("Alexandria", 29.9187, 31.2001, "town"),
    ("Luxor", 32.6396, 25.6872, "town"),
    ("Aswan", 32.8998, 24.0889, "town"),
    ("Siwa", 25.5195, 29.2032, "town"),
    ("Kharga", 30.5465, 25.4390, "town"),
    ("Nile", 31.25, 27.6, "water"),
    ("Nile Delta", 31.0, 30.95, "delta"),
    ("Lake Nasser", 32.3, 22.9, "water"),
    ("Western Desert", 27.5, 26.5, "desert"),
    ("Eastern Desert", 33.3, 26.3, "desert"),
    ("Sinai", 33.8, 29.5, "desert"),
    ("Mediterranean Sea", 29.5, 32.6, "sea"),
    ("Red Sea", 35.6, 25.0, "sea"),
    ("Sahara", 25.5, 25.0, "desert"),
    ("Libya", 23.0, 27.0, "country"),
    ("Sudan", 31.0, 20.5, "country"),
    ("Egypt", 29.3, 27.8, "egypt"),
]

# The only two figures the map may show, exactly as key_figures.json displays them.
EXPECTED_DISPLAY = {"share_people_pct": "95%", "share_land_pct": "2.2%"}
EXPECTED_LAND_KM2 = 22_090
EXPECTED_LAND_PCT = 2.2


# ---- Population ----------------------------------------------------------------------------


def egypt_population() -> tuple[np.ndarray, np.ndarray, object]:
    """People and area per 100 m cell inside Egypt, exactly as key_figures.py counts them."""
    border = load_border()
    grid, transform = load_population(border)
    inside = egypt_cells(border, grid.shape, transform)
    # Nodata (-200, sea and some lakes) and any negative value are 0 people. They stay part of
    # Egypt's area, as in key_figures.py, because the country's area includes its water.
    pop = np.where(inside & (grid > 0), grid, 0.0)
    area_km2 = inside * (CELL_M / 1000) ** 2
    return pop, area_km2, transform


def place_dots(people, x0_m, y0_m, rng):
    """One dot per PEOPLE_PER_DOT people, at a random spot inside each cell.

    people holds the people of each lived-in cell, x0_m and y0_m its top-left corner in
    Mollweide metres. A cell with 610 people gets 2 dots, plus a third with a chance of
    110/250: rounded this way (stochastic rounding) the dots add up to the real total, where
    plain rounding would drop every cell under 125 people and empty the desert. Each dot then
    lands anywhere in its 100 m cell. A dot on every cell centre would print a 100 m grid
    that is not in the world; at random, the dots read as people, not as a raster.
    """
    exact = people / PEOPLE_PER_DOT
    n = np.floor(exact).astype(np.int64)
    n += rng.random(n.size) < exact - n
    cell = np.repeat(np.arange(n.size), n)
    dx_m = rng.random(cell.size) * CELL_M
    dy_m = rng.random(cell.size) * CELL_M
    x_m = x0_m[cell] + dx_m
    y_m = y0_m[cell] - dy_m
    return x_m, y_m, cell


def quantise(values: np.ndarray, low: float, high: float) -> np.ndarray:
    """Map values in [low, high] onto 0 to 65535. Over Egypt's 12 degrees that is a step of
    about 20 m, finer than the dots ever need: a 2 px dot at zoom 10 covers 300 m."""
    q = np.round((values - low) / (high - low) * 65535)
    if q.min() < 0 or q.max() > 65535:
        raise ValueError("a dot lies outside the quantisation box")
    return q.astype("<u2")


def write_dots(q_lon: np.ndarray, q_lat: np.ndarray, dense: np.ndarray) -> None:
    """Pack the dots for the browser in as few bytes as their positions need.

    The desert dots (outside the 95% squares) come first, then the valley dots, so the dense
    flag needs no byte of its own: dots.json says where one group ends. Within each group the
    dots run south to north, so their latitudes only ever step up. Instead of one latitude per
    dot I store how many dots sit on each of the 65,536 latitude steps (run-length coding), and
    the browser rebuilds the list from the counts. The positions are exactly the same; the file
    shrinks from 5 to about 2.6 bytes per dot.
    """
    lon_blocks, count_blocks = [], []
    for flag in (0, 1):
        pick = np.flatnonzero(dense == flag)
        pick = pick[np.lexsort((q_lon[pick], q_lat[pick]))]
        counts = np.bincount(q_lat[pick], minlength=65536)
        if counts.max() > 65535:
            raise ValueError("more than 65,535 dots on one latitude step: use uint32 counts")
        lon_blocks.append(q_lon[pick])
        count_blocks.append(counts.astype("<u2"))
    with open(OUT_DIR / "dots.bin", "wb") as f:
        f.write(np.concatenate(lon_blocks).astype("<u2").tobytes())
        for counts in count_blocks:
            f.write(counts.tobytes())


# ---- 1 km squares --------------------------------------------------------------------------


def rank_squares(pop_1km: np.ndarray, area_1km: np.ndarray) -> pd.DataFrame:
    """Every 1 km square with people, densest first, with its running share of people.

    The ranking is the one area_share_for uses (people per km2, stable sort over every square
    with area), so the squares the map shades are exactly the ones the key figure counts.
    """
    pop, area = pop_1km.ravel(), area_1km.ravel()
    index = np.flatnonzero(area > 0)
    density = pop[index] / area[index]
    order = index[np.argsort(-density, kind="stable")]
    order = order[pop[order] > 0]  # empty squares rank last and are never in any set
    people = pop[order]
    total = people.sum()
    cum_after = np.cumsum(people) / total
    rows, cols = np.divmod(order, pop_1km.shape[1])
    return pd.DataFrame(
        {
            "row": rows,
            "col": cols,
            "people": people,
            "area_km2": area[order],
            "per_km2": people / area[order],
            "cum_before": cum_after - people / total,
            "cum_share": cum_after,
        }
    )


def write_squares(squares: pd.DataFrame) -> None:
    """Pack the 1 km squares in 13 bytes each instead of five floats (20 bytes).

    A square needs no coordinates of its own: its column and row on the 1 km grid say where it
    is, and the browser turns them into corners with the Mollweide formulas (mollweide.js). Its
    area inside Egypt is a whole number of 100 m cells, so hundredths of a km2 fit one byte
    exactly; people per km2 is then people / area, computed in the browser.
    """
    area_hundredths = np.round(squares["area_km2"].to_numpy() * 100)
    if not np.allclose(area_hundredths / 100, squares["area_km2"]) or area_hundredths.max() > 100:
        raise ValueError("a square's area is not a whole number of 100 m cells")
    if squares["col"].max() > 65535 or squares["row"].max() > 65535:
        raise ValueError("the grid is too large for uint16 columns and rows")
    with open(OUT_DIR / "squares.bin", "wb") as f:
        f.write(squares["people"].to_numpy().astype("<f4").tobytes())
        f.write(squares["cum_before"].to_numpy().astype("<f4").tobytes())
        f.write(squares["col"].to_numpy().astype("<u2").tobytes())
        f.write(squares["row"].to_numpy().astype("<u2").tobytes())
        f.write(area_hundredths.astype("u1").tobytes())


def square_centres(squares: pd.DataFrame, transform) -> tuple[np.ndarray, np.ndarray]:
    """Centre of each 1 km square in Mollweide metres."""
    x_m = transform.c + (squares["col"].to_numpy() + 0.5) * SQUARE_M
    y_m = transform.f - (squares["row"].to_numpy() + 0.5) * SQUARE_M
    return x_m, y_m


def share_curve(pop_1km: np.ndarray, area_1km: np.ndarray, total_km2: float) -> list[dict]:
    """Land share for every whole percent of people, from the key figures' own function."""
    import key_figures

    curve = []
    for pct in SHARE_RANGE_PCT:
        # area_share_for reads SHARE_PEOPLE from its module, so I set it there for each step.
        key_figures.SHARE_PEOPLE = pct / 100
        share = area_share_for(pop_1km.ravel(), area_1km.ravel(), total_km2)
        curve.append(
            {
                "people_pct": pct,
                "land_pct": round(share * 100, 1),
                "land_km2": int(round(share * total_km2 / 10) * 10),
            }
        )
    key_figures.SHARE_PEOPLE = SHARE_PEOPLE
    return curve


# ---- Plate ---------------------------------------------------------------------------------


def round_coords(geometry: dict) -> dict:
    """Round every coordinate of a GeoJSON geometry to DECIMALS places."""

    def walk(value):
        if isinstance(value, (list, tuple)) and value and isinstance(value[0], (int, float)):
            return [round(float(v), DECIMALS) for v in value]
        return [walk(v) for v in value]

    return {"type": geometry["type"], "coordinates": walk(geometry["coordinates"])}


def write_geojson(frame: gpd.GeoDataFrame, path: Path, properties: list[str]) -> None:
    """Small GeoJSON: only the properties the map uses, 5 decimals, no spaces."""
    features = []
    for _, row in frame.iterrows():
        if row.geometry is None or row.geometry.is_empty:
            continue
        features.append(
            {
                "type": "Feature",
                "properties": {p: row[p] for p in properties},
                "geometry": round_coords(mapping(row.geometry)),
            }
        )
    collection = {"type": "FeatureCollection", "features": features}
    path.write_text(json.dumps(collection, separators=(",", ":")))


def simplify_for_display(frame: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Simplify in metres, then back to lon/lat. Display only: I measure on the raw geometry."""
    metric = frame.to_crs(METRIC_CRS)
    metric["geometry"] = metric.simplify(SIMPLIFY_M, preserve_topology=True).make_valid()
    return metric.to_crs("EPSG:4326")


def split_by_egypt(water: gpd.GeoDataFrame, egypt: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Cut every river and lake at Egypt's border and tag each piece inside true or false.

    The map draws the water outside Egypt lighter: it is context (the Nile comes from Sudan),
    not the subject. An overlay cuts each line or lake exactly where it crosses the border.
    """
    border = egypt.geometry.union_all()
    inside = water.assign(geometry=water.intersection(border), inside=True)
    outside = water.assign(geometry=water.difference(border), inside=False)
    pieces = pd.concat([inside, outside], ignore_index=True)
    pieces = pieces[~pieces.geometry.isna()]
    pieces = pieces[~pieces.geometry.is_empty]
    return gpd.GeoDataFrame(pieces, geometry="geometry", crs=water.crs)


def build_plate() -> float:
    """Write land, border, Nile and lakes; return the length of the Nile's main stem in Egypt."""
    plate = box(*PLATE_BOX)
    countries = gpd.read_file(COUNTRIES_SHP)[["ADM0_A3", "geometry"]]
    land = gpd.clip(countries, plate)
    land["egypt"] = land["ADM0_A3"] == EGYPT_A3
    land = simplify_for_display(land)
    # Neighbours first, Egypt last, so its fill is drawn over any sliver the simplification
    # left along the shared border.
    land = land.sort_values("egypt")
    write_geojson(land, OUT_DIR / "land.json", ["egypt"])

    egypt = countries[countries["ADM0_A3"] == EGYPT_A3]
    outline = simplify_for_display(egypt.assign(geometry=egypt.boundary))
    write_geojson(outline, OUT_DIR / "egypt_border.json", [])

    rivers = gpd.read_file(RIVERS_SHP)
    rivers = rivers[rivers.intersects(plate)]
    print("rivers in the plate:", ", ".join(sorted(rivers["name"].fillna("(no name)").unique())))
    lakes = gpd.read_file(LAKES_SHP)
    lakes = lakes[lakes.intersects(plate)]
    print("lakes in the plate: ", ", ".join(sorted(lakes["name"].fillna("(no name)").unique())))
    water = pd.concat(
        [
            gpd.clip(rivers[["name", "geometry"]], plate).assign(kind="river"),
            gpd.clip(lakes[["name", "geometry"]], plate).assign(kind="lake"),
        ],
        ignore_index=True,
    )
    water = gpd.GeoDataFrame(water, geometry="geometry", crs=rivers.crs)
    # Cut at the border before simplifying, so both sides of a cut share the same end point.
    water = split_by_egypt(water, egypt.to_crs(water.crs))
    water = simplify_for_display(water)
    water["name"] = water["name"].fillna("")
    write_geojson(water, OUT_DIR / "nile_lakes.json", ["name", "kind", "inside"])
    print(
        f"water  {int(water['inside'].sum())} pieces inside Egypt, {int((~water['inside']).sum())} outside"
    )

    # The key entry's length: the main stem of the Nile inside Egypt (the river and its course
    # through Lake Nasser, without the two delta branches), on the raw 1:10m geometry, in metres.
    # I round to 10 km: a 1:10m line cuts the corners of every bend, so it is no more precise.
    nile = rivers[rivers["name"].isin(NILE_NAMES)].to_crs(METRIC_CRS)
    nile_in_egypt = gpd.clip(nile, egypt.to_crs(METRIC_CRS))
    by_name = nile_in_egypt.assign(km=nile_in_egypt.length / 1000).groupby("name")["km"].sum()
    for name, km in by_name.items():
        print(f"nile   {name}: {km:,.0f} km inside Egypt")
    main_stem_km = float(by_name["Nile"])
    if not 1000 < main_stem_km < 1600:
        raise ValueError(f"the Nile's main stem in Egypt is {main_stem_km:.0f} km: check the names")
    return main_stem_km


# ---- Checks and small files ----------------------------------------------------------------


def check_key_figures() -> list[dict]:
    """Fail loudly if key_figures.json no longer says what the map prints."""
    figures = json.loads(KEY_FIGURES.read_text())
    by_id = {f["id"]: f for f in figures}
    for figure_id, display in EXPECTED_DISPLAY.items():
        got = by_id.get(figure_id, {}).get("display")
        if got != display:
            raise ValueError(f"{figure_id}: display is {got!r}, the map expects {display!r}")
    return figures


def write_meta(nile_km: float, extra: dict) -> None:
    """Source names and download dates for the "Data fetched" line, plus measured sizes."""
    sources = json.loads(SOURCES_JSON.read_text())
    meta = {
        "sources": [{"name": s["name"], "downloaded": s["downloaded"]} for s in sources],
        "nile_km": int(round(nile_km / 10) * 10),
        **extra,
    }
    (OUT_DIR / "meta.json").write_text(json.dumps(meta, indent=1) + "\n")


def main() -> None:
    figures = check_key_figures()
    OUT_DIR.mkdir(exist_ok=True)
    DOWNLOAD_DIR.mkdir(exist_ok=True)
    rng = np.random.default_rng(SEED)

    print("read   population grid")
    pop, area_km2, transform = egypt_population()
    total_people = float(pop.sum())
    total_km2 = float(area_km2.sum())
    print(f"info   {total_people:,.0f} people on {total_km2:,.0f} km2")

    # 1 km squares and their ranking (step 3 of the method), needed first to tag the dots.
    pop_1km, area_1km = to_1km(pop), to_1km(area_km2)
    squares = rank_squares(pop_1km, area_1km)
    in_set = squares["cum_before"].to_numpy() < SHARE_PEOPLE
    set_km2 = float(squares.loc[in_set, "area_km2"].sum())
    share = area_share_for(pop_1km.ravel(), area_1km.ravel(), total_km2)
    if abs(set_km2 - share * total_km2) > 0.01:
        raise ValueError("my 95% set and area_share_for disagree")
    # The browser tests cum_before < threshold on float32, so the set must survive that rounding.
    in_set_f32 = squares["cum_before"].to_numpy().astype(np.float32) < np.float32(SHARE_PEOPLE)
    if not np.array_equal(in_set, in_set_f32):
        raise ValueError("float32 rounding moves a square in or out of the 95% set")
    print(f"info   {len(squares):,} squares with people, {in_set.sum():,} in the 95% set")

    # Dots (step 2), on the 100 m cells, tagged with their 1 km square.
    rows, cols = np.nonzero(pop)
    x0_m = transform.c + cols * CELL_M
    y0_m = transform.f - rows * CELL_M
    x_m, y_m, cell = place_dots(pop[rows, cols], x0_m, y0_m, rng)
    dense_grid = np.zeros(pop_1km.shape, dtype=bool)
    dense_grid[squares["row"].to_numpy()[in_set], squares["col"].to_numpy()[in_set]] = True
    dense = dense_grid[rows[cell] // AGG_CELLS, cols[cell] // AGG_CELLS].astype("u1")
    dot_people = len(x_m) * PEOPLE_PER_DOT
    print(
        f"info   {len(x_m):,} dots = {dot_people:,} people ({dot_people / total_people - 1:+.3%})"
    )
    if abs(dot_people / total_people - 1) > DOTS_TOLERANCE:
        raise ValueError("the dots do not add up to the population")

    to_lonlat = Transformer.from_crs(GRID_CRS, "EPSG:4326", always_xy=True)
    lon, lat = to_lonlat.transform(x_m, y_m)
    lon_square, lat_square = to_lonlat.transform(*square_centres(squares, transform))
    border = load_border().to_crs("EPSG:4326")
    west, south, east, north = (round(v, 3) for v in border.total_bounds)
    dots_box = [west - 0.01, south - 0.01, east + 0.01, north + 0.01]
    q_lon = quantise(lon, dots_box[0], dots_box[2])
    q_lat = quantise(lat, dots_box[1], dots_box[3])
    write_dots(q_lon, q_lat, dense)
    dots_meta = {
        "count": len(q_lon),
        "count_sparse": int((dense == 0).sum()),
        "count_dense": int(dense.sum()),
        "box": dots_box,
        "people_per_dot": PEOPLE_PER_DOT,
        "dot_people": int(dot_people),
        "grid_people": round(total_people),
        "blocks": [
            "lon uint16, one per dot: desert dots first, then valley dots, each south to north",
            "lat counts uint16 x 65536 for the desert dots: how many dots on each lat step",
            "lat counts uint16 x 65536 for the valley dots",
        ],
        "byte_order": "little-endian",
        "seed": SEED,
    }
    (OUT_DIR / "dots.json").write_text(json.dumps(dots_meta, indent=1) + "\n")

    write_squares(squares)
    squares_meta = {
        "count": len(squares),
        "count_95": int(in_set.sum()),
        "blocks": [
            "people float32",
            "cum_before float32",
            "col uint16 (1 km columns east of grid.x0_m)",
            "row uint16 (1 km rows south of grid.y0_m)",
            "area uint8 (hundredths of a km2 inside Egypt; 100 = a whole square)",
        ],
        "byte_order": "little-endian, one block after the other",
        "order": "densest first (people per km2), the ranking of area_share_for",
        "cum_before": "share of Egypt's people in all denser squares; in the set if < threshold",
        "square_m": SQUARE_M,
        "grid": {"crs": GRID_CRS, "x0_m": transform.c, "y0_m": transform.f},
        "max_per_km2": round(float(squares["per_km2"].max())),
    }
    (OUT_DIR / "squares.json").write_text(json.dumps(squares_meta, indent=1) + "\n")

    curve = share_curve(pop_1km, area_1km, total_km2)
    at_95 = next(c for c in curve if c["people_pct"] == 95)
    if at_95["land_pct"] != EXPECTED_LAND_PCT or at_95["land_km2"] != EXPECTED_LAND_KM2:
        raise ValueError(f"95% entry is {at_95}, key_figures.json says 2.2% and 22,090 km2")
    (OUT_DIR / "share_curve.json").write_text(json.dumps(curve, separators=(",", ":")) + "\n")

    # Step 4 and 5: the plate and the labels.
    nile_km = build_plate()
    labels = [{"name": n, "lon": lo, "lat": la, "kind": k} for n, lo, la, k in LABELS]
    (OUT_DIR / "labels.json").write_text(json.dumps(labels, indent=1) + "\n")

    # Step 6: the figures and the dates, for the sheet and the About dialog.
    shutil.copyfile(KEY_FIGURES, OUT_DIR / "key_figures.json")
    write_meta(
        nile_km,
        {
            "total_people": round(total_people),
            "egypt_km2": round(total_km2),
            "max_per_km2": squares_meta["max_per_km2"],
        },
    )
    print(f"info   Nile inside Egypt {nile_km:,.0f} km, shown as {round(nile_km / 10) * 10:,} km")

    # Step 7: the files offered under "Download the data".
    csv = pd.DataFrame(
        {
            "lon": np.round(lon_square, 5),
            "lat": np.round(lat_square, 5),
            "people": squares["people"].round(1),
            "per_km2": squares["per_km2"].round(1),
            "cum_share": squares["cum_share"].round(6),
            "in_95": in_set.astype(int),
        }
    )
    csv.to_csv(DOWNLOAD_DIR / "egypt_population_1km.csv", index=False)
    # The map loads the plate as .json, which GitHub Pages sends gzipped (it compresses JSON,
    # and may not compress .geojson); the downloads keep the usual .geojson name.
    for name in ["land", "egypt_border", "nile_lakes"]:
        shutil.copyfile(OUT_DIR / f"{name}.json", DOWNLOAD_DIR / f"{name}.geojson")

    # Step 8: what the browser will have to load.
    files = sorted(p for p in OUT_DIR.rglob("*") if p.is_file())
    total_bytes = 0
    print("\nfile                                      size")
    for path in sorted(files, key=lambda p: -p.stat().st_size):
        size = path.stat().st_size
        total_bytes += size
        print(f"{path.relative_to(OUT_DIR)!s:<38} {size / 1e6:>7.2f} MB")
    print(f"{'total maps/layers':<38} {total_bytes / 1e6:>7.2f} MB")
    print(f"\nfigures ok: {', '.join(f['id'] + ' ' + f['display'] for f in figures)}")


if __name__ == "__main__":
    main()
