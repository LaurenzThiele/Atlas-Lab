"""Turn the raw NCEI runups into the small layers the 3D map loads.

What it does: I take the exact rings data/key_figures.py keeps, sort them by date, and write them
as compact column arrays, together with the three highlighted rings, the region names, a copy of
the key figures, the bearing of every Pacific ring seen from the middle of the ocean, and the land
as one plain list of polygons. Last, I copy the download date of every source into meta.json, so
the map can say how fresh its data is.
Reads:  data/raw/ through load_rings() in data/key_figures.py, data/key_figures.json,
        data/raw/ne_50m_land.geojson, data/raw/sources.json
Writes: maps/layers/rings.json, highlights.json, regions.json, figures.json,
        ring_of_fire_order.json, land.json, meta.json
Run:    uv run maps/prepare.py   (from the piece folder)

What you learn:
- Why validity matters. The largest death toll anywhere in the NCEI runup table is 300,000 at
  Calcutta in 1737. NCEI rates that event as erroneous (validity -1): it was a cyclone storm surge,
  not a tsunami. Skip the validity filter and a storm becomes the deadliest tsunami on record.
- A runup is not a tsunami. A tsunami is one event; a runup is one place where that event was seen
  or measured. One big tsunami can leave thousands of runups, so 29,340 rings come from only 1,124
  tsunamis, and any share computed per ring differs from the same share computed per tsunami.
- Why area, not radius, scales with height. The eye compares circles by their area. If the radius
  grew in step with the height, a wave 100 times taller would look 10,000 times bigger. So the map
  uses radius = constant * sqrt(height), and a wave 100 times taller covers 100 times the area.
"""

import json
import math
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
DATA_DIR = HERE.parent / "data"
OUT_DIR = HERE / "layers"
KEY_FIGURES_JSON = DATA_DIR / "key_figures.json"
REGIONS_JSON = DATA_DIR / "raw" / "ncei_tsunami_regions.json"
LAND_GEOJSON = DATA_DIR / "raw" / "ne_50m_land.geojson"
SOURCES_JSON = DATA_DIR / "raw" / "sources.json"
# Short names for the map, in case the sources were fetched on different days and the About dialog
# needs one line per source. The long names in sources.json are written for the data folder.
SHORT_NAMES = {
    "ncei_tsunami_runups.json": "NOAA NCEI tsunami runups",
    "ncei_tsunami_regions.json": "NOAA NCEI region codes",
    "ne_50m_land.geojson": "Natural Earth land",
}

# I import the filter instead of rewriting it: the map and the figures can never disagree about
# which runups count as a ring.
sys.path.insert(0, str(DATA_DIR))
from key_figures import PACIFIC_CODES, home_region, load_rings

DEADLIEST_EVENT_ID = 2439
# The middle of the Pacific. Seen from here the rim runs around the horizon as one closed curve, so
# a single angle is enough to order every ring along it.
PACIFIC_CENTRE_LON_LAT = (-170.0, 0.0)
COORD_DECIMALS = 4
T_DECIMALS = 6
BEARING_DECIMALS = 1
# Three decimals of a degree is about 100 m, finer than the 1:50 million land line itself.
LAND_DECIMALS = 3
MIN_LAND_POLYGONS = 1_000

# The text the map must show. The numbers themselves come from the data: I only check here that
# nothing has drifted since the figures were agreed.
EXPECTED_DISPLAY = {
    "ring_count": "29,340 rings",
    "tsunami_count": "1,124 tsunamis",
    "year_span": "684 to 2026",
    "pacific_share": "84% of the rings are in the Pacific",
    "japan_share": "Japan: 40% of all rings",
    "max_runup": "524 m, Lituya Bay, Alaska, 1958",
    "death_toll": "227,899 deaths, Indian Ocean, 2004",
}
EXPECTED_RINGS = 29_340
EXPECTED_TSUNAMIS = 1_124
EXPECTED_YEARS = (684, 2026)
EXPECTED_PACIFIC_PCT = 84
EXPECTED_JAPAN_PCT = 40
EXPECTED_MAX_RUNUP_M = 524.26
JAPAN = "JAPAN"


def sort_by_date(rings: pd.DataFrame) -> pd.DataFrame:
    """Order the rings tsunami by tsunami, and add order and t.

    Old records often have only a year. I sort a missing month or day first, so the ranking is
    complete and repeatable. Each tsunami is ranked by its earliest record, and the rings follow
    their tsunami, so the list stays in timeline order.

    The timeline runs on t, the tsunami's rank / last rank, and every ring of one tsunami shares
    its tsunami's t. So each of the 1,124 tsunamis gets the same stretch of the timeline. Two other
    scales fail here. A timeline linear in years would sit almost empty for 90 % of its length:
    most records are after 1900. One scaled by records would stall on 2011, because the Tohoku
    tsunami alone left 6,193 records, a fifth of all of them. Ranked by tsunami, Tohoku arrives as
    one burst of rings, and the years keep moving.
    """
    dated = rings.assign(_month=rings["month"].fillna(0), _day=rings["day"].fillna(0))
    date_keys = ["year", "_month", "_day", "id"]
    first_records = dated.sort_values(date_keys, kind="stable").drop_duplicates("tsunamiEventId")
    tsunami_rank = pd.Series(np.arange(len(first_records)), index=first_records["tsunamiEventId"])
    dated["_rank"] = dated["tsunamiEventId"].map(tsunami_rank)
    ranked = dated.sort_values(["_rank", *date_keys], kind="stable").reset_index(drop=True)
    ranked["order"] = np.arange(len(ranked))
    ranked["t"] = (ranked["_rank"] / (len(tsunami_rank) - 1)).round(T_DECIMALS)
    ranked = ranked.drop(columns=["_month", "_day", "_rank"])
    ranked["pacific"] = ranked["regionCode"].isin(PACIFIC_CODES)
    ranked["place"] = ranked["locationName"].fillna("Unnamed place").str.title()
    return ranked


def column(series: pd.Series, kind: type) -> list:
    """A plain JSON list with None for missing values (JSON has no NaN)."""
    return [None if pd.isna(value) else kind(value) for value in series]


def rings_layer(rings: pd.DataFrame) -> dict:
    """Column arrays: the same 29,340 points as GeoJSON would be about ten times the size.

    Only the columns the map reads go in. Coordinates keep 4 decimals (about 11 m), finer than the
    place names NCEI gives for most records.
    """
    return {
        "count": len(rings),
        "lon": rings["longitude"].round(COORD_DECIMALS).tolist(),
        "lat": rings["latitude"].round(COORD_DECIMALS).tolist(),
        "runup_m": rings["runup_m"].tolist(),
        "year": column(rings["year"], int),
        "month": column(rings["month"], int),
        "day": column(rings["day"], int),
        "country": column(rings["country"].str.title(), str),
        "locationName": rings["place"].tolist(),
        "tsunamiEventId": column(rings["tsunamiEventId"], int),
        "deaths": column(rings["deaths"], int),
        # 0 or 1 rather than false or true: the map turns it into a Uint8Array anyway.
        "pacific": rings["pacific"].astype(int).tolist(),
        "t": rings["t"].tolist(),
    }


def label_place(ring: pd.Series) -> str:
    """Place name without the region suffix NCEI adds: "Lituya Bay, Ak" becomes "Lituya Bay"."""
    return ring["place"].split(",")[0]


def highlights_layer(rings: pd.DataFrame, regions: dict[int, str]) -> dict:
    """The only three rings in shu red. All three are found in the data, none is hardcoded."""
    first_i = int(rings["year"].idxmin())
    tallest_i = int(rings["runup_m"].idxmax())

    event = rings[rings["tsunamiEventId"] == DEADLIEST_EVENT_ID]
    if event.empty:
        raise ValueError(f"event {DEADLIEST_EVENT_ID} has no rings")
    if event["distFromSource"].isna().all():
        raise ValueError(f"event {DEADLIEST_EVENT_ID} has no distances to its source")
    # The runup table has no epicentre column, so the ring nearest the source stands in for it.
    nearest_i = int(event["distFromSource"].idxmin())

    first, tallest, nearest = rings.loc[first_i], rings.loc[tallest_i], rings.loc[nearest_i]
    short_region = regions[int(tallest["regionCode"])].split(" (")[0]
    return {
        "first": {
            "index": first_i,
            "label": f"{label_place(first)}, {first['country'].title()}, {int(first['year'])}",
        },
        "tallest": {
            "index": tallest_i,
            "label": f"{label_place(tallest)}, {short_region}, {int(tallest['year'])}",
        },
        "deadliest": {
            "index": nearest_i,
            "label": f"{label_place(nearest)}, {nearest['country'].title()}, "
            f"{int(nearest['year'])}",
            "event_id": DEADLIEST_EVENT_ID,
            "event_rings": [int(i) for i in event.index],
        },
    }


def initial_bearing_deg(lon_deg: np.ndarray, lat_deg: np.ndarray) -> np.ndarray:
    """Great-circle bearing from the Pacific centre to each ring, clockwise from north, -180..180.

    I use the bearing on the sphere, not an angle on a flat lon/lat plot: a flat plot stretches
    the high latitudes, which would bend the order around Alaska. No CRS is involved, because I
    measure an angle on the globe itself and never an area or a distance.
    """
    lon0, lat0 = map(math.radians, PACIFIC_CENTRE_LON_LAT)
    lon, lat = np.radians(lon_deg), np.radians(lat_deg)
    dlon = lon - lon0
    east = np.sin(dlon) * np.cos(lat)
    north = math.cos(lat0) * np.sin(lat) - math.sin(lat0) * np.cos(lat) * np.cos(dlon)
    return np.degrees(np.arctan2(east, north))


def ring_of_fire_layer(rings: pd.DataFrame) -> dict:
    """Bearing of each Pacific ring. There is no fault data: the rings draw the rim themselves."""
    pacific = rings[rings["pacific"]]
    bearing_deg = initial_bearing_deg(
        pacific["longitude"].to_numpy(), pacific["latitude"].to_numpy()
    )
    # The sweep only reads as a horseshoe if the order runs Chile, Alaska, Japan, New Zealand with
    # the bearing falling all the way (counterclockwise on the map), so I check that on the data.
    country = pacific["country"]
    medians = {
        name: float(np.median(bearing_deg[(country == key).to_numpy()]))
        for name, key in {
            "Chile": "CHILE",
            "Alaska": "USA",
            "Japan": "JAPAN",
            "New Zealand": "NEW ZEALAND",
        }.items()
    }
    print("median bearing  " + ", ".join(f"{k} {v:.0f}" for k, v in medians.items()))
    if not medians["Chile"] > medians["Japan"] > medians["New Zealand"]:
        raise ValueError(f"the rim order is wrong: {medians}")
    return {
        "centre": list(PACIFIC_CENTRE_LON_LAT),
        "index": [int(i) for i in pacific.index],
        "bearing_deg": bearing_deg.round(BEARING_DECIMALS).tolist(),
    }


def land_layer() -> list:
    """All land as a flat list of polygons, each a list of rings of [lon, lat].

    GeoJSON wraps this in features and properties the map never reads, and rounding drops digits
    that carry no information. A few features are MultiPolygons, so I unpack those into the list:
    to the map, land is one mass with no countries and no names.
    """
    if not LAND_GEOJSON.exists():
        raise FileNotFoundError(f"{LAND_GEOJSON} is missing: run uv run data/download.py first")
    polygons = []
    for feature in json.loads(LAND_GEOJSON.read_text())["features"]:
        geometry = feature["geometry"]
        parts = (
            geometry["coordinates"]
            if geometry["type"] == "MultiPolygon"
            else [geometry["coordinates"]]
        )
        for polygon in parts:
            polygons.append(
                [
                    [[round(lon, LAND_DECIMALS), round(lat, LAND_DECIMALS)] for lon, lat in ring]
                    for ring in polygon
                ]
            )
    if len(polygons) < MIN_LAND_POLYGONS:
        raise ValueError(f"only {len(polygons)} land polygons: check {LAND_GEOJSON}")
    return polygons


def check_against_figures(rings: pd.DataFrame, figures: list[dict]) -> None:
    """Fail loudly if the layers and data/key_figures.json could ever disagree."""
    by_id = {f["id"]: f for f in figures}
    for figure_id, text in EXPECTED_DISPLAY.items():
        if by_id[figure_id]["display"] != text:
            raise ValueError(f"{figure_id} displays {by_id[figure_id]['display']!r}, not {text!r}")

    n_tsunamis = rings["tsunamiEventId"].nunique()
    years = (int(rings["year"].min()), int(rings["year"].max()))
    pacific_pct = float(rings["pacific"].mean() * 100)
    japan_pct = float((rings["country"] == JAPAN).mean() * 100)
    max_runup_m = float(rings["runup_m"].max())

    assert len(rings) == EXPECTED_RINGS == by_id["ring_count"]["value"], len(rings)
    assert n_tsunamis == EXPECTED_TSUNAMIS == by_id["tsunami_count"]["value"], n_tsunamis
    assert years == EXPECTED_YEARS == tuple(by_id["year_span"]["value"]), years
    assert round(pacific_pct) == EXPECTED_PACIFIC_PCT, pacific_pct
    assert round(pacific_pct, 1) == by_id["pacific_share"]["value"], pacific_pct
    assert round(japan_pct) == EXPECTED_JAPAN_PCT, japan_pct
    assert round(japan_pct, 1) == by_id["japan_share"]["value"], japan_pct
    assert max_runup_m == EXPECTED_MAX_RUNUP_M == by_id["max_runup"]["value"], max_runup_m
    tallest = rings.loc[rings["runup_m"].idxmax()]
    assert "LITUYA" in tallest["locationName"].upper(), tallest["locationName"]
    print(
        f"checked {len(rings):,} rings, {n_tsunamis:,} tsunamis, years {years[0]} to {years[1]}, "
        f"Pacific {pacific_pct:.2f}%, Japan {japan_pct:.2f}%, tallest {max_runup_m} m"
    )


def meta_layer() -> dict:
    """The name and download date of every source, for the "Data fetched" line on the map.

    download.py writes the date into sources.json. An older sources.json may lack it: then the
    file's own modification date is the best record of when it arrived, and I write that date back
    into sources.json once, so the next run reads it from there like any other.
    """
    if not SOURCES_JSON.exists():
        raise FileNotFoundError(f"{SOURCES_JSON} is missing: run uv run data/download.py")
    sources = json.loads(SOURCES_JSON.read_text())
    filled = False
    for source in sources:
        if not source.get("downloaded"):
            raw_file = SOURCES_JSON.parent / source["file"]
            if not raw_file.exists():
                raise FileNotFoundError(f"{raw_file} is missing: run uv run data/download.py")
            source["downloaded"] = date.fromtimestamp(raw_file.stat().st_mtime).isoformat()
            filled = True
        # Fail loudly on a date that does not parse, instead of printing nonsense on the map.
        date.fromisoformat(source["downloaded"])
    if filled:
        SOURCES_JSON.write_text(json.dumps(sources, indent=2, ensure_ascii=False))
        print(f"filled missing download dates in {SOURCES_JSON.name}")
    return {
        "sources": [
            {
                "name": source["name"],
                "label": SHORT_NAMES.get(source["file"], source["name"]),
                "downloaded": source["downloaded"],
            }
            for source in sources
        ]
    }


def write_json(name: str, payload: object) -> None:
    """Compact JSON, without spaces: this file travels over the network to every reader."""
    path = OUT_DIR / name
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote  {path.name:<26}{path.stat().st_size / 1e6:6.2f} MB")


def main() -> None:
    if not KEY_FIGURES_JSON.exists():
        raise FileNotFoundError(f"{KEY_FIGURES_JSON} is missing: run uv run data/key_figures.py")
    figures = json.loads(KEY_FIGURES_JSON.read_text())
    regions = {int(r["id"]): r["description"] for r in json.loads(REGIONS_JSON.read_text())}

    _, raw_rings = load_rings()
    rings = sort_by_date(raw_rings)
    check_against_figures(rings, figures)
    # home_region() gives one row per tsunami. The same count here proves that sorting and
    # renaming have not lost or merged an event on the way to the layers.
    assert len(home_region(raw_rings)) == EXPECTED_TSUNAMIS

    OUT_DIR.mkdir(exist_ok=True)
    highlights = highlights_layer(rings, regions)
    print(
        f"highlights  {highlights['first']['label']} | {highlights['tallest']['label']} | "
        f"{highlights['deadliest']['label']} ({len(highlights['deadliest']['event_rings'])} rings)"
    )
    write_json("rings.json", rings_layer(rings))
    write_json("highlights.json", highlights)
    write_json("regions.json", {str(code): name for code, name in regions.items()})
    write_json("figures.json", figures)
    write_json("ring_of_fire_order.json", ring_of_fire_layer(rings))
    write_json("land.json", land_layer())
    write_json("meta.json", meta_layer())


if __name__ == "__main__":
    main()
