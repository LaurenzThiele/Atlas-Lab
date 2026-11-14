"""Compute the key figures for "Where Norway's power comes from" (ON THE LAND 01).

What it does: I take every Norwegian plant in the Global Power Plant Database and add up its
capacity by fuel: the hydro share is the big number, the hydro capacity is the counter that runs
while the plants light up, and the largest plant is the one label on a plant. Then I measure the
OpenStreetMap high-voltage lines inside the mainland border, split by voltage, for the line
counter, and read the highest point of the Copernicus relief for the one label on the land.
Reads:  data/raw/ (run data/download.py first). No network.
Writes: data/key_figures.json
Run:    uv run data/key_figures.py   (from the piece folder)

What you learn: a database is a sample, not the country. The WRI database takes its Norwegian
plants from the ENTSO-E list of large generating units, so it holds about 300 plants where the
national register (NVE) holds about 1,800 hydro plants alone, and only a tenth of the wind
capacity. Big hydro is nearly complete, small hydro and wind are mostly missing, so the hydro
share comes out higher than the official one. I print both and the reel names the database.
The same goes for the lines: OpenStreetMap stores one line per row of pylons, so a pylon row
with two circuits counts once, which is how grid operators count line length too.

This is the template for the ON THE LAND series: change COUNTRY_ISO3, the mainland box, the
voltage classes and the checks for the next place and the rest stays the same.
"""

import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
from pyproj import Geod
from shapely.geometry import LineString, box

HERE = Path(__file__).parent
RAW_DIR = HERE / "raw"
GPPD_CSV = RAW_DIR / "global_power_plant_database_v_1_3" / "global_power_plant_database.csv"
LINES_JSON = RAW_DIR / "osm_power_lines_norway_100kv.json"
NE_ZIP = RAW_DIR / "ne_10m_admin_0_countries.zip"
DEM_DIR = RAW_DIR / "copernicus_dem_90"
OUT_FILE = HERE / "key_figures.json"

COUNTRY_ISO3 = "NOR"
# Mainland Norway only: this box cuts Svalbard and Jan Mayen off the Natural Earth polygon.
MAINLAND_BOX = box(0.0, 57.0, 32.0, 71.5)
# Voltage classes in kV, highest first. 420 and 300 kV are the transmission grid Statnett runs,
# 132 kV is mostly regional grid (a few 132 kV lines in the north are transmission grid).
# I count the two transmission classes exactly (300 and 420 kV) so the length compares with
# Statnett's own table, which lists them on their own.
TRANSMISSION_KV = (300, 420)
HV_MIN_KV = 100

# Lengths are geodesic, on the WGS84 ellipsoid. Mainland Norway runs over 27 degrees of longitude
# and six UTM zones, so any one projection (even EPSG:25833, UTM 33N, the national one) stretches
# the far ends by a percent or more; measuring on the ellipsoid needs no projection at all.
GEOD = Geod(ellps="WGS84")

GPPD_SOURCE = "Global Power Plant Database v1.3.0 (WRI, 2021)"
OSM_SOURCE = "OpenStreetMap power lines (© OpenStreetMap contributors, ODbL)"
DEM_SOURCE = "Copernicus DEM GLO-90 (ESA / Copernicus)"

# Published figures I check against. They are never used to compute a figure, only to report
# how far the data is from the official number.
SSB_URL = "https://www.ssb.no/en/energi-og-industri/energi/statistikk/elektrisitet"
SSB_2021 = {"total_mw": 40_257, "hydro_mw": 34_075}  # Table 6, installed capacity, 2021
NVE_URL = "https://www.nve.no/energi/energisystem/kraftproduksjon/"
NVE_HYDRO_PLANTS_2024 = 1_791  # hydro plants per 31.12.2024
GRID_URL = "https://energifaktanorge.no/en/norsk-energiforsyning/kraftnett/"
STATNETT_URL = (
    "https://www.statnett.no/globalassets/om-statnett/investorrelasjoner/arsrapporter/"
    "statnett-arsrapport-2021.pdf"
)
# Statnett annual report 2021, "Kraftledninger på drift fordelt på spenningsnivå", 2021 column.
STATNETT_2021_KM = {300: 4_092, 420: 4_706}
SNL_PEAK_URL = "https://snl.no/Galdh%C3%B8piggen"
GALDHOPIGGEN_M = 2_469
GALDHOPIGGEN_LATLON = (61.6365, 8.3125)
STATKRAFT_KVILLDAL_URL = (
    "https://www.statkraft.com/Global-presence/norway/kvilldal-hydropower-plant/"
)
KVILLDAL_MW = 1_240  # Statkraft and SNL; SNL also calls it Norway's largest hydro plant


def pct_diff(value: float, ref: float) -> float:
    return 100.0 * (value - ref) / ref


def check_text(value: float, ref: float, what: str, url: str) -> str:
    d = pct_diff(value, ref)
    verdict = "inside the 5% rule" if abs(d) <= 5 else "outside the 5% rule, label needed"
    return f"{what}; {url}: {ref:,.0f}, difference {d:+.1f}%, {verdict}"


def mainland() -> "gpd.GeoSeries":
    world = gpd.read_file(f"zip://{NE_ZIP}")
    norway = world[world["ADM0_A3"] == COUNTRY_ISO3]
    if norway.empty:
        raise ValueError("Norway not found in Natural Earth")
    return norway.geometry.union_all().intersection(MAINLAND_BOX)


def plant_figures() -> list[dict]:
    plants = pd.read_csv(GPPD_CSV, low_memory=False)
    nor = plants[plants["country"] == COUNTRY_ISO3]
    if not 100 < len(nor) < 2000:
        raise ValueError(f"unexpected number of Norwegian plants: {len(nor)}")
    if (nor["capacity_mw"] <= 0).any() or nor["capacity_mw"].isna().any():
        raise ValueError("a plant without a capacity")
    by_fuel_mw = nor.groupby("primary_fuel")["capacity_mw"].sum()
    total_mw = float(nor["capacity_mw"].sum())
    hydro = nor[nor["primary_fuel"] == "Hydro"]
    hydro_mw = float(hydro["capacity_mw"].sum())
    share_pct = 100.0 * hydro_mw / total_mw
    ssb_share_pct = 100.0 * SSB_2021["hydro_mw"] / SSB_2021["total_mw"]
    biggest = hydro.sort_values("capacity_mw", ascending=False).iloc[0]
    fuels = ", ".join(f"{f} {mw:,.0f} MW" for f, mw in by_fuel_mw.sort_values().items())
    sources = ", ".join(sorted(nor["source"].unique()))
    print(f"plants {len(nor)} ({fuels}); capacity from: {sources}")
    print(
        "years: commissioning_year filled for "
        f"{nor['commissioning_year'].notna().sum()}, year_of_capacity_data filled for "
        f"{nor['year_of_capacity_data'].notna().sum()} of {len(nor)}"
    )
    db_label = "large plants in the WRI database, 2021"
    return [
        {
            "id": "hydro_share",
            "value": round(share_pct, 1),
            "unit": "% of installed capacity",
            "display": f"{share_pct:.0f}%",
            "label": f"of the capacity is hydro ({db_label})",
            "source": GPPD_SOURCE,
            "method": f"Hydro capacity / all capacity of the {len(nor)} Norwegian plants "
            f"({fuels}).",
            "check": (
                f"SSB Table 6, installed capacity 2021, hydro {SSB_2021['hydro_mw']:,} of "
                f"{SSB_2021['total_mw']:,} MW = {ssb_share_pct:.1f}%; {SSB_URL}: difference "
                f"{share_pct - ssb_share_pct:+.1f} points ({pct_diff(share_pct, ssb_share_pct):+.1f}%)"
                ", outside the 5% rule. Cause: the database takes Norway from the ENTSO-E list "
                f"of large units, so it has {by_fuel_mw.get('Wind', 0):,.0f} MW of wind against "
                "about 5,000 MW in SSB and misses most small hydro. Label needed."
            ),
        },
        {
            "id": "hydro_capacity",
            "value": round(hydro_mw),
            "unit": "MW",
            "display": f"{hydro_mw:,.0f} MW",
            "label": db_label,
            "source": GPPD_SOURCE,
            "method": "Sum of capacity_mw over the plants with primary_fuel Hydro; the counter "
            "runs to this value as the plants light up.",
            "check": check_text(hydro_mw, SSB_2021["hydro_mw"], "SSB Table 6, hydro 2021", SSB_URL)
            + ". Cause: small hydro plants are not in the ENTSO-E list.",
        },
        {
            "id": "hydro_plants",
            "value": len(hydro),
            "unit": "plants",
            "display": f"{len(hydro):,} hydropower plants",
            "label": db_label,
            "source": GPPD_SOURCE,
            "method": "Number of rows with primary_fuel Hydro.",
            "check": check_text(
                len(hydro), NVE_HYDRO_PLANTS_2024, "NVE, hydro plants per 31.12.2024", NVE_URL
            )
            + ". Cause: the database holds the large plants only; do not show this as all of "
            "Norway's plants.",
        },
        {
            # The database's MW for its biggest plants come from ENTSO-E and run higher than the
            # owners' figures, so the label shows the name only: the ranking holds, the MW not.
            "id": "largest_plant",
            "value": round(float(biggest["capacity_mw"])),
            "unit": "MW",
            "display": f"{biggest['name'].upper()}",
            "label": "Norway's largest hydro plant (name only, no MW on screen)",
            "source": GPPD_SOURCE,
            "method": f"Hydro plant with the highest capacity_mw, at {biggest['latitude']:.4f} N "
            f"{biggest['longitude']:.4f} E (source {biggest['source']}).",
            "check": check_text(
                float(biggest["capacity_mw"]),
                KVILLDAL_MW,
                "Statkraft, Kvilldal installed capacity",
                STATKRAFT_KVILLDAL_URL,
            )
            + ". The ranking agrees (Statkraft and SNL: Norway's largest by capacity), so the "
            "name goes on screen and the MW does not.",
        },
        {
            "id": "all_capacity",
            "value": round(total_mw),
            "unit": "MW",
            "display": f"{total_mw:,.0f} MW",
            "label": "all plants in the database (not for screen)",
            "source": GPPD_SOURCE,
            "method": "Sum of capacity_mw over all Norwegian plants (denominator of the share).",
            "check": check_text(
                total_mw, SSB_2021["total_mw"], "SSB Table 6, all types 2021", SSB_URL
            ),
        },
    ]


def max_kv(voltage: str) -> float:
    """The voltage tag holds volts, one value per circuit ("420000;132000"). I keep the highest,
    because that is the class the pylons are built for."""
    volts = [float(v) for v in voltage.replace(",", ";").split(";") if v.strip().isdigit()]
    return max(volts) / 1000 if volts else np.nan


def line_figures(land) -> list[dict]:
    data = json.loads(LINES_JSON.read_text(encoding="utf-8"))
    rows = []
    for el in data["elements"]:
        if el["type"] != "way" or len(el.get("geometry", [])) < 2:
            continue
        coords = [(p["lon"], p["lat"]) for p in el["geometry"]]
        rows.append(
            {
                "id": el["id"],
                "kv": max_kv(el["tags"].get("voltage", "")),
                "geometry": LineString(coords),
            }
        )
    lines = gpd.GeoDataFrame(rows, crs="EPSG:4326")
    if not 3000 < len(lines) < 30000:
        raise ValueError(f"unexpected number of line ways: {len(lines)}")
    # Lines that cross into Sweden, Finland or Russia are cut at the border. Natural Earth's
    # 1:10m outline is coarse along the coast, so I buffer it by about 2 km (0.02 degrees) to keep
    # the short spans that hop between islands.
    lines["geometry"] = lines.geometry.intersection(land.buffer(0.02))
    lines = lines[~lines.geometry.is_empty]
    lines["length_km"] = [GEOD.geometry_length(g) / 1000 for g in lines.geometry]
    hv = lines[lines["kv"] >= HV_MIN_KV]
    by_kv = hv.groupby(hv["kv"].round())["length_km"].sum().sort_index(ascending=False)
    print("line km by kV: " + ", ".join(f"{kv:.0f} kV {km:,.0f}" for kv, km in by_kv.items()))
    trans_km = float(hv.loc[hv["kv"].round().isin(TRANSMISSION_KV), "length_km"].sum())
    statnett_km = sum(STATNETT_2021_KM.values())
    hv_km = float(hv["length_km"].sum())
    return [
        {
            "id": "transmission_km",
            "value": round(trans_km),
            "unit": "km",
            "display": f"{round(trans_km, -2):,.0f} km",
            "label": "of 300 and 420 kV lines",
            "source": OSM_SOURCE,
            "method": "Geodesic length of OSM power=line ways with a top voltage of 300 or "
            "420 kV, cut to the mainland border (line length, not circuit length).",
            "check": check_text(
                trans_km,
                statnett_km,
                "Statnett annual report 2021, overhead lines in operation, "
                "300 kV 4,092 km + 420 kV 4,706 km",
                STATNETT_URL,
            )
            + ". OSM is from today and Statnett keeps upgrading 300 kV lines to 420 kV. Energy "
            "Facts Norway's 'about 12,000 km' adds 132 kV transmission lines and cables, so it is "
            "not the same count.",
        },
        {
            "id": "hv_lines_km",
            "value": round(hv_km),
            "unit": "km",
            "display": f"{round(hv_km, -2):,.0f} km",
            "label": f"of lines of {HV_MIN_KV} kV and more (not for screen)",
            "source": OSM_SOURCE,
            "method": f"Geodesic length of all {len(hv):,} OSM power=line ways of {HV_MIN_KV} kV "
            "or more, cut to the mainland border; the lines the reel draws.",
            "check": "no published total for 100 kV and up to compare with (Energy Facts Norway: "
            "regional grid 33 to 132 kV about 19,000 km, transmission about 12,000 km, "
            f"{GRID_URL}); not checked, keep it off screen.",
        },
    ]


def relief_figure() -> list[dict]:
    """Find the highest DEM cell on the mainland. A 90 m cell is the mean of a 90 x 90 m patch,
    so on a summit it sits a little below the surveyed top."""
    best = (-np.inf, None, None)
    for tif in sorted(DEM_DIR.glob("*.tif")):
        with rasterio.open(tif) as src:
            z = src.read(1)
            row, col = np.unravel_index(np.argmax(z), z.shape)
            if z[row, col] > best[0]:
                lon, lat = src.xy(row, col)
                best = (float(z[row, col]), lat, lon)
    height_m, lat, lon = best
    if not 1500 < height_m < 3000:
        raise ValueError(f"unexpected highest point {height_m}")
    off_km = GEOD.inv(lon, lat, GALDHOPIGGEN_LATLON[1], GALDHOPIGGEN_LATLON[0])[2] / 1000
    return [
        {
            "id": "highest_point",
            "value": round(height_m),
            "unit": "m above sea level",
            "display": f"GALDHØPIGGEN {height_m:,.0f} m",
            "label": "highest point of the relief",
            "source": DEM_SOURCE,
            "method": f"Highest GLO-90 cell over the mainland tiles, at {lat:.4f} N {lon:.4f} E, "
            f"{off_km:.1f} km from the surveyed summit of Galdhøpiggen.",
            "check": check_text(
                height_m, GALDHOPIGGEN_M, "Store norske leksikon, Galdhøpiggen", SNL_PEAK_URL
            ),
        }
    ]


def main() -> None:
    for path in (GPPD_CSV, LINES_JSON, NE_ZIP, DEM_DIR):
        if not path.exists():
            raise FileNotFoundError(f"{path} missing, run data/download.py first")
    land = mainland()
    figures = plant_figures() + line_figures(land) + relief_figure()
    OUT_FILE.write_text(json.dumps(figures, indent=2, ensure_ascii=False) + "\n")
    print(f"\n{'id':<18}{'display':<34}label")
    for f in figures:
        print(f"{f['id']:<18}{f['display']:<34}{f['label']}")
    print(f"\nwrote {OUT_FILE}")


if __name__ == "__main__":
    main()
