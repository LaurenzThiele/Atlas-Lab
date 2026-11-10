"""Compute the key figures for "Every tsunami on record, as ripples".

What it does: I keep the tsunami runups that NCEI rates as definite or probable and that have a
location and a water height (these are the rings on the map), then count them, find their time
span, measure how many sit in the Pacific and in Japan, find the tallest runup and the deadliest
tsunami, and compare each number with a published figure.
Reads:  data/raw/ncei_tsunami_runups.json, data/raw/ncei_tsunami_regions.json
        (run data/download.py first). No network.
Writes: data/key_figures.json
Run:    uv run data/key_figures.py   (from the piece folder)

What you learn: the difference between a tsunami (one event) and a runup (one place where that
event was seen), why that difference changes every percentage you compute, and why a historical
catalogue needs a quality filter before you trust it. Runups are points with a height, not
areas or distances, so no projected CRS is needed here: I only count and compare.
"""

import json
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
RAW_DIR = HERE / "raw"
RUNUPS_JSON = RAW_DIR / "ncei_tsunami_runups.json"
REGIONS_JSON = RAW_DIR / "ncei_tsunami_regions.json"
OUT_FILE = HERE / "key_figures.json"

SRC = "NOAA NCEI Global Historical Tsunami Database"

# NCEI rates every tsunami: 4 definite, 3 probable, 2 questionable, 1 very doubtful, 0 a seiche
# or disturbance in an inland river or lake, -1 erroneous. I keep 3 and 4. Without this filter
# the "deadliest tsunami" would be the 1737 Calcutta disaster (300,000 deaths), which NCEI
# itself marks as erroneous: it was a cyclone storm surge, not a tsunami.
MIN_VALIDITY = 3

# NCEI region codes 80 to 89 are the Pacific coasts: Hawaii, the South Pacific, Melanesia,
# eastern Indonesia, East Asia, Japan, Kamchatka, Alaska and the Americas' west coasts.
PACIFIC_CODES = range(80, 90)
JAPAN = "JAPAN"

# Figures the runup table cannot give. NCEI keeps a tsunami's total death toll in its event
# table (one row per tsunami), not in the runup table (one row per place). I copied the number
# from the event record and check below that it belongs to the tsunami my data calls deadliest.
DEADLIEST_EVENT_ID = 2439
DEADLIEST_DEATHS = 227_899  # "deaths": 227899, event 2439, 26 Dec 2004, off W. coast of Sumatra
NCEI_EVENT_URL = "https://www.ngdc.noaa.gov/hazel/hazard-service/api/v1/tsunamis/events/2439"

# Published figures I check my own numbers against.
NOAA_LOCATIONS_URL = "https://www.noaa.gov/jetstream/tsunamis/tsunami-locations"
PUBLISHED_PACIFIC_SHARE = 0.78  # "78% Pacific Ocean (around the geologically active Ring of Fire)"
PUBLISHED_JAPAN_SHARE = 0.20  # "generated off Japan (20%)"
NASA_LITUYA_URL = (
    "https://science.nasa.gov/earth/earth-observatory/lituya-bays-apocalyptic-wave-147557/"
)
PUBLISHED_LITUYA_M = 524  # "waves splashed up to an elevation of 1,720 feet (524 meters)"
MAX_DIFF = 0.10


def load_rings() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Return all definite or probable runups, and the subset I can draw as rings."""
    for path in (RUNUPS_JSON, REGIONS_JSON):
        if not path.exists():
            raise FileNotFoundError(f"{path} is missing: run uv run data/download.py first")
    runups = pd.DataFrame(json.loads(RUNUPS_JSON.read_text()))
    valid = runups[runups["sourceEventValidity"] >= MIN_VALIDITY].copy()
    # A ring needs a place and a size. About 1 in 7 runups is only a written report ("the sea
    # flooded the town") with no measured height, and a few have no coordinates. A height of 0
    # means the wave was noticed but not measurable, which would draw an invisible ring.
    has_place = valid["latitude"].notna() & valid["longitude"].notna()
    has_height = valid["runupHt"] > 0
    rings = valid[has_place & has_height].rename(columns={"runupHt": "runup_m"})
    if (
        not rings["latitude"].between(-90, 90).all()
        or not rings["longitude"].between(-180, 180).all()
    ):
        raise ValueError("coordinates outside lon/lat range: the export format has changed")
    if not rings["runup_m"].between(0, 600).all():
        raise ValueError("a runup height outside 0 to 600 m: check the units")
    print(
        f"read   {len(runups):,} runups, {len(valid):,} definite or probable, {len(rings):,} rings"
    )
    return valid, rings


def home_region(rings: pd.DataFrame) -> pd.DataFrame:
    """One row per tsunami, placed at its runup nearest the source.

    The runup table has no ocean for the source itself, so I use the closest observed runup as
    a stand-in. It lets me count tsunamis (as NOAA does) instead of runups.
    """
    nearest = rings.sort_values("distFromSource", na_position="last")
    return nearest.groupby("tsunamiEventId").first()


def check(computed: float, published: float, url: str) -> str:
    """Compare with a published figure and fail if they differ by more than MAX_DIFF."""
    diff = computed / published - 1
    if abs(diff) > MAX_DIFF:
        raise ValueError(f"{computed} vs published {published} differs by {diff:+.1%}")
    return f"{computed:g} vs published {published:g} ({diff:+.1%}), {url}"


def main() -> None:
    valid, rings = load_rings()
    regions = {int(r["id"]): r["description"] for r in json.loads(REGIONS_JSON.read_text())}
    # Short names for the screen: "Alaska (including Aleutian Islands)" becomes "Alaska".
    short = {code: name.split(" (")[0] for code, name in regions.items()}
    events = home_region(rings)
    figures = []

    n_rings = len(rings)
    n_events = rings["tsunamiEventId"].nunique()
    figures.append(
        {
            "id": "ring_count",
            "value": n_rings,
            "unit": "runups",
            "display": f"{n_rings:,} rings",
            "source": SRC,
            "method": f"Runups rated definite or probable (validity >= {MIN_VALIDITY}) with "
            "coordinates and a water height above 0 m.",
        }
    )
    figures.append(
        {
            "id": "tsunami_count",
            "value": n_events,
            "unit": "tsunamis",
            "display": f"{n_events:,} tsunamis",
            "source": SRC,
            "method": "Distinct tsunamiEventId among the rings.",
        }
    )

    first_year, last_year = int(rings["year"].min()), int(rings["year"].max())
    first = rings.loc[rings["year"].idxmin()]
    figures.append(
        {
            "id": "year_span",
            "value": [first_year, last_year],
            "unit": "year",
            "display": f"{first_year} to {last_year}",
            "source": SRC,
            "method": f"Earliest and latest year among the rings. The earliest is "
            f"{first['locationName'].title()}, {first['country'].title()} ({first['runup_m']:g} m).",
        }
    )

    # Two shares that answer two questions. Per ring: how much of the map is Pacific. Per
    # tsunami: how many tsunamis happen there, which is what NOAA publishes. Japan's dense tide
    # gauge network logs thousands of runups for one big tsunami (2011 alone has over 6,000), so
    # the per-ring share is always higher than the per-tsunami share.
    pacific_rings = rings["regionCode"].isin(PACIFIC_CODES).mean()
    pacific_events = events["regionCode"].isin(PACIFIC_CODES).mean()
    figures.append(
        {
            "id": "pacific_share",
            "value": round(pacific_rings * 100, 1),
            "unit": "% of rings",
            "display": f"{pacific_rings:.0%} of the rings are in the Pacific",
            "source": SRC,
            "method": "Rings with NCEI region code 80 to 89 / all rings. Region names: "
            + ", ".join(regions[c] for c in PACIFIC_CODES if c in regions)
            + ".",
            "check": "Per tsunami (nearest runup's region): "
            + check(round(pacific_events, 3), PUBLISHED_PACIFIC_SHARE, NOAA_LOCATIONS_URL),
        }
    )

    japan_rings = (rings["country"] == JAPAN).mean()
    japan_events = (events["country"] == JAPAN).mean()
    top_country = rings["country"].value_counts().index[0]
    if top_country != JAPAN:
        raise ValueError(f"the country with most rings is {top_country}, not Japan")
    figures.append(
        {
            "id": "japan_share",
            "value": round(japan_rings * 100, 1),
            "unit": "% of rings",
            "display": f"Japan: {japan_rings:.0%} of all rings",
            "source": SRC,
            "method": "Rings with country JAPAN / all rings. Japan has the most rings of any "
            "country.",
            "check": "Per tsunami (nearest runup in Japan): "
            + check(round(japan_events, 3), PUBLISHED_JAPAN_SHARE, NOAA_LOCATIONS_URL),
        }
    )

    # The same two shares per tsunami, the way NOAA counts them, as whole percents.
    # Per tsunami the Pacific is 75%, not the 84% of rings, and Japan is about a fifth of all
    # tsunamis but 40% of the rings: its dense network of tide gauges logs thousands of places for
    # one big tsunami, so counting rings weighs Japan far heavier than counting tsunamis does.
    for figure_id, share, place in (
        ("pacific_tsunami_share", pacific_events, "the Pacific"),
        ("japan_tsunami_share", japan_events, "Japan"),
    ):
        published = (
            PUBLISHED_PACIFIC_SHARE if figure_id.startswith("pacific") else PUBLISHED_JAPAN_SHARE
        )
        figures.append(
            {
                "id": figure_id,
                "value": round(share * 100, 1),
                "unit": "% of tsunamis",
                "display": f"{share:.0%} of tsunamis hit {place}",
                "source": SRC,
                "method": "Tsunamis whose runup nearest the source is in the region / all tsunamis "
                "with a ring, as a whole percent",
                "check": check(round(share, 3), published, NOAA_LOCATIONS_URL),
            }
        )

    tallest = rings.loc[rings["runup_m"].idxmax()]
    tallest_place = tallest["locationName"].split(",")[0].title()
    tallest_region = short[int(tallest["regionCode"])]
    figures.append(
        {
            "id": "max_runup",
            "value": float(tallest["runup_m"]),
            "unit": "m",
            "display": f"{tallest['runup_m']:.0f} m, {tallest_place}, {tallest_region}, "
            f"{int(tallest['year'])}",
            "source": SRC,
            "method": f"Largest runupHt among the rings: {tallest['locationName']}, "
            f"{int(tallest['year'])}. A landslide wave inside a fjord, not an ocean tsunami.",
            "check": check(round(float(tallest["runup_m"])), PUBLISHED_LITUYA_M, NASA_LITUYA_URL),
        }
    )

    # The deadliest tsunami in my data: the one whose runups carry the most deaths. The runup
    # deaths come from separate place-by-place reports, so they do not add up exactly to the
    # event total NCEI publishes. I use the runups only to find the event, and take the toll
    # from NCEI's own event record, which is the number NOAA reports for the whole tsunami.
    deaths_by_event = valid.groupby("tsunamiEventId")["deaths"].sum()
    deadliest_id = int(deaths_by_event.idxmax())
    if deadliest_id != DEADLIEST_EVENT_ID:
        raise ValueError(f"deadliest event is {deadliest_id}, the copied toll is for 2439")
    deadliest = valid[valid["tsunamiEventId"] == deadliest_id]
    year = int(deadliest["year"].iloc[0])
    region = short[int(events.loc[deadliest_id, "regionCode"])]
    runup_deaths = int(deaths_by_event.max())
    figures.append(
        {
            "id": "death_toll",
            "value": DEADLIEST_DEATHS,
            "unit": "deaths",
            "display": f"{DEADLIEST_DEATHS:,} deaths, {region}, {year}",
            "source": f"{SRC}, event {deadliest_id}, {NCEI_EVENT_URL}",
            "method": "Deadliest tsunami = most runup deaths among definite or probable "
            "events; toll copied from the NCEI event record (deaths column).",
            "check": f"Sum of the {len(deadliest):,} runup rows for this event: "
            + check(runup_deaths, DEADLIEST_DEATHS, NCEI_EVENT_URL),
        }
    )

    OUT_FILE.write_text(json.dumps(figures, indent=2, ensure_ascii=False))
    print(f"\n{'id':<23}{'display':<50}")
    for f in figures:
        print(f"{f['id']:<23}{f['display']:<50}")
    print(f"\nwrote  {OUT_FILE}")


if __name__ == "__main__":
    main()
