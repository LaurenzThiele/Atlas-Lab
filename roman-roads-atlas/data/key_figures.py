"""Compute the key figures for "Every Roman road, as an old atlas plate".

What it does: I measure the total length of every road segment in Itiner-e (the hook number N)
and divide it by the length of the Equator (how many times N would wrap around the Earth).
Then I check my total against the totals published in the dataset paper. Last, I find how far
the farthest road lies from Rome along the network, with the same code the map uses.
Reads:  data/raw/itinere_roads.gpkg (run data/download.py first), and the network functions in
        maps/prepare.py. No network access.
Writes: data/key_figures.json
Run:    uv run data/key_figures.py   (from the piece folder)

What you learn: why the length of a line depends on how you measure it. Itiner-e is stored in
World Mercator (EPSG:3395), and Mercator stretches distances by 1 / cos(latitude). At Rome
(42 degrees N) a Mercator metre is only about 0.74 real metres, so summing lengths in the
file's own CRS overstates the network by about a third. I measure every line on the WGS84
ellipsoid instead (a geodesic length), which is the true length on the Earth's surface.
"""

import importlib.util
import json
import math
from pathlib import Path

import geopandas as gpd
import numpy as np
from pyproj import Geod

HERE = Path(__file__).parent
RAW_DIR = HERE / "raw"
ROADS_GPKG = RAW_DIR / "itinere_roads.gpkg"
OUT_FILE = HERE / "key_figures.json"
PREPARE_PY = HERE.parent / "maps" / "prepare.py"

SRC = "Itiner-e 2024 (de Soto et al. 2025)"
FILE_CRS = "EPSG:3395"  # World Mercator, as Zenodo ships the GeoPackage
GEO_CRS = "EPSG:4326"  # lon/lat on WGS84, the input Geod needs for geodesic lengths
ELLIPSOID = "WGS84"
EXPECTED_SEGMENTS = 14_769  # "The dataset includes 14,769 road segments" (the paper)

# Published figures I check my own numbers against: de Soto et al. 2025, Scientific Data.
PAPER_URL = "https://doi.org/10.1038/s41597-025-06140-z"
PAPER_TOTAL_KM = 299_171.31  # "The resulting map includes, in total, 299,171.31 km of roads"
PAPER_MAIN_KM = 103_477.9  # "main roads ... covered 103,477.9 km (34.58%)"
PAPER_SECONDARY_KM = 195_693.3  # "195,693.3 km (65.42%) of secondary roads"
NASA_EARTH_URL = "https://nssdc.gsfc.nasa.gov/planetary/factsheet/earthfact.html"
NASA_EQUATOR_RADIUS_KM = 6_378.137  # NASA Earth Fact Sheet, "Equatorial radius (km)"
MAX_DIFF = 0.10


def load_roads() -> gpd.GeoDataFrame:
    """Read the roads and check the file is the one the paper describes."""
    if not ROADS_GPKG.exists():
        raise FileNotFoundError(f"{ROADS_GPKG} is missing: run uv run data/download.py first")
    roads = gpd.read_file(ROADS_GPKG)
    if roads.crs != FILE_CRS:
        raise ValueError(f"expected {FILE_CRS}, got {roads.crs}: the Zenodo file has changed")
    if len(roads) != EXPECTED_SEGMENTS:
        raise ValueError(f"{len(roads)} segments, the paper says {EXPECTED_SEGMENTS}")
    if roads.geometry.isna().any() or roads.is_empty.any():
        raise ValueError("some road segments have no geometry")
    return roads


def geodesic_km(roads: gpd.GeoDataFrame) -> np.ndarray:
    """Length of each segment on the WGS84 ellipsoid, in km.

    The lines carry a Z value (height), which I drop: the paper measures map length, and the
    climb adds almost nothing over these distances. Geod walks each line vertex by vertex and
    sums the shortest paths on the ellipsoid between them, so no projection distorts it.
    """
    geod = Geod(ellps=ELLIPSOID)
    lines = roads.to_crs(GEO_CRS).geometry.force_2d()
    length_km = np.array([geod.geometry_length(line) for line in lines]) / 1000
    if not (length_km >= 0).all() or length_km.max() > 1_000:
        raise ValueError("a segment is negative or longer than 1,000 km: check the geometry")
    return length_km


def farthest_km() -> int:
    """How far the farthest road lies from Rome along the network, in whole km.

    I borrow the network code from maps/prepare.py instead of writing it twice: two copies of
    Dijkstra with different snapping would give two different answers, and the map's timeline
    ends on exactly this number.
    """
    spec = importlib.util.spec_from_file_location("prepare", PREPARE_PY)
    prepare = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(prepare)
    roads = prepare.load_roads()
    steps, length_km, start_node, end_node, from_rome_km, _ = prepare.network_from_rome(roads)
    _, piece_d_km, _ = prepare.build_pieces(
        roads, steps, length_km, start_node, end_node, from_rome_km
    )
    return prepare.farthest_draw_km(piece_d_km)


def check(label: str, mine: float, published: float) -> None:
    """Stop the script if my number and the published one differ by more than 10%."""
    diff = mine / published - 1
    print(f"check  {label}: mine {mine:,.1f}, published {published:,.1f}, diff {diff:+.3%}")
    if abs(diff) > MAX_DIFF:
        raise ValueError(f"{label} differs from the published figure by {diff:+.1%}")


def main() -> None:
    roads = load_roads()
    roads["length_km"] = geodesic_km(roads)
    total_km = float(roads["length_km"].sum())
    by_type_km = roads.groupby("Type")["length_km"].sum()

    # Why I do not sum the CRS lengths: this is what Mercator would have told me.
    mercator_km = float(roads.length.sum()) / 1000
    print(
        f"note   Mercator (EPSG:3395) sum would be {mercator_km:,.0f} km, too long by "
        f"{mercator_km / total_km - 1:.0%}"
    )
    # The file also has a Shape_Leng field in metres. It matches my geodesic total, which
    # tells me the authors measured on the ellipsoid too, so my number and theirs agree.
    print(f"note   Shape_Leng field sums to {roads['Shape_Leng'].sum() / 1000:,.1f} km")
    # A handful of segments in Egypt, Bithynia and Lusitania appear twice with identical
    # geometry. The paper counts them, so I keep them to stay comparable; here is how much.
    dup_km = float(roads.loc[roads.duplicated("geometry"), "length_km"].sum())
    print(
        f"note   {roads.duplicated('geometry').sum()} duplicate segments, {dup_km:,.0f} km "
        f"({dup_km / total_km:.2%} of the total), kept as in the paper"
    )

    check("total km", total_km, PAPER_TOTAL_KM)
    check("main road km", float(by_type_km["Main Road"]), PAPER_MAIN_KM)
    check("secondary road km", float(by_type_km["Secondary Road"]), PAPER_SECONDARY_KM)

    # The Equator is a circle of the ellipsoid's equatorial radius, so its length is 2 pi a.
    # I take a from pyproj's WGS84 definition and check it against NASA's value.
    equator_radius_km = Geod(ellps=ELLIPSOID).a / 1000
    if abs(equator_radius_km - NASA_EQUATOR_RADIUS_KM) > 0.001:
        raise ValueError(f"equatorial radius {equator_radius_km} km, NASA says 6,378.137 km")
    equator_km = 2 * math.pi * equator_radius_km
    times_around = total_km / equator_km
    print("Finding the farthest road from Rome (a minute or so)")
    far_km = farthest_km()

    figures = [
        {
            "id": "total_road_km",
            "value": round(total_km, 1),
            "unit": "km",
            "display": f"{total_km:,.0f} km",
            "source": SRC,
            "method": "Sum of geodesic lengths (WGS84) of all 14,769 road segments; matches "
            f"the paper's total ({PAPER_URL})",
        },
        {
            "id": "times_around_earth",
            "value": round(times_around, 2),
            "unit": "times the Equator",
            "display": f"{times_around:.1f} times around the Earth",
            "source": f"{SRC}; equatorial radius 6,378.137 km, NASA Earth Fact Sheet "
            f"({NASA_EARTH_URL})",
            "method": f"total_road_km / Equator length ({equator_km:,.0f} km = 2 pi x WGS84 "
            "equatorial radius)",
        },
        {
            "id": "farthest_km",
            "value": far_km,
            "unit": "km",
            "display": f"{far_km:,} km",
            "source": "Itiner-e (de Soto et al. 2025)",
            "method": "Shortest network distance from Rome (Dijkstra over geodesic road lengths) "
            "to the farthest 3 km road piece, rounded up to the whole km",
        },
    ]
    OUT_FILE.write_text(json.dumps(figures, indent=2, ensure_ascii=False))

    print(f"\n{'id':<20} {'value':>12}  display")
    for f in figures:
        print(f"{f['id']:<20} {f['value']:>12,}  {f['display']}")
    print(f"\nwrote  {OUT_FILE}")


if __name__ == "__main__":
    main()
