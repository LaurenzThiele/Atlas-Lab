/* The public page: the map from main.js with the title, key, figures and controls around it.

   What it does: builds the map through main.js's API and hands it to ui.js, which adds everything
   a reader clicks. With ?plate=1 in the URL it shows the plain plate instead: the map, its own
   cartouche, legend and credit, and no controls (docs/snapshot.png is taken from it).
   Reads:  maps/layers/ through main.js.
   Run:    npm run dev   (from the piece folder)

   What you learn: how a page can sit on top of a small map API. Everything here could be written
   again for another page without touching how the map itself is drawn. */

import { FULL_PLATE, createMap, layerUrl, positionDegreeLabels, positionLabel } from "./main.js";
import { PHONE_QUERY, TITLE_ROOM_PX, startUi } from "./ui.js";

// The page opens tilted over Rome, where the web of roads starts, with every road already drawn.
// The plain plate view (?plate=1) keeps the whole plate from above.
const OPENING_VIEW = { center: [12.4964, 41.9028], zoom: 7.0, pitch: 45, bearing: -15 };
// Place names stay this far inside the map edge on the public map. The plate view is left as drawn.
const LABEL_EDGE_PX = 8;

async function start() {
  const isPlate = new URLSearchParams(location.search).get("plate") === "1";
  if (isPlate) document.body.classList.add("bare");

  const stage = document.getElementById("stage");
  const startView = isPlate ? FULL_PLATE : OPENING_VIEW;
  // The page's first picture is its final one: the room for the title and the line patterns are
  // set before the map draws, so nothing changes after it is ready.
  const roomForTitle = !isPlate && !matchMedia(PHONE_QUERY).matches;
  const handle = await createMap(stage, {
    view: startView,
    padding: roomForTitle ? { left: TITLE_ROOM_PX, top: 0, right: 0, bottom: 0 } : undefined,
    roads: isPlate ? "solid" : "pattern",
  });
  const { map, data, write, roads, placeLabels, degreeLabels, paintPaper } = handle;

  const ui = startUi({
    map,
    write,
    roads,
    drawCurve: data.drawCurve,
    segments: data.segments,
    figures: data.figures,
    stage,
    startView,
    layerUrl,
  });

  // The furniture the margin figures may never cover. Only the ones on screen count.
  const furniture = ["title-block", "foot-left", "map-buttons", "top-right", "cartouche", "credit", "legend"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  const refreshLabels = () => {
    // Place names stay 8 px inside the map edge on the public map. The plate view is left as drawn.
    const hasFurniture = document.getElementById("foot-left").offsetParent !== null;
    for (const label of placeLabels.values()) {
      positionLabel(map, label, { inset: hasFurniture ? LABEL_EDGE_PX : null });
    }
    positionDegreeLabels(map, degreeLabels, 1, { obstacles: furniture });
  };
  // A drag fires many move events per screen refresh; one update per animation frame is enough.
  let pending = false;
  const refreshOnNextFrame = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      refreshLabels();
    });
  };
  map.on("move", refreshOnNextFrame);
  refreshLabels();

  // MapLibre follows its container by itself. The paper has to be painted again at the new size,
  // and folding the sheet is a good reason to do it only once the size has settled.
  let paperTimer = null;
  new ResizeObserver(() => {
    refreshOnNextFrame();
    clearTimeout(paperTimer);
    paperTimer = setTimeout(() => paintPaper(stage.clientWidth, stage.clientHeight), 150);
  }).observe(stage);

  await new Promise((resolve) => {
    map.once("idle", () => resolve());
    map.triggerRepaint();
  });
  await ui.loadEvents();
  // A plain marker on the page for any tool that waits for the finished map (a screenshot, a test).
  document.body.dataset.map = "ready";
}

start().catch((error) => {
  const box = document.createElement("div");
  box.id = "error";
  box.textContent = `The plate could not be drawn: ${error.message}`;
  document.getElementById("app").append(box);
  document.body.dataset.map = "error";
  throw error;
});
