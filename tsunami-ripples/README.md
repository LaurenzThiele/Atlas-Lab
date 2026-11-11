# Every tsunami on record

29,340 tsunami records since the year 684, sized by wave height.

![The globe centred on the Pacific, with every tsunami record as rings of light along the coasts, and the sheet with the layers, the numbers and the sources](docs/snapshot.png)

**[Open the live map](https://laurenzthiele.github.io/Atlas-Lab/tsunami-ripples/)**

1,124 tsunamis left 29,340 records on the coasts, and most of them sit around one ocean: the
Pacific, where the Ring of Fire draws itself. Each record is one place where NOAA measured or saw
the water come ashore, drawn as three rings whose area grows with the water height, on an indigo
globe with a 15-degree graticule and a flat tint of the land. You can play the timeline from 684
to 2026, tap a ring for its place, date, water height, deaths and the NCEI event, hide the small
waves with a minimum height, and switch the rings to 3D columns.

## Key figures

All figures come from the NOAA NCEI Global Historical Tsunami Database
([doi:10.7289/V5PN93H7](https://doi.org/10.7289/V5PN93H7)). I count only records rated definite or
probable (validity 3 or 4) with coordinates and a water height above 0 m.

- **29,340 rings**: the records kept by that rule.
- **1,124 tsunamis**: the distinct tsunami events among them.
- **684 to 2026**: the earliest and latest year. The first is Atashika, Japan, 3 m.
- **84% of the rings are in the Pacific**: records in NCEI regions 80 to 89 (83.5%).
- **Japan: 40% of all rings**: no country has more.
- **75% of tsunamis hit the Pacific**: tsunamis whose record nearest the source is in regions 80
  to 89 (74.7%).
- **21% of tsunamis hit Japan**: tsunamis whose record nearest the source is in Japan (20.6%).
- **524 m, Lituya Bay, Alaska, 1958**: the highest water. It was a landslide wave inside a fjord,
  not an ocean tsunami.
- **227,899 deaths, Indian Ocean, 2004**: the deadliest event, its toll copied from the deaths
  column of [NCEI event 2439](https://www.ngdc.noaa.gov/hazel/hazard-service/api/v1/tsunamis/events/2439).

Japan holds 40% of the records but only about a fifth of the tsunamis, because its dense network of
tide gauges logs thousands of places for one big tsunami.

To check my numbers against published ones:

- Figure cited from [NOAA JetStream: Tsunami locations](https://www.noaa.gov/jetstream/tsunamis/tsunami-locations):
  78% of tsunamis in the Pacific and 20% in Japan (mine: 75% and 21%, from this snapshot and my
  nearest-to-source rule).
- Figure cited from [Lituya Bay’s Apocalyptic Wave - NASA Science](https://science.nasa.gov/earth/earth-observatory/lituya-bays-apocalyptic-wave-147557/):
  524 m.

## How I made it

### 1. The data

`data/download.py` takes a snapshot of a live database. The NCEI runup search builds its export in
the browser from a public JSON API that serves 200 rows per page. I call the same API page by page
and join the pages into one file. NCEI adds runups after every tsunami, so the script writes the
download date, the size and the SHA-256 of every file to `data/raw/sources.json`: together they
say exactly which version of the database my numbers come from.

```python
def fetch_all_pages(session: requests.Session, url: str) -> list[dict]:
    """Walk the API page by page. The first page tells me how many pages and rows there are."""
    first = get_json(session, url, {"page": 1, "itemsPerPage": ITEMS_PER_PAGE})
    total_pages, total_items = first["totalPages"], first["totalItems"]
    items = list(first["items"])
    for page in range(2, total_pages + 1):
        if page % 25 == 0:
            print(f"       page {page}/{total_pages}")
        items.extend(
            get_json(session, url, {"page": page, "itemsPerPage": ITEMS_PER_PAGE})["items"]
        )
    # If a row was added or removed while I was paging, the count no longer matches.
    if len(items) != total_items:
        raise ValueError(f"got {len(items)} rows, the API says {total_items}: run again")
    return items
```

[data/download.py lines 132 to 146](https://github.com/LaurenzThiele/Atlas-Lab/blob/main/tsunami-ripples/data/download.py#L132-L146)

### 2. Filter it

NCEI rates every event from -1 (erroneous) to 4 (definite). I keep only 3 (probable) and 4. That
one constant matters more than any other line in the project: without it the deadliest tsunami on
record would be the 1737 Calcutta disaster with 300,000 deaths, which NCEI itself rates erroneous,
because it was a cyclone storm surge.

```python
MIN_VALIDITY = 3
```

[data/key_figures.py line 35](https://github.com/LaurenzThiele/Atlas-Lab/blob/main/tsunami-ripples/data/key_figures.py#L35)

The filter then keeps only runups I can draw: a place and a measured height above 0 m.

```python
    valid = runups[runups["sourceEventValidity"] >= MIN_VALIDITY].copy()
    # A ring needs a place and a size. About 1 in 7 runups is only a written report ("the sea
    # flooded the town") with no measured height, and a few have no coordinates. A height of 0
    # means the wave was noticed but not measurable, which would draw an invisible ring.
    has_place = valid["latitude"].notna() & valid["longitude"].notna()
    has_height = valid["runupHt"] > 0
    rings = valid[has_place & has_height].rename(columns={"runupHt": "runup_m"})
```

[data/key_figures.py lines 66 to 72](https://github.com/LaurenzThiele/Atlas-Lab/blob/main/tsunami-ripples/data/key_figures.py#L66-L72)

A runup is one place with one water height; a tsunami is one event that can leave thousands of
runups. I keep the two apart in every figure. To give a tsunami a region, I use its runup nearest
the source, because the runup table has no location for the source itself.

### 3. Make it glow

Every ring adds its light to what is already on the canvas. A lone ring on the open ocean stays
faint, and a coast hit a thousand times shines, so the density of the record becomes brightness
without any extra computation.

```js
const ADDITIVE = {
  blend: true,
  blendColorOperation: "add",
  blendColorSrcFactor: "src-alpha",
  blendColorDstFactor: "one",
  blendAlphaOperation: "add",
  blendAlphaSrcFactor: "zero",
  blendAlphaDstFactor: "one",
  depthWriteEnabled: false,
  depthCompare: "less-equal",
};
```

[maps/main.js lines 190 to 200](https://github.com/LaurenzThiele/Atlas-Lab/blob/main/tsunami-ripples/maps/main.js#L190-L200)

Plain additive light runs away to white on the densest coasts. One screen-covering disc drawn with
a "min" blend caps every pixel at the sea foam colour, channel by channel
([maps/main.js lines 202 to 215](https://github.com/LaurenzThiele/Atlas-Lab/blob/main/tsunami-ripples/maps/main.js#L202-L215)).

### 4. The look

Ring area, not radius, grows with water height, so the radius grows with its square root. The
524 m wave of Lituya Bay is 5,240 times the height of a 0.1 m reading, and its ring is about 72
times as wide, not 5,240 times: it reads as the giant it is without swallowing the map. This is
the formula; the rings use it for every frame and the legend calls the function itself.

```js
/** radius_px = RING_PX * sqrt(runup_m) * 2 ** (0.5 * (zoom - 1.1)). The legend uses it too. */
export function ringRadiusPx(runupM, zoom) {
  return RING_PX * Math.sqrt(runupM) * 2 ** (0.5 * (zoom - RING_REFERENCE_ZOOM));
}
```

[maps/main.js lines 152 to 155](https://github.com/LaurenzThiele/Atlas-Lab/blob/main/tsunami-ripples/maps/main.js#L152-L155)

I draw it on a deck.gl globe: it shows the whole Pacific rim as one ring, without the Mercator
break at 180 degrees that would cut the ocean in two, and the GPU draws all 29,340 rings.

### 5. Make it light

The map should load quickly on a phone. `maps/prepare.py` writes the records as columns, one plain
JSON list per field, instead of one GeoJSON feature per record, keeps only the fields the map
reads, and rounds coordinates to 4 decimals (about 11 m).

```python
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
```

[maps/prepare.py lines 119 to 140](https://github.com/LaurenzThiele/Atlas-Lab/blob/main/tsunami-ripples/maps/prepare.py#L119-L140)

Measured on 11 November 2026: the raw download in `data/raw/` is 19.6 MB, the 7 layers in
`maps/layers/` are 3.7 MB, and the start view of the built map transfers 1.1 MB in 17
requests, gzipped the way GitHub Pages serves it.

## Run it yourself

You need [uv](https://docs.astral.sh/uv/) and Node.js 20 or newer. From the repo root:

```
cd tsunami-ripples
uv sync --python 3.12
uv run data/download.py
uv run data/key_figures.py
uv run maps/prepare.py
npm install
npm run dev
npm run snapshot
```

The download is 19.6 MB: 18.0 MB from NCEI and 1.6 MB of Natural Earth land. It needs no sign-up
and no API key. `npm run dev` serves the map at the address it prints (the map is under `/maps/`).
`npm run snapshot` needs Playwright's browser once (`npx playwright install --with-deps chromium`)
and writes `docs/snapshot.png`. `npm run build` writes a static site to `maps/dist/`.

## Script your own views

`maps/main.js` exports `createMap`, which draws the globe without any of the page around it and
returns an object with four calls and a promise:

```js
import { createMap } from "./main.js";

// createMap: a globe in any element, loading the layers from maps/layers/.
const map = createMap(document.getElementById("map"), { layersUrl: "layers/" });

// ready: resolves when the layers, fonts and GPU are there.
await map.ready;

// setView: move the camera, giving only what changes. Here: Japan, tilted.
map.setView({ longitude: 138, latitude: 36, zoom: 4.2, pitch: 45, bearing: -20 });

// setLayers: what to show. Here: rings as 3D columns, 2,000 times their real height.
map.setLayers({ rings: false, columns: { exaggeration: 2000, rise: 1 } });

// setTime: a year from 684 to 2026 shows every ring up to the end of that year.
map.setTime(1958);
```

On the live map, open the browser console and use `atlasMap` the same way, for example
`atlasMap.setView({ longitude: 85, latitude: 0, zoom: 2.5 })` for the Indian Ocean.

## Data sources

| Dataset | Publisher | Licence | Credit | Link |
|---|---|---|---|---|
| Global Historical Tsunami Database: all runups (JSON API, joined pages) | NOAA National Centers for Environmental Information (NCEI) | US government work, public domain (no restrictions on use), [doi:10.7289/V5PN93H7](https://doi.org/10.7289/V5PN93H7) | NOAA National Centers for Environmental Information (NCEI), Global Historical Tsunami Database, doi:10.7289/V5PN93H7 | [API](https://www.ngdc.noaa.gov/hazel/hazard-service/api/v1/tsunamis/runups) |
| Global Historical Tsunami Database: region codes | NOAA NCEI | US government work, public domain | NOAA National Centers for Environmental Information (NCEI), Global Historical Tsunami Database, doi:10.7289/V5PN93H7 | [API](https://www.ngdc.noaa.gov/hazel/hazard-service/api/v1/descriptors/tsunami/regions) |
| Natural Earth 1:50m land (ne_50m_land) | Natural Earth (NACIS) | Public domain, [terms of use](https://www.naturalearthdata.com/about/terms-of-use/) | Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com | [Download page](https://www.naturalearthdata.com/downloads/50m-physical-vectors/50m-land/) |

The figure checks above (the NOAA JetStream page and the NASA page) are only comparisons; the map
draws nothing from them.

**The layers in this repo.** `maps/layers/` is tracked here, and the map offers the same files
under "Download the data". Each source allows it:

- NCEI runups and region codes (`rings.json`, `highlights.json`, `regions.json`,
  `ring_of_fire_order.json`, `figures.json`): allowed. A work of the US government has no
  copyright, and the NCEI metadata says "Access to this dataset is unrestricted."
- Natural Earth land (`land.json`): allowed. Natural Earth is in the public domain: "You may use
  the maps in any manner, including modifying the content and design, electronic dissemination,
  and offset printing."

The raw downloads in `data/raw/` stay out of the repo; `uv run data/download.py` fetches them again.

## Files

```
tsunami-ripples/
  README.md
  pyproject.toml, uv.lock          Python dependencies (uv)
  package.json, package-lock.json  JavaScript dependencies and the npm scripts
  vite.config.js                   build settings for the map
  data/
    download.py                    downloads the raw data into data/raw/
    key_figures.py                 computes the key figures
    key_figures.json               the key figures, written by key_figures.py
  maps/
    prepare.py                     turns data/raw/ into the layers the map loads
    index.html, ui.js, style.css   the page around the globe
    main.js                        the globe and its API
    snapshot.mjs                   writes docs/snapshot.png
    public/                        tab icons
    layers/                        the prepared layers, written by prepare.py
  docs/
    snapshot.png                   the picture at the top of this README
```

## Licence

The code is MIT licensed (see [LICENSE](../LICENSE) at the repo root). The data stays under each
source's own licence, as listed above.
