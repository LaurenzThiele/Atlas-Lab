"""Turn the raw downloads into the small layers the atlas plate loads in the browser.

What it does: I measure every Roman road geodesically, join the 14,769 segments into one network,
work out how far every point on it is from Rome along the roads, and cut the roads into short
pieces that know that distance. That number is what lets the map "draw" the empire outward from
one city. I also clip and simplify the coastline, lakes and rivers and build the graticule.
Reads:  data/raw/itinere_roads.gpkg, data/raw/ne_10m_*/, data/raw/sources.json,
        data/key_figures.json
Writes: maps/layers/ (roads.pmtiles with the roads and the certainty chains as vector tiles,
        plate.pmtiles with the land, coast, water lines, lakes and rivers, and the small files
        events, segments, totals, draw_curve, graticule, places, key_figures, meta)
Run:    uv run maps/prepare.py   (from the piece folder)

What you learn: why a length depends on how you measure it, how to turn loose line segments into
a graph with snapped nodes, how Dijkstra gives a "distance from" value for a whole network, and
how to keep display geometry simple while every figure still comes from the exact geometry.
"""

import gzip
import json
import math
import shutil
from datetime import date
from pathlib import Path

import geopandas as gpd
import networkx as nx
import numpy as np
import pandas as pd
import shapely
from mapbox_vector_tile import encode as encode_mvt
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import write as write_pmtiles_file
from pyproj import Geod, Transformer
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, box, mapping

HERE = Path(__file__).parent
RAW_DIR = HERE.parent / "data" / "raw"
KEY_FIGURES_IN = HERE.parent / "data" / "key_figures.json"
SOURCES_IN = RAW_DIR / "sources.json"
OUT_DIR = HERE / "layers"

ROADS_GPKG = RAW_DIR / "itinere_roads.gpkg"
LAND_SHP = RAW_DIR / "ne_10m_land" / "ne_10m_land.shp"
LAKES_SHP = RAW_DIR / "ne_10m_lakes" / "ne_10m_lakes.shp"
RIVERS_SHP = RAW_DIR / "ne_10m_rivers_lake_centerlines" / "ne_10m_rivers_lake_centerlines.shp"

FILE_CRS = "EPSG:3395"  # World Mercator, how Zenodo ships Itiner-e
GEO_CRS = "EPSG:4326"  # lon/lat on WGS84: what the browser and pyproj.Geod both want
# Lambert conformal conic for Europe, in metres. It is conformal, so shapes and short distances
# stay true around any point. That is what I need for "within 25 m" and for buffers, and it is
# why I do neither in degrees (not a length) or in the file's Mercator (too stretched here).
METRIC_CRS = "EPSG:3034"

EXPECTED_SEGMENTS = 14_769
# Mainland, Britain and the islands. The count is the same for any snap from 1 m to 50 m, which
# tells me 25 m closes the digitising gaps without welding together roads that really are apart.
EXPECTED_COMPONENTS = 13
SNAP_M = 25.0
ROME_LONLAT = (12.4964, 41.9028)

# The first version used 2 km pieces, which made roads.geojson 32 MB, so I raised it to 3 km (25 MB).
# GeoJSON costs about 130 bytes per feature before any coordinate, so no piece length near this one
# reaches a 12 MB file. It compresses to about a quarter of that on GitHub Pages. Every figure still
# comes from exact lengths; this only sets how finely the drawing front steps along a road.
PIECE_KM = 3.0
PIECE_SIMPLIFY_M = 30.0
CHAIN_MAX_KM = 150.0
CHAIN_SIMPLIFY_M = 300.0

BOX_LONLAT = (-15.0, 18.0, 48.0, 60.0)  # west, south, east, north
BOX_PAD_DEG = 4.0
DISPLAY_SIMPLIFY_M = 500.0
RIPPLES = [(8, 0.7), (16, 0.5), (26, 0.3), (40, 0.15)]  # km out to sea, line opacity
GRATICULE_STEP_DEG = 5
GRATICULE_SAMPLE_DEG = 1

# The roads become vector tiles in one PMTiles archive. As GeoJSON they were 28 MB, which every
# visitor had to download in full before the first road appeared; as tiles the browser fetches
# only the part on screen. z2 to z8 covers every view (MapLibre stretches z8 for closer zooms).
ROADS_PMTILES = "roads.pmtiles"
# The plate's own layers (land, coast, water lines, lakes, rivers) go into a second archive for the
# same reason: MapLibre had to read and index all of them before it could draw the first frame.
PLATE_PMTILES = "plate.pmtiles"
PLATE_LAYERS = ["land", "coast", "coast_ripples", "lakes", "rivers"]
TILE_ZOOMS = range(2, 9)
TILE_EXTENT = 4096
TILE_PX = 512
TILE_BUFFER_PX = 8
TILE_TOLERANCE_PX = 0.4
MERCATOR_HALF_WORLD_M = 20037508.342789244
TO_MERCATOR = Transformer.from_crs(GEO_CRS, "EPSG:3857", always_xy=True)
# Far out, a road piece of 3 km is a fraction of a pixel. There I join the pieces of a road into
# chunks about this many pixels long, each appearing when its nearest part does, so a low-zoom tile
# carries a few thousand lines instead of a hundred thousand. Up close every 3 km piece stays.
CHUNK_PX = 4
# Named stops on the timeline band: each lies on the road network, at the network distance of the
# road piece passing closest to it. A place more than this from any road would be a typing error.
EVENT_PLACES = [
    ("Brundisium", 17.94, 40.64),
    ("Londinium", -0.09, 51.51),
    ("Hadrian's Wall", -2.3, 55.0),
    ("Alexandria", 29.92, 31.2),
]
EVENT_MAX_SNAP_KM = 5.0

TYPE_CODE = {"Main Road": 1, "Secondary Road": 2}
CERTAINTY_CODE = {"Certain": 1, "Conjectured": 2, "Hypothetical": 3}
PLACES = [
    {"name": "ROMA", "lon": 12.4964, "lat": 41.9028},
    {"name": "HADRIAN'S WALL", "lon": -2.3, "lat": 55.0},
    {"name": "NILE", "lon": 31.0, "lat": 27.0},
    {"name": "BRITANNIA", "lon": -2.0, "lat": 53.0},
    {"name": "AEGYPTUS", "lon": 30.5, "lat": 26.0},
]
LABELLED_SEGMENT = "Rome-Ostia"
EXPECTED_DISPLAY = {
    "total_road_km": "299,171 km",
    "times_around_earth": "7.5 times around the Earth",
}

GEOD = Geod(ellps="WGS84")
TO_METRIC = Transformer.from_crs(GEO_CRS, METRIC_CRS, always_xy=True)
TO_GEO = Transformer.from_crs(METRIC_CRS, GEO_CRS, always_xy=True)


def load_key_figures() -> dict[str, dict]:
    """Read the figures and stop if one no longer says what the map is meant to show."""
    if not KEY_FIGURES_IN.exists():
        raise FileNotFoundError(f"{KEY_FIGURES_IN} is missing: run uv run data/key_figures.py")
    figures = {f["id"]: f for f in json.loads(KEY_FIGURES_IN.read_text(encoding="utf-8"))}
    for figure_id, display in EXPECTED_DISPLAY.items():
        if figures[figure_id]["display"] != display:
            raise ValueError(f"{figure_id} displays {figures[figure_id]['display']!r}")
    return figures


def load_roads() -> gpd.GeoDataFrame:
    """Read the roads into lon/lat, with the height dropped and every line a single part."""
    if not ROADS_GPKG.exists():
        raise FileNotFoundError(f"{ROADS_GPKG} is missing: run uv run data/download.py")
    roads = gpd.read_file(ROADS_GPKG)
    if roads.crs != FILE_CRS or len(roads) != EXPECTED_SEGMENTS:
        raise ValueError(f"unexpected roads file: {roads.crs}, {len(roads)} segments")
    parts = roads.geometry.apply(lambda geom: len(geom.geoms))
    if (parts != 1).any():
        raise ValueError("I expect every MultiLineString to hold exactly one line")
    roads = roads.to_crs(GEO_CRS)
    roads["line"] = roads.geometry.force_2d().apply(lambda geom: geom.geoms[0])
    if not roads["Type"].isin(TYPE_CODE).all() or not roads["Segment_s"].isin(CERTAINTY_CODE).all():
        raise ValueError("a road has a Type or Segment_s value I do not know")
    return roads


def measure_lines(lines: list[LineString]) -> list[tuple[np.ndarray, np.ndarray]]:
    """Return, per line, the azimuth and geodesic metres of every vertex-to-vertex step.

    The file is in Mercator, which stretches lengths by 1 / cos(latitude): about +34% across this
    empire and more in Britain. So I never measure a road in map units. pyproj.Geod solves the
    shortest path on the WGS84 ellipsoid for each step, which is the length on the real Earth.
    """
    steps = []
    for line in lines:
        lon, lat = np.asarray(line.coords).T[:2]
        azimuth_deg, _, step_m = GEOD.inv(lon[:-1], lat[:-1], lon[1:], lat[1:])
        steps.append((np.atleast_1d(azimuth_deg), np.atleast_1d(step_m)))
    return steps


def snap_endpoints(lines: list[LineString]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Give every segment end a node id, merging ends that lie within SNAP_M of each other.

    Digitised segments rarely share an exact coordinate where they meet, so a graph built from raw
    coordinates would fall apart at every junction. I project the ends to metres, find all pairs
    within 25 m, and treat each connected group of pairs as one node.

    Returns the start node of each line, the end node of each line, and node lon/lat.
    """
    ends_lonlat = np.array([[line.coords[0][:2], line.coords[-1][:2]] for line in lines]).reshape(
        -1, 2
    )
    x_m, y_m = TO_METRIC.transform(ends_lonlat[:, 0], ends_lonlat[:, 1])
    points = shapely.points(x_m, y_m)
    tree = shapely.STRtree(points)
    left, right = tree.query(points, predicate="dwithin", distance=SNAP_M)

    groups = nx.Graph()
    groups.add_nodes_from(range(len(points)))
    groups.add_edges_from(zip(left.tolist(), right.tolist()))
    node_of_end = np.zeros(len(points), dtype=int)
    node_lonlat = []
    for node_id, members in enumerate(nx.connected_components(groups)):
        members = sorted(members)
        node_of_end[members] = node_id
        node_lonlat.append(ends_lonlat[members].mean(axis=0))
    return node_of_end[0::2], node_of_end[1::2], np.array(node_lonlat)


def build_graph(
    start_node: np.ndarray, end_node: np.ndarray, length_km: np.ndarray, node_lonlat: np.ndarray
) -> tuple[nx.Graph, int]:
    """Build the road graph, tie every island to Rome's component, and return it with Rome's node.

    Romans crossed the Channel and the Mediterranean by ship, and the road data has no sea routes.
    Without an edge across the water, Britain would never be reached from Rome. So I add one
    straight "sea crossing" per detached component, between its closest pair of nodes and Rome's
    component, weighted by great-circle km. This is a display assumption for the drawing animation
    only: it is in no figure and is never drawn as a road.
    """
    graph = nx.Graph()
    graph.add_nodes_from(range(len(node_lonlat)))
    for u, v, km in zip(start_node.tolist(), end_node.tolist(), length_km.tolist()):
        # Two roads can join the same pair of nodes. Dijkstra only cares about the shorter one.
        if not graph.has_edge(u, v) or graph[u][v]["km"] > km:
            graph.add_edge(u, v, km=km)

    x_m, y_m = TO_METRIC.transform(node_lonlat[:, 0], node_lonlat[:, 1])
    node_points = shapely.points(x_m, y_m)
    _, _, to_rome_m = GEOD.inv(
        node_lonlat[:, 0],
        node_lonlat[:, 1],
        np.full(len(node_lonlat), ROME_LONLAT[0]),
        np.full(len(node_lonlat), ROME_LONLAT[1]),
    )
    rome_node = int(np.argmin(to_rome_m))
    print(f"  node nearest Rome is {to_rome_m[rome_node] / 1000:.2f} km from the Forum")

    # Components of the road network itself; isolated nodes do not occur because every node is the
    # end of at least one segment.
    components = [sorted(c) for c in nx.connected_components(graph)]
    print(f"  {len(components)} connected components before the sea crossings")
    if len(components) != EXPECTED_COMPONENTS:
        raise ValueError(f"expected {EXPECTED_COMPONENTS} components, got {len(components)}")

    home = next(c for c in components if rome_node in c)
    home_ids = np.array(home)
    tree = shapely.STRtree(node_points[home_ids])
    for component in components:
        if rome_node in component:
            continue
        ids = np.array(component)
        (near_idx, home_idx), gap_m = tree.query_nearest(
            node_points[ids], all_matches=False, return_distance=True
        )
        best = int(np.argmin(gap_m))
        a, b = int(ids[near_idx[best]]), int(home_ids[home_idx[best]])
        _, _, crossing_m = GEOD.inv(*node_lonlat[a], *node_lonlat[b])
        graph.add_edge(a, b, km=crossing_m / 1000)
        print(f"  sea crossing of {crossing_m / 1000:7.1f} km for {len(ids):5d} nodes")
    return graph, rome_node


def split_line(
    line: LineString, azimuth_deg: np.ndarray, step_m: np.ndarray, n_pieces: int
) -> list[np.ndarray]:
    """Cut a line into n_pieces of equal geodesic length, keeping its original vertices."""
    coords = np.asarray(line.coords)[:, :2]
    along_m = np.concatenate([[0.0], np.cumsum(step_m)])
    cuts_m = along_m[-1] * np.arange(n_pieces + 1) / n_pieces
    pieces = []
    previous_cut = coords[0]
    for k in range(n_pieces):
        if k == n_pieces - 1:
            next_cut = coords[-1]
        else:
            # Walk along the geodesic of the step the cut falls in, so the cut lies on the line.
            step = min(
                int(np.searchsorted(along_m, cuts_m[k + 1], side="right")) - 1, len(step_m) - 1
            )
            lon, lat, _ = GEOD.fwd(
                coords[step, 0], coords[step, 1], azimuth_deg[step], cuts_m[k + 1] - along_m[step]
            )
            next_cut = np.array([lon, lat])
        inside = (along_m > cuts_m[k]) & (along_m < cuts_m[k + 1])
        pieces.append(np.vstack([previous_cut, coords[inside], next_cut]))
        previous_cut = next_cut
    return pieces


def simplify_lonlat(lines: list[np.ndarray], tolerance_m: float, decimals: int) -> list[list]:
    """Douglas-Peucker in metres for display, returned as rounded lon/lat lists.

    A tolerance has to be a distance, so I simplify in the metric CRS and only then go back to
    degrees. Nothing measured later uses this geometry: it only has to look right on screen.
    """
    geometries = [LineString(line) for line in lines]
    projected = shapely.transform(
        np.array(geometries, dtype=object), lambda xy: np.column_stack(TO_METRIC.transform(*xy.T))
    )
    simple = shapely.simplify(projected, tolerance_m, preserve_topology=False)
    back = shapely.transform(simple, lambda xy: np.column_stack(TO_GEO.transform(*xy.T)))
    output = []
    for geometry, original in zip(back, lines):
        rounded = np.round(shapely.get_coordinates(geometry), decimals)
        if len(rounded) < 2:
            rounded = np.round(original[[0, -1]], decimals)
        output.append(rounded.tolist())
    return output


def build_pieces(
    roads: gpd.GeoDataFrame,
    steps: list[tuple[np.ndarray, np.ndarray]],
    length_km: np.ndarray,
    start_node: np.ndarray,
    end_node: np.ndarray,
    from_rome_km: dict[int, float],
) -> tuple[list[dict], np.ndarray, np.ndarray]:
    """Cut every segment into pieces that each know their distance from Rome.

    The road front can reach a segment from either end, so a piece's distance is the smaller of
    the two ways round. That makes two fronts meet in the middle of a road, as they should.
    Returns the GeoJSON features, plus each piece's distance and exact length for the draw curve.
    """
    pieces_coords: list[np.ndarray] = []
    properties: list[dict] = []
    exact_km: list[float] = []
    for s, (line, kind, certainty) in enumerate(
        zip(roads["line"], roads["Type"], roads["Segment_s"])
    ):
        n_pieces = max(1, math.ceil(length_km[s] / PIECE_KM))
        piece_km = length_km[s] / n_pieces
        from_start = from_rome_km[int(start_node[s])]
        from_end = from_rome_km[int(end_node[s])]
        azimuth_deg, step_m = steps[s]
        for k, coords in enumerate(split_line(line, azimuth_deg, step_m, n_pieces)):
            near_start_km = from_start + k * piece_km
            near_end_km = from_end + (n_pieces - k - 1) * piece_km
            properties.append(
                {
                    "d": round(min(near_start_km, near_end_km), 1),
                    "s": s,
                    "t": TYPE_CODE[kind],
                    "c": CERTAINTY_CODE[certainty],
                }
            )
            pieces_coords.append(coords)
            exact_km.append(piece_km)
    simple = simplify_lonlat(pieces_coords, PIECE_SIMPLIFY_M, 5)
    features = [
        {"type": "Feature", "properties": p, "geometry": {"type": "LineString", "coordinates": c}}
        for p, c in zip(properties, simple)
    ]
    return features, np.array([p["d"] for p in properties]), np.array(exact_km)


def walk_path(
    graph: nx.MultiGraph,
    start_node: np.ndarray,
    end_node: np.ndarray,
    used: set[int],
    node: int,
    first: int,
) -> list[tuple[int, bool]]:
    """Follow segments from `node`, stopping at any junction or dead end.

    Each step records the segment and whether I travel it in its own direction, so the chain's
    coordinates can be laid end to end in order.
    """
    path = []
    segment = first
    while True:
        used.add(segment)
        forward = int(start_node[segment]) == node
        path.append((segment, forward))
        node = int(end_node[segment]) if forward else int(start_node[segment])
        if graph.degree(node) != 2:
            return path
        onward = [key for _, _, key in graph.edges(node, keys=True) if key not in used]
        if not onward:
            return path
        segment = onward[0]


def find_paths(
    members: list[int], start_node: np.ndarray, end_node: np.ndarray
) -> list[list[tuple[int, bool]]]:
    """Split one class of road into unbranched paths, starting from junctions and dead ends."""
    graph = nx.MultiGraph()
    for s in members:
        graph.add_edge(int(start_node[s]), int(end_node[s]), key=s)
    used: set[int] = set()
    paths = []
    # Junctions and dead ends first; whatever is left after them can only be a closed loop.
    seeds = [n for n in graph.nodes if graph.degree(n) != 2] + list(graph.nodes)
    for node in seeds:
        for _, _, key in list(graph.edges(node, keys=True)):
            if key not in used:
                paths.append(walk_path(graph, start_node, end_node, used, node, key))
    return paths


def cut_path(path: list[tuple[int, bool]], length_km: np.ndarray) -> list[list[tuple[int, bool]]]:
    """Cut one path into chains of at most CHAIN_MAX_KM, at segment boundaries."""
    chains: list[list[tuple[int, bool]]] = [[]]
    chain_km = 0.0
    for s, forward in path:
        if chains[-1] and chain_km + length_km[s] > CHAIN_MAX_KM:
            chains.append([])
            chain_km = 0.0
        chains[-1].append((s, forward))
        chain_km += length_km[s]
    return chains


def build_certainty_chains(
    roads: gpd.GeoDataFrame,
    length_km: np.ndarray,
    start_node: np.ndarray,
    end_node: np.ndarray,
    from_rome_km: dict[int, float],
) -> list[dict]:
    """Join segments of the same type and certainty into long lines for the dashed layers.

    A renderer restarts a dash pattern at the start of every feature. At the full plate a 3 km
    piece is under one pixel, far shorter than one dash, so every piece would show only the start
    of its first dash and a dashed road would look solid. To make the pattern show I follow the
    road through plain two-road nodes and write chains of up to CHAIN_MAX_KM. Each chain's `d` is
    its nearest point to Rome, so a chain is always on screen by the time any piece of it is.
    """
    lines: list[np.ndarray] = []
    properties: list[dict] = []
    classes = roads.groupby(["Type", "Segment_s"], sort=True).indices
    for (kind, certainty), members in classes.items():
        for path in find_paths(members.tolist(), start_node, end_node):
            for chain in cut_path(path, length_km):
                coords = [np.asarray(roads["line"].iloc[s].coords)[:, :2] for s, _ in chain]
                lines.append(
                    np.vstack([c if fwd else c[::-1] for c, (_, fwd) in zip(coords, chain)])
                )
                nearest_km = min(
                    min(from_rome_km[int(start_node[s])], from_rome_km[int(end_node[s])])
                    for s, _ in chain
                )
                properties.append(
                    {
                        "d": round(nearest_km, 1),
                        "t": TYPE_CODE[kind],
                        "c": CERTAINTY_CODE[certainty],
                    }
                )
    simple = simplify_lonlat(lines, CHAIN_SIMPLIFY_M, 5)
    return [
        {"type": "Feature", "properties": p, "geometry": {"type": "LineString", "coordinates": c}}
        for p, c in zip(properties, simple)
    ]


def write_json(path: Path, payload: object) -> None:
    """Write compact JSON: no spaces, because these files travel over the wire."""
    path.write_text(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8"
    )


def network_from_rome(roads: gpd.GeoDataFrame) -> tuple:
    """Measure the roads, join them into one network and find every node's distance from Rome.

    data/key_figures.py calls this too, so the farthest distance in key_figures.json and the end
    of the map's timeline come from the same code and can never drift apart.
    Returns (steps, length_km, start_node, end_node, from_rome_km, graph).
    """
    lines = roads["line"].tolist()
    steps = measure_lines(lines)
    length_km = np.array([step_m.sum() for _, step_m in steps]) / 1000
    start_node, end_node, node_lonlat = snap_endpoints(lines)
    graph, rome_node = build_graph(start_node, end_node, length_km, node_lonlat)
    # Dijkstra spreads outward from one node along the cheapest edges, like the drawing should.
    from_rome_km = nx.single_source_dijkstra_path_length(graph, rome_node, weight="km")
    if len(from_rome_km) != graph.number_of_nodes():
        raise ValueError("some nodes cannot be reached from Rome")
    return steps, length_km, start_node, end_node, from_rome_km, graph


def farthest_draw_km(piece_d_km: np.ndarray) -> int:
    """The last whole km of the draw: the farthest road piece's network distance, rounded up."""
    return math.ceil(piece_d_km.max())


def write_draw_curve(piece_d_km: np.ndarray, piece_km: np.ndarray, total_km: float) -> int:
    """Write km of road drawn for every whole draw_km, and check it ends on the published total."""
    max_draw_km = farthest_draw_km(piece_d_km)
    # A piece appears once draw_km reaches its d, so it belongs to the first whole km >= d.
    bins = np.ceil(piece_d_km).astype(int)
    drawn_km = np.cumsum(np.bincount(bins, weights=piece_km, minlength=max_draw_km + 1))
    if f"{round(drawn_km[-1]):,} km" != EXPECTED_DISPLAY["total_road_km"]:
        raise ValueError(f"the draw curve ends on {drawn_km[-1]:,.1f} km")
    if abs(drawn_km[-1] - total_km) > 0.5:
        raise ValueError(f"the draw curve ends on {drawn_km[-1]:.2f}, the figure is {total_km}")
    write_json(
        OUT_DIR / "draw_curve.json",
        {"max_draw_km": max_draw_km, "km": np.round(drawn_km, 1).tolist()},
    )
    print(f"  draw curve ends on {drawn_km[-1]:,.2f} km at draw_km {max_draw_km}")
    return max_draw_km


def write_segments(roads: gpd.GeoDataFrame, length_km: np.ndarray) -> None:
    """Write the fields the hover card shows, in segment order, so `s` is simply the list index."""
    records = []
    for s, row in enumerate(roads.itertuples(index=False)):
        records.append(
            {
                "Name": None if pd.isna(row.Name) else row.Name,
                "Type": row.Type,
                "Segment_s": row.Segment_s,
                "length_km": round(float(length_km[s]), 2),
                "Bibliograp": None if pd.isna(row.Bibliograp) else row.Bibliograp,
            }
        )
    write_json(OUT_DIR / "segments.json", records)


def round_to_total(parts_km: dict[str, float], total_km: int) -> dict[str, int]:
    """Round parts to whole km so they still add up to the rounded total.

    Rounding each part on its own can miss by one: the certainty classes, 8,180.7 + 268,709.5 +
    22,281.0 km, round to 8,181 + 268,710 + 22,281 = 299,172. The largest remainder method floors every part, then hands the
    missing kilometres to the parts that lost the most in flooring. Each part moves by under 1 km.
    """
    floors = {name: math.floor(km) for name, km in parts_km.items()}
    missing = total_km - sum(floors.values())
    if not 0 <= missing <= len(parts_km):
        raise ValueError(f"parts add up to {sum(parts_km.values()):,.1f} km, not {total_km:,} km")
    by_remainder = sorted(parts_km, key=lambda name: parts_km[name] - floors[name], reverse=True)
    for name in by_remainder[:missing]:
        floors[name] += 1
    return floors


def write_meta() -> None:
    """Copy each source's name and download date into meta.json, for "Data fetched" on the map.

    download.py records the day each file arrived. A reader should know how fresh the data is,
    and the date belongs to the download, so I read it from there instead of typing it.
    """
    if not SOURCES_IN.exists():
        raise FileNotFoundError(f"{SOURCES_IN} is missing: run uv run data/download.py first")
    sources = json.loads(SOURCES_IN.read_text(encoding="utf-8"))
    meta = []
    for source in sources:
        # An ISO date or nothing: a malformed date would print nonsense under the map.
        downloaded = date.fromisoformat(source["downloaded"]).isoformat()
        meta.append({"name": source["name"], "downloaded": downloaded})
    write_json(OUT_DIR / "meta.json", {"sources": meta})
    print(f"  meta.json: {len(meta)} sources, fetched {sorted({m['downloaded'] for m in meta})}")


def write_totals(roads: gpd.GeoDataFrame, length_km: np.ndarray, total_km: float) -> None:
    """Write the key's lengths per road type and per certainty, plus the network's extent.

    segments.json rounds every length to 10 m, and 14,769 small roundings add up: summed from
    there, main and secondary roads come to 299,170 km, one short of the headline. So I sum the
    unrounded lengths here. A reader will add up the key, so I also write whole-km values that
    add up to the headline (see round_to_total). The extent lets a phone fit the whole network.
    """
    rounded_total = round(total_km)
    payload = {}
    for field, key in (("Type", "type"), ("Segment_s", "certainty")):
        sums = pd.Series(length_km).groupby(roads[field].to_numpy()).sum()
        exact_km = {name: float(km) for name, km in sums.items()}
        payload[f"{key}_km"] = {name: round(km, 3) for name, km in exact_km.items()}
        payload[f"{key}_display_km"] = round_to_total(exact_km, rounded_total)
    west, south, east, north = shapely.total_bounds(np.array(roads["line"].tolist()))
    payload["network_bounds_lonlat"] = [round(float(v), 3) for v in (west, south, east, north)]
    write_json(OUT_DIR / "totals.json", payload)
    print(f"  key totals: {payload['type_display_km']} {payload['certainty_display_km']}")


def clip_to_box(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Clip to the plate's box so nothing travels to the browser that the plate never shows."""
    return gdf.clip(box(*BOX_LONLAT), keep_geom_type=True)


def to_feature_collection(geoms: list, properties: list[dict], decimals: int) -> dict:
    """Build a compact FeatureCollection, rounding coordinates to what the eye can resolve."""
    features = []
    for geom, props in zip(geoms, properties):
        rounded = shapely.set_precision(geom, 10.0**-decimals, mode="valid_output")
        if rounded.is_empty:
            continue
        features.append({"type": "Feature", "properties": props, "geometry": mapping(rounded)})
    return {"type": "FeatureCollection", "features": features}


def write_land_and_ripples() -> None:
    """Write the land and the engraved water lines that ripple out from the coast.

    Old plates shade the sea by repeating the coastline in fading rings. I get the same thing by
    buffering the land seaward. The buffer needs metres, so I do it in EPSG:3034, on land clipped
    to a box wider than the plate so the clip edge does not draw a false coast.
    """
    west, south, east, north = BOX_LONLAT
    pad = box(west - BOX_PAD_DEG, south - BOX_PAD_DEG, east + BOX_PAD_DEG, north + BOX_PAD_DEG)
    land = gpd.read_file(LAND_SHP).clip(pad, keep_geom_type=True).to_crs(METRIC_CRS)
    land = shapely.make_valid(land.geometry.simplify(DISPLAY_SIMPLIFY_M).union_all())

    land_geo = gpd.GeoDataFrame(geometry=[land], crs=METRIC_CRS).to_crs(GEO_CRS)
    land_geo = clip_to_box(land_geo)
    write_json(
        OUT_DIR / "land.geojson", to_feature_collection(list(land_geo.geometry), [{}], decimals=4)
    )

    # The coast itself, taken from the wider land so the plate's clip edge is not drawn as a shore.
    coast_geo = gpd.GeoDataFrame(geometry=[land.boundary], crs=METRIC_CRS).to_crs(GEO_CRS)
    coast_geo = clip_to_box(coast_geo)
    write_json(
        OUT_DIR / "coast.geojson", to_feature_collection(list(coast_geo.geometry), [{}], decimals=4)
    )

    rings, properties = [], []
    for distance_km, opacity in RIPPLES:
        ring = land.buffer(distance_km * 1000, quad_segs=3).simplify(DISPLAY_SIMPLIFY_M).boundary
        rings.append(ring)
        properties.append({"o": opacity, "km": distance_km})
    rings_geo = gpd.GeoDataFrame(properties, geometry=rings, crs=METRIC_CRS).to_crs(GEO_CRS)
    rings_geo = clip_to_box(rings_geo)
    write_json(
        OUT_DIR / "coast_ripples.geojson",
        to_feature_collection(
            list(rings_geo.geometry),
            [{"o": o} for o in rings_geo["o"]],
            decimals=4,
        ),
    )


def write_lakes_and_rivers() -> None:
    """Write lakes and rivers, without the reservoirs that no Roman ever saw.

    Natural Earth maps today's water, so its lake layer includes Lake Nasser, the Ataturk dam and
    the Volga reservoirs. On a plate of the ancient world these are modern intrusions, like a
    border or a city would be, so I keep only natural lakes.
    """
    lakes = gpd.read_file(LAKES_SHP)
    lakes = lakes[lakes["featurecla"] != "Reservoir"]
    lakes = clip_to_box(lakes).to_crs(METRIC_CRS)
    lakes = gpd.GeoDataFrame(
        geometry=lakes.geometry.simplify(DISPLAY_SIMPLIFY_M).make_valid(), crs=METRIC_CRS
    ).to_crs(GEO_CRS)
    lakes = lakes[~lakes.is_empty]
    write_json(
        OUT_DIR / "lakes.geojson",
        to_feature_collection(list(lakes.geometry), [{}] * len(lakes), decimals=4),
    )

    rivers = clip_to_box(gpd.read_file(RIVERS_SHP)).to_crs(METRIC_CRS)
    rivers = gpd.GeoDataFrame(
        geometry=rivers.geometry.simplify(DISPLAY_SIMPLIFY_M), crs=METRIC_CRS
    ).to_crs(GEO_CRS)
    rivers = rivers[~rivers.is_empty]
    write_json(
        OUT_DIR / "rivers.geojson",
        to_feature_collection(list(rivers.geometry), [{}] * len(rivers), decimals=4),
    )


def write_graticule() -> None:
    """Write 5-degree lines, sampled every degree so they curve properly on the globe."""
    west, south, east, north = BOX_LONLAT
    step = GRATICULE_STEP_DEG
    samples_lat = np.arange(south, north + 0.1, GRATICULE_SAMPLE_DEG)
    samples_lon = np.arange(west, east + 0.1, GRATICULE_SAMPLE_DEG)
    features = []
    for lon in range(math.ceil(west / step) * step, int(east) + 1, step):
        coords = [[lon, float(lat)] for lat in samples_lat]
        features.append(_graticule_feature("meridian", lon, coords))
    for lat in range(math.ceil(south / step) * step, int(north) + 1, step):
        coords = [[float(lon), lat] for lon in samples_lon]
        features.append(_graticule_feature("parallel", lat, coords))
    write_json(OUT_DIR / "graticule.geojson", {"type": "FeatureCollection", "features": features})


def _graticule_feature(kind: str, value: int, coords: list[list[float]]) -> dict:
    """One graticule line, carrying its degree so the map can label the plate border from it."""
    return {
        "type": "Feature",
        "properties": {"kind": kind, "deg": value},
        "geometry": {"type": "LineString", "coordinates": coords},
    }


def write_places(roads: gpd.GeoDataFrame, length_km: np.ndarray) -> None:
    """Write label anchors, and a point halfway along the longest Rome-Ostia segment."""
    matches = np.flatnonzero(roads["Name"].to_numpy() == LABELLED_SEGMENT)
    if len(matches) == 0:
        raise ValueError(f"no segment is named {LABELLED_SEGMENT}")
    s = int(matches[np.argmax(length_km[matches])])
    midpoint: Point = roads["line"].iloc[s].interpolate(0.5, normalized=True)
    payload = {
        "labels": PLACES,
        "segment_label": {"s": s, "lon": round(midpoint.x, 5), "lat": round(midpoint.y, 5)},
    }
    write_json(OUT_DIR / "places.json", payload)


def metres_per_pixel(zoom: int) -> float:
    return 2 * MERCATOR_HALF_WORLD_M / (TILE_PX * 2**zoom)


def tile_range(bounds_m: tuple[float, float, float, float], zoom: int) -> tuple[range, range]:
    """The tile columns and rows a box in Web Mercator metres touches at one zoom."""
    west, south, east, north = bounds_m
    size_m = 2 * MERCATOR_HALF_WORLD_M / 2**zoom
    x0 = int((west + MERCATOR_HALF_WORLD_M) // size_m)
    x1 = int((east + MERCATOR_HALF_WORLD_M) // size_m)
    y0 = int((MERCATOR_HALF_WORLD_M - north) // size_m)
    y1 = int((MERCATOR_HALF_WORLD_M - south) // size_m)
    return range(x0, x1 + 1), range(y0, y1 + 1)


def tile_bounds_m(x: int, y: int, zoom: int) -> tuple[float, float, float, float]:
    size_m = 2 * MERCATOR_HALF_WORLD_M / 2**zoom
    west = -MERCATOR_HALF_WORLD_M + x * size_m
    north = MERCATOR_HALF_WORLD_M - y * size_m
    return west, north - size_m, west + size_m, north


def to_mercator(coordinates: list) -> LineString:
    x, y = TO_MERCATOR.transform(*np.asarray(coordinates, dtype=float).T)
    return LineString(np.column_stack([x, y]))


def chunk_pieces(features: list[dict], piece_km: np.ndarray, chunk_km: float) -> list[dict]:
    """Join consecutive pieces of the same road into chunks of about chunk_km.

    A chunk takes the smallest distance of its pieces, so it appears when its nearest part does;
    the draw then steps in chunks of a few pixels, which nobody can see at that zoom.
    """
    out, current, length = [], None, 0.0
    for feature, km in zip(features, piece_km):
        props = feature["properties"]
        same_road = current is not None and current["properties"]["s"] == props["s"]
        if not same_road or length >= chunk_km:
            if current:
                out.append(current)
            current = {
                "coords": list(feature["geometry"]["coordinates"]),
                "properties": dict(props),
            }
            length = km
            continue
        current["coords"] += feature["geometry"]["coordinates"][1:]
        current["properties"]["d"] = min(current["properties"]["d"], props["d"])
        length += km
    if current:
        out.append(current)
    return [{"geometry": {"coordinates": c["coords"]}, "properties": c["properties"]} for c in out]


def encode_layer_tiles(
    name: str, lines_m: np.ndarray, properties: list[dict], zoom: int, tiles: dict
) -> None:
    """Clip lines (already simplified for this zoom) into the tiles of one zoom, as one layer."""
    tree = shapely.STRtree(lines_m)
    buffer_m = TILE_BUFFER_PX * metres_per_pixel(zoom)
    xs, ys = tile_range(tuple(shapely.total_bounds(lines_m)), zoom)
    for x in xs:
        for y in ys:
            bounds = tile_bounds_m(x, y, zoom)
            padded = (
                bounds[0] - buffer_m,
                bounds[1] - buffer_m,
                bounds[2] + buffer_m,
                bounds[3] + buffer_m,
            )
            hits = tree.query(shapely.box(*padded))
            if len(hits) == 0:
                continue
            clipped = shapely.clip_by_rect(lines_m[hits], *padded)
            features = []
            for index, geometry in zip(hits, clipped):
                # Clipping a polygon to a tile keeps it a polygon; a line stays a line. A tile
                # edge can leave stray points or slivers, which carry nothing to draw.
                kind = "Polygon" if lines_m[index].geom_type.endswith("Polygon") else "LineString"
                parts = [
                    g
                    for g in shapely.get_parts(geometry)
                    if g.geom_type == kind
                    and not g.is_empty
                    and (kind == "LineString" or g.area > 0)
                ]
                if parts:
                    if len(parts) == 1:
                        shape = parts[0]
                    elif kind == "Polygon":
                        shape = MultiPolygon(parts)
                    else:
                        shape = MultiLineString(parts)
                    features.append({"geometry": shape, "properties": properties[index]})
            if features:
                tiles.setdefault((zoom, x, y), {})[name] = (features, bounds)


def write_road_tiles(features: list[dict], piece_km: np.ndarray, chains: list[dict]) -> None:
    """Write the road pieces and the certainty chains as two layers of one PMTiles archive.

    Each piece keeps only what the map reads: d (network km from Rome, rounded up to the whole km,
    the same step the draw curve counts in), s (its segment, for the hover note), t (type) and
    c (certainty). Tiles are gzipped, as the PMTiles spec expects for vector tiles.
    """
    layers = {}
    for zoom in TILE_ZOOMS:
        tolerance_m = TILE_TOLERANCE_PX * metres_per_pixel(zoom)
        chunk_km = CHUNK_PX * metres_per_pixel(zoom) / 1000
        pieces = features if chunk_km <= PIECE_KM else chunk_pieces(features, piece_km, chunk_km)
        lines = np.array([to_mercator(p["geometry"]["coordinates"]) for p in pieces])
        props = [
            {
                "d": math.ceil(p["properties"]["d"]),
                "s": p["properties"]["s"],
                "t": p["properties"]["t"],
                "c": p["properties"]["c"],
            }
            for p in pieces
        ]
        layers.setdefault("roads", []).append((zoom, shapely.simplify(lines, tolerance_m), props))
        chain_lines = np.array([to_mercator(c["geometry"]["coordinates"]) for c in chains])
        chain_props = [
            {
                "d": math.ceil(c["properties"]["d"]),
                "t": c["properties"]["t"],
                "c": c["properties"]["c"],
            }
            for c in chains
        ]
        layers.setdefault("certainty", []).append(
            (zoom, shapely.simplify(chain_lines, tolerance_m), chain_props)
        )
    tiles: dict = {}
    for name, per_zoom in layers.items():
        for zoom, lines, props in per_zoom:
            encode_layer_tiles(name, lines, props, zoom, tiles)
    write_archive(
        ROADS_PMTILES,
        tiles,
        [
            {"id": "roads", "fields": {"d": "Number", "s": "Number", "t": "Number", "c": "Number"}},
            {"id": "certainty", "fields": {"d": "Number", "t": "Number", "c": "Number"}},
        ],
        "Itiner-e, de Soto et al. 2025 (CC BY 4.0)",
    )


def write_archive(name: str, tiles: dict, vector_layers: list[dict], attribution: str) -> None:
    """Encode the tiles as gzipped Mapbox Vector Tiles and pack them into one PMTiles archive.

    PMTiles numbers every tile along a Hilbert curve and keeps a directory from tile to byte offset
    at the front of the file. The browser reads that directory once, then any tile with one range
    request, which GitHub Pages serves like any other file.
    """
    encoded = {}
    for (zoom, x, y), named in tiles.items():
        bounds = next(iter(named.values()))[1]
        data = encode_mvt(
            [{"name": layer, "features": feats} for layer, (feats, _) in named.items()],
            default_options={"quantize_bounds": bounds, "extents": TILE_EXTENT},
        )
        encoded[(zoom, x, y)] = gzip.compress(data, mtime=0)
    west, south, east, north = BOX_LONLAT
    header = {
        "tile_type": TileType.MVT,
        "tile_compression": Compression.GZIP,
        "min_lon_e7": int((west - BOX_PAD_DEG) * 1e7),
        "min_lat_e7": int((south - BOX_PAD_DEG) * 1e7),
        "max_lon_e7": int((east + BOX_PAD_DEG) * 1e7),
        "max_lat_e7": int((north + BOX_PAD_DEG) * 1e7),
        "center_zoom": TILE_ZOOMS[0],
        "center_lon_e7": int(ROME_LONLAT[0] * 1e7),
        "center_lat_e7": int(ROME_LONLAT[1] * 1e7),
    }
    metadata = {"vector_layers": vector_layers, "attribution": attribution}
    with write_pmtiles_file(OUT_DIR / name) as writer:
        for key in sorted(encoded, key=lambda k: zxy_to_tileid(*k)):
            writer.write_tile(zxy_to_tileid(*key), encoded[key])
        writer.finalize(header, metadata)
    size_mb = (OUT_DIR / name).stat().st_size / 1e6
    print(
        f"  {name}: {len(encoded):,} tiles, z{TILE_ZOOMS[0]} to z{TILE_ZOOMS[-1]}, {size_mb:.1f} MB"
    )


def write_plate_tiles() -> None:
    """Pack the plate's GeoJSON layers into one archive, simplified per zoom, then drop the GeoJSON.

    Only the coast water lines keep a property: o, the opacity each ring fades to.
    """
    tiles: dict = {}
    fields = {}
    for name in PLATE_LAYERS:
        path = OUT_DIR / f"{name}.geojson"
        source = json.loads(path.read_text(encoding="utf-8"))
        geometries = gpd.GeoSeries(
            [shapely.geometry.shape(f["geometry"]) for f in source["features"]], crs=GEO_CRS
        ).to_crs("EPSG:3857")
        properties = [
            {k: v for k, v in f["properties"].items() if k == "o"} for f in source["features"]
        ]
        fields[name] = {"o": "Number"} if any(properties) else {}
        for zoom in TILE_ZOOMS:
            tolerance_m = TILE_TOLERANCE_PX * metres_per_pixel(zoom)
            simplified = shapely.simplify(np.array(geometries.values), tolerance_m)
            encode_layer_tiles(name, simplified, properties, zoom, tiles)
        path.unlink()
    write_archive(
        PLATE_PMTILES,
        tiles,
        [{"id": name, "fields": fields[name]} for name in PLATE_LAYERS],
        "Natural Earth",
    )


def write_events(features: list[dict], piece_d_km: np.ndarray) -> None:
    """Write the timeline's named stops and the farthest point from Rome, for the map to read.

    A stop's distance is the d of the road piece passing closest to it, so I never type a place's
    distance by hand. The farthest point is the middle of the piece with the largest d; its s names
    the road the "Show on map" button highlights.
    """
    vertices, owner = [], []
    for index, feature in enumerate(features):
        for lon, lat in feature["geometry"]["coordinates"]:
            vertices.append((lon, lat))
            owner.append(index)
    vertices = np.asarray(vertices)
    owner = np.asarray(owner)
    events = []
    for name, lon, lat in EVENT_PLACES:
        # A flat approximation is enough near one place: a degree of longitude shrinks by cos(lat).
        dx = (vertices[:, 0] - lon) * math.cos(math.radians(lat))
        dy = vertices[:, 1] - lat
        nearest = int(np.argmin(dx * dx + dy * dy))
        snap_km = math.hypot(dx[nearest], dy[nearest]) * 111.2
        if snap_km > EVENT_MAX_SNAP_KM:
            raise ValueError(f"{name} is {snap_km:.1f} km from any road")
        events.append({"name": name, "km": round(float(piece_d_km[owner[nearest]]), 1)})
    far = int(np.argmax(piece_d_km))
    coords = features[far]["geometry"]["coordinates"]
    lon, lat = coords[len(coords) // 2]
    farthest = {
        "lon": lon,
        "lat": lat,
        "s": features[far]["properties"]["s"],
        "km": float(piece_d_km[far]),
    }
    write_json(OUT_DIR / "events.json", {"events": events, "farthest": farthest})
    print(f"  events.json: {', '.join(f'{e["name"]} {e["km"]:,.0f} km' for e in events)}")


def print_sizes() -> None:
    """Print what the browser has to download."""
    total_mb = 0.0
    for path in sorted(OUT_DIR.iterdir()):
        size_mb = path.stat().st_size / 1e6
        total_mb += size_mb
        print(f"  {path.name:26s} {size_mb:7.2f} MB")
    print(f"  {'total':26s} {total_mb:7.2f} MB")


def main() -> None:
    figures = load_key_figures()
    OUT_DIR.mkdir(exist_ok=True)

    print("Reading the roads and building the network")
    roads = load_roads()
    steps, length_km, start_node, end_node, from_rome_km, graph = network_from_rome(roads)
    print(f"  {len(roads):,} segments, {length_km.sum():,.1f} km on the WGS84 ellipsoid")
    print(f"  {graph.number_of_nodes():,} nodes, {graph.number_of_edges():,} edges")
    print(f"  farthest node is {max(from_rome_km.values()):,.0f} km from Rome by network")

    print(f"Cutting the roads into pieces of at most {PIECE_KM:g} km")
    features, piece_d_km, piece_km = build_pieces(
        roads, steps, length_km, start_node, end_node, from_rome_km
    )
    print(f"  {len(features):,} pieces")
    chains = build_certainty_chains(roads, length_km, start_node, end_node, from_rome_km)
    print(f"  {len(chains):,} long lines for the certainty patterns")
    print("Cutting the roads into vector tiles")
    write_road_tiles(features, piece_km, chains)
    write_events(features, piece_d_km)
    # The GeoJSON versions of these two layers are gone: the tiles replace them.
    for old in ("roads.geojson", "roads_certainty.geojson"):
        (OUT_DIR / old).unlink(missing_ok=True)

    write_segments(roads, length_km)
    write_totals(roads, length_km, figures["total_road_km"]["value"])
    write_meta()
    max_draw_km = write_draw_curve(piece_d_km, piece_km, figures["total_road_km"]["value"])
    # The In numbers line reads key_figures.json, the timeline reads draw_curve.json: same number.
    if figures["farthest_km"]["value"] != max_draw_km:
        raise ValueError(
            f"farthest_km is {figures['farthest_km']['value']}, the draw ends {max_draw_km}"
        )

    print("Building the plate")
    write_land_and_ripples()
    write_lakes_and_rivers()
    write_plate_tiles()
    write_graticule()
    write_places(roads, length_km)
    shutil.copyfile(KEY_FIGURES_IN, OUT_DIR / "key_figures.json")

    print("Sizes")
    print_sizes()


if __name__ == "__main__":
    main()
