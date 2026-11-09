"""Compute the key figures for "The rain that drowned Florence".

What it does: I rebuild the area that drains into Florence from the smallest HydroBASINS units,
measure it, compare it with the size of the comune of Firenze, and trace the Arno from its
spring on Monte Falterona to the sea to measure its length.
Reads:  data/raw/hybas_eu_lev12_v1c/hybas_eu_lev12_v1c.shp,
        data/raw/HydroRIVERS_v10_eu_shp/HydroRIVERS_v10_eu_shp/HydroRIVERS_v10_eu.shp
Writes: data/key_figures.json
Run:    uv run data/key_figures.py   (from the piece folder, after data/download.py)

What you learn: how a river network is stored as a graph. Every basin unit and every river
reach carries the ID of the one it drains into (NEXT_DOWN). Walk that graph upstream and you get
a whole catchment; walk it downstream and you get a river's path to the sea. No GIS overlay is
needed, only IDs. You also learn why area is measured in an equal-area projection and length in
a local metric one, and why "the main river" in a dataset is not always the river on the map.

Two figures do not come from these datasets: the death toll (Italian Civil Protection) and the
area of the comune of Firenze (ISTAT). I keep them in EXTERNAL_FIGURES with their source, so
every number in key_figures.json says where it comes from.
"""

import json
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import Point

HERE = Path(__file__).parent
RAW_DIR = HERE / "raw"
BASINS_SHP = RAW_DIR / "hybas_eu_lev12_v1c" / "hybas_eu_lev12_v1c.shp"
RIVERS_SHP = (
    RAW_DIR / "HydroRIVERS_v10_eu_shp" / "HydroRIVERS_v10_eu_shp" / "HydroRIVERS_v10_eu.shp"
)
OUT_JSON = HERE / "key_figures.json"

# I only read the part of Europe around the Arno. The bbox filter is applied while the shapefile
# is read, so I never load the whole continent (about 1.4 million basin units) into memory.
READ_BBOX = (9.9, 42.7, 12.5, 44.3)  # lon_min, lat_min, lon_max, lat_max, EPSG:4326

# Ponte Vecchio, the bridge at the heart of the 1966 flood. The basin "upstream of Florence" is
# everything that drains through this point.
PONTE_VECCHIO = Point(11.2531, 43.7680)
# Capo d'Arno, the Arno's spring on Monte Falterona (about 1,358 m).
ARNO_SPRING = Point(11.64317, 43.86655)
MAX_SNAP_M = 3_000  # the nearest river reach must be this close, or the point is in the wrong place

# EPSG:3035 (ETRS89 / LAEA Europe) is equal-area: one square metre on the map is one square metre
# on the ground everywhere in Europe. That is the projection to measure a basin in.
AREA_CRS = "EPSG:3035"
# EPSG:32632 (WGS 84 / UTM zone 32N) covers Tuscany with almost no scale error, so it is a good
# projection to measure a river's length in metres.
LENGTH_CRS = "EPSG:32632"

DEATH_TOLL_URL = "https://servizio-nazionale.protezionecivile.gov.it/en/pagina-base/flood-florence/"
WORST_FLOOD_URL = "https://www.thelocal.it/20191104/in-photos-the-great-flood-of-florence-arno-1966"
FLORENCE_AREA_URL = "https://www.istat.it/wp-content/uploads/2024/06/Approfondimento_Firenze.pdf"
EXTERNAL_FIGURES = {
    "death_toll": {
        "value": 35,
        "unit": "people",
        "display": "35",
        "source": f"Italian Civil Protection (Dipartimento della Protezione Civile), {DEATH_TOLL_URL}",
        "method": 'Taken from the source: "A total of 35 people died in the region."',
    },
    "flood_date": {
        "value": "1966-11-04",
        "unit": "date",
        "display": "4 November 1966",
        "source": f"Italian Civil Protection (Dipartimento della Protezione Civile), {DEATH_TOLL_URL}",
        "method": "Taken from the source: the Arno flooded on the night of 3 to 4 November 1966.",
    },
    # "Worst flood in centuries" is a claim in the lede, so it needs a source like any number.
    "worst_flood": {
        "value": 1557,
        "unit": "year",
        "display": "worst flood in centuries",
        "source": "The Local Italy, In photos: remembering the great flood of Florence (2019), "
        f"{WORST_FLOOD_URL}",
        "method": 'Taken from the source: "At their height the waters reached nearly seven metres, '
        'a level not seen since the disastrous flood of 1557."',
    },
    "florence_area": {
        "value": 102.31,
        "unit": "km²",
        "display": "102 km²",
        "source": f"ISTAT, Approfondimento Firenze (2024), {FLORENCE_AREA_URL}",
        "method": "Taken from the source: area of the comune of Firenze (ISTAT code 048017).",
    },
}

# Sanity ranges: wide enough for any honest result, narrow enough to catch a broken selection.
BASIN_AREA_RANGE_KM2 = (3_000, 6_000)
ARNO_LENGTH_RANGE_KM = (200, 280)


def read_layer(path: Path) -> gpd.GeoDataFrame:
    """Read one HydroSHEDS shapefile around the Arno and check it is what I expect."""
    if not path.exists():
        raise FileNotFoundError(f"{path} is missing. Run: uv run data/download.py")
    layer = gpd.read_file(path, bbox=READ_BBOX)
    if layer.crs is None or layer.crs.to_epsg() != 4326:
        raise ValueError(f"{path.name}: expected EPSG:4326, got {layer.crs}")
    return layer


def upstream_ids(start_id: int, next_down: pd.Series) -> set[int]:
    """Return start_id plus every ID that drains into it, directly or through others.

    next_down maps each ID to the ID it drains into. I flip it into "who drains into me" and walk
    upstream breadth-first. This is the whole trick behind catchment delineation on a network.
    """
    feeders = next_down.groupby(next_down).groups  # downstream ID -> IDs draining into it
    found = {start_id}
    queue = [start_id]
    while queue:
        current = queue.pop()
        for feeder in feeders.get(current, []):
            if feeder not in found:
                found.add(feeder)
                queue.append(feeder)
    return found


def basin_upstream_of_florence(basins: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Select every level-12 HydroBASINS unit that drains through Ponte Vecchio.

    Level 12 is the finest level (units of roughly 100 to 200 km² here), so the outline follows
    the real watershed closely. The unit holding Ponte Vecchio also contains a little land just
    downstream of the bridge, a limit of the unit size.

    A data quirk worth knowing: HydroSHEDS is derived from 90 m radar elevation, which cannot see
    the man-made divide in the flat Val di Chiana. Since the Medici-era drainage works, the
    southern Chiana flows to the Tiber, but here part of it is routed to the Arno. That makes
    this basin a few percent bigger than the official sub-basins add up to.
    """
    hit = basins[basins.contains(PONTE_VECCHIO)]
    if len(hit) != 1:
        raise ValueError(f"expected 1 basin unit at Ponte Vecchio, found {len(hit)}")
    florence_id = int(hit["HYBAS_ID"].iloc[0])
    ids = upstream_ids(florence_id, basins.set_index("HYBAS_ID")["NEXT_DOWN"])
    return basins[basins["HYBAS_ID"].isin(ids)]


def nearest_reach(rivers: gpd.GeoDataFrame, point: Point) -> int:
    """Return the HYRIV_ID of the river reach closest to a point, measured in metres."""
    rivers_m = rivers.to_crs(LENGTH_CRS)
    point_m = gpd.GeoSeries([point], crs="EPSG:4326").to_crs(LENGTH_CRS).iloc[0]
    distance_m = rivers_m.distance(point_m)
    if distance_m.min() > MAX_SNAP_M:
        raise ValueError(f"no river reach within {MAX_SNAP_M} m of {point}")
    return int(rivers.loc[distance_m.idxmin(), "HYRIV_ID"])


def florence_reach(rivers: gpd.GeoDataFrame) -> int:
    """Return the HydroRIVERS reach of the Arno at Ponte Vecchio."""
    return nearest_reach(rivers, PONTE_VECCHIO)


def arno_main_stem(rivers: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Trace the Arno from its spring down to the sea, reach by reach.

    I start at the spring and follow NEXT_DOWN until it is 0 (the sea). I do not start at the
    mouth and follow the biggest tributary upstream, because in HydroRIVERS that path turns south
    at Arezzo into the Val di Chiana: in the data the Chiana drains a bigger area than the upper
    Arno. On the map and in every atlas, the Arno is the river from Monte Falterona.
    """
    by_id = rivers.set_index("HYRIV_ID")
    current = nearest_reach(rivers, ARNO_SPRING)
    path = []
    while current != 0:
        path.append(current)
        current = int(by_id.loc[current, "NEXT_DOWN"])
    stem = rivers[rivers["HYRIV_ID"].isin(path)]
    if florence_reach(rivers) not in path:
        raise ValueError("the traced Arno does not pass Ponte Vecchio")
    return stem


def figure(fig_id: str, value, unit: str, display: str, source: str, method: str) -> dict:
    """One entry of key_figures.json, always with the same fields."""
    return {
        "id": fig_id,
        "value": value,
        "unit": unit,
        "display": display,
        "source": source,
        "method": method,
    }


def check_range(name: str, value: float, low: float, high: float) -> None:
    """Fail loudly if a figure falls outside its plausible range."""
    if not low <= value <= high:
        raise ValueError(f"{name} = {value} is outside the sane range {low} to {high}")


def main() -> None:
    basins = read_layer(BASINS_SHP)
    rivers = read_layer(RIVERS_SHP)
    print(f"read {len(basins)} basin units and {len(rivers)} river reaches around the Arno")

    basin = basin_upstream_of_florence(basins)
    # I dissolve the units into one polygon before measuring, so shared edges are not counted.
    basin_area_km2 = round(basin.to_crs(AREA_CRS).union_all().area / 1e6, 1)
    check_range("basin_area_km2", basin_area_km2, *BASIN_AREA_RANGE_KM2)

    florence_area_km2 = EXTERNAL_FIGURES["florence_area"]["value"]
    times_florence = round(basin_area_km2 / florence_area_km2, 1)

    stem = arno_main_stem(rivers)
    # I measure the line geometry in UTM rather than summing LENGTH_KM, so the number is mine to
    # reproduce. Both agree within half a kilometre.
    arno_length_km = round(stem.to_crs(LENGTH_CRS).length.sum() / 1e3, 1)
    check_range("arno_length_km", arno_length_km, *ARNO_LENGTH_RANGE_KM)

    figures = [
        figure("death_toll", **EXTERNAL_FIGURES["death_toll"]),
        figure("flood_date", **EXTERNAL_FIGURES["flood_date"]),
        figure("worst_flood", **EXTERNAL_FIGURES["worst_flood"]),
        figure(
            "basin_area",
            basin_area_km2,
            "km²",
            f"{round(basin_area_km2, -2):,.0f} km²",
            "HydroBASINS level 12, v1c (HydroSHEDS)",
            f"Union of the {len(basin)} level-12 units that drain through Ponte Vecchio, "
            "area in EPSG:3035.",
        ),
        figure(
            "times_florence",
            times_florence,
            "x",
            f"{round(times_florence):.0f} times the size of Florence",
            "HydroBASINS level 12 (HydroSHEDS); ISTAT",
            f"basin_area / area of the comune of Firenze ({florence_area_km2} km², ISTAT).",
        ),
        figure(
            "arno_length",
            arno_length_km,
            "km",
            f"{round(arno_length_km):.0f} km",
            "HydroRIVERS v1.0 (HydroSHEDS)",
            f"{len(stem)} reaches from the spring on Monte Falterona down NEXT_DOWN to the sea, "
            "length in EPSG:32632.",
        ),
        figure("florence_area", **EXTERNAL_FIGURES["florence_area"]),
    ]
    OUT_JSON.write_text(json.dumps(figures, indent=2, ensure_ascii=False) + "\n")

    print(f"\n{'id':<16}{'value':>12}  {'unit':<8}display")
    for f in figures:
        print(f"{f['id']:<16}{f['value']!s:>12}  {f['unit']:<8}{f['display']}")
    print(f"\nwrote {OUT_JSON.relative_to(HERE.parent)}")


if __name__ == "__main__":
    main()
