"""Compute the key figures for "Switzerland in one line" (ONE LINE 01).

What it does: I draw one straight line through Basel and the Dufourspitze, the highest summit in
Switzerland, and keep the part that lies inside Switzerland: it starts on the Rhine at the German
border and ends on the Italian border on Monte Rosa. Along that line I read the Copernicus DEM
every 30 m (the height profile the reel animates), then work out every number the reel shows:
the length of the line, the height where it starts, the high and low points it crosses on the
way (Jura, Lake Thun, the Bernese Alps, the Rhône valley), and the summit at the end.
Reads:  data/raw/ (run data/download.py first). No network.
Writes: data/key_figures.json
Run:    uv run data/key_figures.py   (from the piece folder)

What you learn: how to cut an elevation profile out of a DEM, and why a profile is not a list of
summit heights. A 30 m cell holds one height for a 30 x 30 m patch, so on a sharp summit it sits
below the top. Copernicus DEM is also a radar surface model, and on steep alpine faces it is
partly filled in, so near 4,600 m it reads about 100 m low. I therefore show the official summit
height from the swisstopo national map, check it against swisstopo's surveyed name point in the
data, and report the DEM's own peak next to it, instead of hiding the gap. Every label is tied to an official swisstopo name point, so the reel never
guesses where the Jura or the Rhône valley is.

This is the template for the ONE LINE series: change LINE_ANCHORS, COUNTRY_ICC and LABELS for
the next place and the rest stays the same.
"""

import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
from pyproj import Geod, Transformer
from rasterio.merge import merge
from shapely.geometry import LineString, Point

HERE = Path(__file__).parent
RAW_DIR = HERE / "raw"
DEM30_DIR = RAW_DIR / "copernicus_dem_30"
BOUNDARIES_GPKG = (
    RAW_DIR / "swissboundaries3d_2026-01_2056_5728" / "swissBOUNDARIES3D_1_5_LV95_LN02.gpkg"
)
NAMES_CSV = RAW_DIR / "swissnames3d_2026_2056" / "swissNAMES3D_PKT.csv"
OUT_FILE = HERE / "key_figures.json"

# I work in the Swiss national grid, LV95 (EPSG:2056): metres, very small scale error across the
# country, and the CRS swisstopo publishes in. A straight line in LV95 is the line the reel draws.
CRS_CH = "EPSG:2056"
CRS_DEM = "EPSG:4326"

# The line: two swissNAMES3D name points it must pass through. It is extended past both and cut
# to the country, so it runs border to border.
LINE_ANCHORS = [("Basel", "Ort"), ("Dufourspitze", "Alpiner Gipfel")]
COUNTRY_ICC = "CH"
EXTEND_M = 30_000  # far enough to reach the border beyond each anchor
STEP_M = 30.0  # one profile sample per DEM cell

# On-screen labels. Each is tied to an official name point: I project that point onto the line
# and take the highest (max) or lowest (min) DEM height within WINDOW_KM of it. "display" is the
# label text; the number in it comes from the data.
LABELS = [
    {
        "id": "jura",
        "anchor": ("Hällchöpfli", "Haupthuegel"),
        "mode": "max",
        "window_km": 3.0,
        "label": "JURA",
    },
    {
        "id": "lake_thun",
        "anchor": ("Merligen", "Ort"),
        "mode": "min",
        "window_km": 1.5,
        "label": "LAKE THUN",
    },
    {
        "id": "bernese_alps",
        "anchor": ("Blüemlisalphorn", "Alpiner Gipfel"),
        "mode": "max",
        "window_km": 1.5,
        "label": "BLÜEMLISALP",
    },
    {
        "id": "rhone_valley",
        "anchor": ("Raron", "Ort"),
        "mode": "min",
        "window_km": 2.0,
        "label": "RHÔNE VALLEY",
    },
]

SRC_DEM = "Copernicus DEM GLO-30 (ESA / Copernicus)"
SRC_NAMES = "swissNAMES3D 2026 (Federal Office of Topography swisstopo)"
SRC_BORDER = "swissBOUNDARIES3D 2026-01 (Federal Office of Topography swisstopo)"

# Published reference values. These are not results: they are what my results are checked
# against. Spot heights come from swisstopo's height service (swissALTI3D, a 2 m lidar terrain
# model) at the exact point my profile reports, read on 11 Nov 2026. Lake Thun is checked
# against its official lake level instead, because the lake surface is what the label names.
HEIGHT_SERVICE = (
    "swisstopo height service (swissALTI3D), https://api3.geo.admin.ch/rest/services/height"
)
REFERENCE_M = {
    "start_height": (244.8, HEIGHT_SERVICE),
    "jura": (1177.9, HEIGHT_SERVICE),
    "lake_thun": (
        558.0,
        "swissNAMES3D lake level of the Thunersee; https://en.wikipedia.org/wiki/Lake_Thun",
    ),
    "bernese_alps": (3633.2, HEIGHT_SERVICE),
    "rhone_valley": (633.8, HEIGHT_SERVICE),
}
# The official height of the summit the line ends on. This one is shown on screen, because the
# reel calls it the highest point of Switzerland and viewers will check it against the map. The
# data (swissNAMES3D) stores the summit as a whole metre one lower, so I keep that as the check.
SUMMIT_PUBLISHED_M = 4634
SUMMIT_PUBLISHED_SRC = (
    "swisstopo national map, as quoted in https://en.wikipedia.org/wiki/Dufourspitze"
)
TOLERANCE = 0.05  # step 1 rule: a difference above 5% needs an explanation or a label


def load_names() -> pd.DataFrame:
    names = pd.read_csv(NAMES_CSV, sep=";", low_memory=False)
    return names[names["STATUS"] == "offiziell"]


def name_point(names: pd.DataFrame, name: str, kind: str) -> pd.Series:
    """One official name point. Fail loudly if the name is missing or ambiguous."""
    hits = names[(names["NAME"] == name) & (names["OBJEKTART"] == kind)]
    hits = hits.drop_duplicates(subset=["E", "N"])
    if len(hits) != 1:
        raise ValueError(f"expected one {kind} called {name}, found {len(hits)}")
    return hits.iloc[0]


def border_to_border(names: pd.DataFrame) -> LineString:
    """The anchor line, extended and cut to the longest stretch inside the country."""
    a, b = (name_point(names, n, k) for n, k in LINE_ANCHORS)
    p0, p1 = np.array([a["E"], a["N"]], float), np.array([b["E"], b["N"]], float)
    unit = (p1 - p0) / np.linalg.norm(p1 - p0)
    long_line = LineString([p0 - unit * EXTEND_M, p1 + unit * EXTEND_M])
    countries = gpd.read_file(BOUNDARIES_GPKG, layer="tlm_landesgebiet").to_crs(CRS_CH)
    country = countries.loc[countries["icc"] == COUNTRY_ICC, "geometry"].union_all()
    inside = long_line.intersection(country)
    parts = list(getattr(inside, "geoms", [inside]))
    line = max(parts, key=lambda g: g.length)
    # 2D only: the border polygons carry heights, the profile comes from the DEM.
    return LineString([c[:2] for c in line.coords])


def profile(line: LineString) -> pd.DataFrame:
    """Sample the DEM every STEP_M along the line (nearest cell, so every value is a real cell)."""
    dist_m = np.arange(0.0, line.length + 0.001, STEP_M)
    pts = [line.interpolate(d) for d in dist_m]
    e = np.array([p.x for p in pts])
    n = np.array([p.y for p in pts])
    lon, lat = Transformer.from_crs(CRS_CH, CRS_DEM, always_xy=True).transform(e, n)
    tiles = sorted(DEM30_DIR.glob("*.tif"))
    if not tiles:
        raise FileNotFoundError(f"no DEM tiles in {DEM30_DIR}: run data/download.py")
    sources = [rasterio.open(t) for t in tiles]
    mosaic, transform = merge(sources)
    for s in sources:
        s.close()
    cols, rows = ~transform * (lon, lat)
    height_m = mosaic[0][np.floor(rows).astype(int), np.floor(cols).astype(int)].astype(float)
    if not (100 < height_m.min() and height_m.max() < 4900):
        raise ValueError(f"profile heights {height_m.min()} to {height_m.max()} m look wrong")
    return pd.DataFrame(
        {"dist_m": dist_m, "e": e, "n": n, "lon": lon, "lat": lat, "height_m": height_m}
    )


def along_km(line: LineString, e: float, n: float) -> tuple[float, float]:
    """Where a point projects onto the line (km from the start) and how far off it lies (m)."""
    pt = Point(e, n)
    return line.project(pt) / 1000, line.distance(pt)


def entry(fid, value, unit, display, source, method, check) -> dict:
    return {
        "id": fid,
        "value": value,
        "unit": unit,
        "display": display,
        "source": source,
        "method": method,
        "check": check,
    }


def compare(value: float, ref: float, ref_src: str) -> str:
    diff = (value - ref) / ref
    verdict = "inside" if abs(diff) <= TOLERANCE else "OUTSIDE"
    return f"{ref_src}: {ref:,.1f} m, difference {diff:+.1%}, {verdict} the 5% rule"


def main() -> None:
    names = load_names()
    line = border_to_border(names)
    prof = profile(line)
    start = prof.iloc[0]
    end = prof.iloc[-1]

    # Length on the ellipsoid, as a check on the LV95 length (they should agree within 0.1%).
    geod = Geod(ellps="WGS84")
    length_geod_km = geod.line_length([start.lon, end.lon], [start.lat, end.lat]) / 1000
    length_km = line.length / 1000
    print(f"line   {length_km:.1f} km in LV95, {length_geod_km:.1f} km on WGS84")
    print(f"       from {start.lat:.5f} N {start.lon:.5f} E to {end.lat:.5f} N {end.lon:.5f} E")

    figures = []
    figures.append(
        entry(
            "line_length",
            round(length_km, 1),
            "km",
            f"{length_km:,.0f} km",
            SRC_BORDER,
            "Straight line through Basel and the Dufourspitze, cut to the Swiss border, measured "
            "in LV95 (EPSG:2056).",
            f"WGS84 geodesic length {length_geod_km:.1f} km, "
            f"{(length_km - length_geod_km) / length_geod_km:+.2%}.",
        )
    )
    figures.append(
        entry(
            "start_height",
            round(float(start.height_m)),
            "m above sea level",
            f"{start.height_m:,.0f} m",
            SRC_DEM,
            "DEM height of the first profile cell, where the line enters Switzerland on the Rhine.",
            compare(float(start.height_m), *REFERENCE_M["start_height"]),
        )
    )

    for lab in LABELS:
        pt = name_point(names, *lab["anchor"])
        km, off_m = along_km(line, pt["E"], pt["N"])
        win = prof[(prof.dist_m / 1000 - km).abs() <= lab["window_km"]]
        row = win.loc[win.height_m.idxmax() if lab["mode"] == "max" else win.height_m.idxmin()]
        h = float(row.height_m)
        figures.append(
            entry(
                lab["id"],
                round(h),
                "m above sea level",
                f"{lab['label']} {h:,.0f} m",
                SRC_DEM,
                f"{'Highest' if lab['mode'] == 'max' else 'Lowest'} DEM cell on the line within "
                f"{lab['window_km']} km of the swisstopo name point {lab['anchor'][0]} "
                f"({off_m:,.0f} m off the line), at km {row.dist_m / 1000:.1f}, "
                f"{row.lat:.5f} N {row.lon:.5f} E (LV95 {row.e:.0f} {row.n:.0f}).",
                compare(h, *REFERENCE_M[lab["id"]]),
            )
        )

    # The summit: official height from the national map, checked against swissNAMES3D, with the
    # DEM's own peak next to it.
    summit = name_point(names, *LINE_ANCHORS[1])
    summit_km, _ = along_km(line, summit["E"], summit["N"])
    names_summit_m = float(summit["HOEHE"])
    summit_m = float(SUMMIT_PUBLISHED_M)
    peak = prof.loc[prof.height_m.idxmax()]
    figures.append(
        entry(
            "high_point",
            round(summit_m),
            "m above sea level",
            f"{summit_m:,.0f} m",
            SUMMIT_PUBLISHED_SRC,
            f"Official height of the Dufourspitze, the highest point of Switzerland, which the line "
            f"passes through at km {summit_km:.1f}. The big number.",
            f"swissNAMES3D 2026 name point in the data: {names_summit_m:,.0f} m, "
            f"{names_summit_m - summit_m:+.0f} m ({(names_summit_m - summit_m) / summit_m:+.2%}), "
            "inside the 5% rule; the data stores whole metres.",
        )
    )
    figures.append(
        entry(
            "dem_peak",
            round(float(peak.height_m)),
            "m above sea level",
            f"{peak.height_m:,.0f} m",
            SRC_DEM,
            f"Highest DEM cell on the whole profile, at km {peak.dist_m / 1000:.1f}. Not for the "
            "screen: it shows how far the 30 m radar DEM sits below a sharp summit.",
            compare(float(peak.height_m), SUMMIT_PUBLISHED_M, SUMMIT_PUBLISHED_SRC),
        )
    )
    peaks = names[names["OBJEKTART"].isin(["Hauptgipfel", "Alpiner Gipfel", "Gipfel"])]
    end_dist_m = np.hypot(peaks["E"] - end.e, peaks["N"] - end.n)
    end_peak = peaks.loc[end_dist_m.idxmin()]
    end_off_m = float(end_dist_m.min())
    climb_m = summit_m - float(start.height_m)
    figures.append(
        entry(
            "climb",
            round(climb_m),
            "m",
            f"{climb_m:,.0f} m",
            f"swisstopo national map; {SRC_DEM}",
            "Summit height minus the start height, so the screen adds up.",
            f"{summit_m:,.0f} minus {start.height_m:,.0f}.",
        )
    )
    figures.append(
        entry(
            "end_height",
            round(float(end.height_m)),
            "m above sea level",
            f"{end.height_m:,.0f} m",
            SRC_DEM,
            "DEM height of the last profile cell, where the line meets the Italian border.",
            f"Below the summit, as it should be: the line follows the border ridge for "
            f"{end.dist_m / 1000 - summit_km:.1f} km past the Dufourspitze and leaves Switzerland "
            f"next to the {end_peak['NAME']} ({end_peak['HOEHE']:,.0f} m, {end_off_m:,.0f} m away).",
        )
    )
    figures.append(
        entry(
            "profile_step",
            STEP_M,
            "m",
            "one height every 30 m",
            SRC_DEM,
            f"Profile sample spacing; {len(prof):,} samples along the line.",
            "Matches the GLO-30 cell (1 arc second, about 31 m north-south here).",
        )
    )

    OUT_FILE.write_text(json.dumps(figures, indent=2, ensure_ascii=False))
    print(f"\n{'id':<14}{'display':<26}value")
    for f in figures:
        print(f"{f['id']:<14}{f['display']:<26}{f['value']} {f['unit']}")
    print(f"\nwrote  {OUT_FILE}")


if __name__ == "__main__":
    main()
