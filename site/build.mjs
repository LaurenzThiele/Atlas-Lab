/**
 * Builds the landing page of the live maps, https://laurenzthiele.github.io/Atlas-Lab/.
 *
 * Reads:  every top-level folder of the repo that has README.md and docs/snapshot.png,
 *         the gh-pages branch (to see which maps are published), template.html and the icons here.
 * Writes: site/dist/ with index.html, the icons, og.png, fonts/ and thumbs/<piece-slug>.webp.
 * Run:    cd site && npm ci && npm run build
 *         node build.mjs --local   treats a piece as published when <piece>/maps/dist/index.html
 *                                  exists, so I can check the page before anything is public.
 *
 * I never edit the landing page by hand. A map gets a card once its folder is on gh-pages, so the
 * page cannot link to a map that is not online yet. A GitHub Action runs this on every push to main.
 *
 * The wireframe globe in the corner of the page is computed here too (globeSvg), from the same
 * graticule maths a map projection uses, so it is exact and can be re-tuned with a few numbers.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DIST = join(HERE, "dist");
const TEMPLATE = join(HERE, "template.html");
const PLACEHOLDER = "<!-- CARDS -->";
const GLOBE_PLACEHOLDER = "<!-- GLOBE -->";
const STATIC_FILES = ["favicon.svg", "favicon-32.png", "apple-touch-icon.png", "og.png"];
const STATIC_DIRS = ["fonts"];
const PAGES_BRANCH = "origin/gh-pages";
const THUMB_W_PX = 800;
const THUMB_H_PX = 500;
const THUMB_MAX_BYTES = 100 * 1024;
const THUMB_QUALITIES = [82, 76, 70, 64, 58, 52, 46, 40];
const LOCAL = process.argv.includes("--local");

// The page globe: a 1000 x 760 box in the bottom right corner, the globe's centre below the box so
// only its upper left part shows. Slate lines, the outline a little stronger than the graticule.
const PAGE_GLOBE = {
  width: 1000,
  height: 760,
  cx: 820,
  cy: 800,
  r: 640,
  tiltDeg: 22,
  rotationDeg: 18,
  meridianStepDeg: 30,
  parallelsDeg: [-60, -30, 0, 30, 60],
  outline: { width: 2, opacity: 0.4 },
  graticule: { width: 1.5, opacity: 0.28 },
};
const SLATE = "#8A94A3";
const STEP_DEG = 0.5; // sampling along each line before simplifying
const SIMPLIFY_PX = 0.25; // a curve may move at most this far when I drop points

const rad = (deg) => (deg * Math.PI) / 180;

/**
 * Orthographic projection: the globe as seen from far away. tilt turns the north pole towards the
 * viewer, rotation spins the globe about its axis. A point is on the front half when the cosine of
 * its angular distance from the view centre is not negative; I draw only those points.
 */
function projector({ cx, cy, r, tiltDeg, rotationDeg }) {
  const [phi0, lam0] = [rad(tiltDeg), rad(rotationDeg)];
  return (latDeg, lonDeg) => {
    const [phi, lam] = [rad(latDeg), rad(lonDeg) + lam0];
    const cosC = Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(lam);
    return {
      x: cx + r * Math.cos(phi) * Math.sin(lam),
      y: cy - r * (Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(lam)),
      front: cosC >= 0,
    };
  };
}

/** Ramer-Douglas-Peucker: keeps the shape of a sampled curve with far fewer points. */
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const [a, b] = [points[0], points[points.length - 1]];
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const length = Math.hypot(dx, dy) || 1;
  let [maxDist, index] = [0, 0];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const dist = Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y)) / length;
    if (dist > maxDist) [maxDist, index] = [dist, i];
  }
  if (maxDist <= tolerance) return [a, b];
  return [
    ...simplify(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...simplify(points.slice(index), tolerance),
  ];
}

/** Splits a sampled line into the runs that are on the front half and inside the box. */
function visibleRuns(points, width, height) {
  const margin = 4;
  const inside = (p) =>
    p.front && p.x > -margin && p.x < width + margin && p.y > -margin && p.y < height + margin;
  const runs = [];
  let run = [];
  for (const p of points) {
    if (inside(p)) {
      run.push(p);
    } else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs.filter((r) => r.length > 1);
}

function pathData(runs) {
  const f = (n) => n.toFixed(1).replace(/\.0$/, "");
  return runs
    .map((run) => "M" + simplify(run, SIMPLIFY_PX).map((p) => `${f(p.x)} ${f(p.y)}`).join("L"))
    .join("");
}

/**
 * The wireframe globe as an SVG string. The strokes do not scale with the box
 * (vector-effect), so the lines keep their width when CSS shrinks the globe on phones.
 */
export function globeSvg(globe, attrs = "") {
  const { width, height, cx, cy, r, meridianStepDeg, parallelsDeg, outline, graticule } = globe;
  const project = projector(globe);
  const samples = (n) => Array.from({ length: Math.round(n / STEP_DEG) + 1 }, (_, i) => i * STEP_DEG);
  const runs = [];
  for (let lon = 0; lon < 360; lon += meridianStepDeg)
    runs.push(...visibleRuns(samples(180).map((t) => project(t - 90, lon)), width, height));
  for (const lat of parallelsDeg)
    runs.push(...visibleRuns(samples(360).map((t) => project(lat, t - 180)), width, height));
  const stroke = `fill="none" stroke="${SLATE}" vector-effect="non-scaling-stroke"`;
  return (
    `<svg ${attrs} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" aria-hidden="true">` +
    `<path ${stroke} stroke-width="${graticule.width}" stroke-opacity="${graticule.opacity}" d="${pathData(runs)}"/>` +
    `<circle ${stroke} stroke-width="${outline.width}" stroke-opacity="${outline.opacity}" cx="${cx}" cy="${cy}" r="${r}"/>` +
    `</svg>`
  );
}

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/**
 * I fetch gh-pages first so the list of published maps is current. The branch may not exist yet,
 * before the first map is deployed, so a failed fetch is not an error here.
 */
function pagesBranchExists() {
  try {
    execFileSync("git", ["fetch", "--quiet", "origin", "gh-pages:refs/remotes/origin/gh-pages"], {
      cwd: ROOT,
      stdio: "ignore",
    });
  } catch {
    // no gh-pages on the remote yet (or offline): fall through to the local check
  }
  try {
    git("rev-parse", "--verify", "--quiet", PAGES_BRANCH);
    return true;
  } catch {
    return false;
  }
}

function isPublished(slug, branchExists) {
  if (LOCAL) return existsSync(join(ROOT, slug, "maps", "dist", "index.html"));
  if (!branchExists) return false;
  return git("ls-tree", "-r", "--name-only", PAGES_BRANCH, "--", `${slug}/index.html`) !== "";
}

/**
 * The title is the README's first "# " line, the card line the first sentence of the first
 * paragraph under it. Both match the map's own title and lede, so the page and the map agree.
 */
function readCardText(slug) {
  const lines = readFileSync(join(ROOT, slug, "README.md"), "utf8").split(/\r?\n/);
  const titleAt = lines.findIndex((line) => line.startsWith("# "));
  if (titleAt < 0) throw new Error(`${slug}/README.md has no "# " title line`);
  const title = lines[titleAt].slice(2).trim();

  const paragraph = [];
  for (const line of lines.slice(titleAt + 1)) {
    const text = line.trim();
    if (!text) {
      if (paragraph.length) break;
      continue;
    }
    if (/^(#|<|!\[|\||```|- |\* )/.test(text)) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(text);
  }
  if (!paragraph.length) throw new Error(`${slug}/README.md has no paragraph under its title`);
  const text = paragraph.join(" ");
  // A sentence ends at . ! or ? followed by a space and a capital, so "4.6" or "km²." inside
  // the sentence does not cut it short.
  const match = text.match(/^.+?[.!?](?=\s+[A-Z]|$)/);
  return { title, line: (match ? match[0] : text).trim() };
}

/** Newest first: the date of the commit that first added the piece's README. */
function addedDate(slug) {
  const dates = git("log", "--diff-filter=A", "--format=%cI", "--", `${slug}/README.md`);
  const first = dates.split("\n").filter(Boolean).pop();
  return first ?? new Date().toISOString(); // not committed yet (local check): treat as newest
}

async function makeThumb(slug) {
  const src = join(ROOT, slug, "docs", "snapshot.png");
  const out = join(DIST, "thumbs", `${slug}.webp`);
  const resized = sharp(src).resize(THUMB_W_PX, THUMB_H_PX, { fit: "cover", position: "centre" });
  for (const quality of THUMB_QUALITIES) {
    const buffer = await resized.clone().webp({ quality, effort: 6 }).toBuffer();
    if (buffer.length <= THUMB_MAX_BYTES) {
      writeFileSync(out, buffer);
      return { bytes: buffer.length, quality };
    }
  }
  throw new Error(
    `${slug}: thumbnail stays over ${THUMB_MAX_BYTES} bytes even at the lowest quality`,
  );
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * One card is one link. Its accessible name is the map title (aria-labelledby) and the line is its
 * description, so a screen reader says the title first instead of the whole card text.
 */
function cardHtml({ slug, title, line }) {
  const t = escapeHtml(title);
  return `        <li class="cell">
          <a class="card" href="./${slug}/" aria-labelledby="t-${slug}" aria-describedby="d-${slug}">
            <span class="thumb"><img src="thumbs/${slug}.webp" width="${THUMB_W_PX}" height="${THUMB_H_PX}" loading="lazy" decoding="async" alt="" /></span>
            <span class="mark" aria-hidden="true"></span>
            <h2 class="title" id="t-${slug}">${t}</h2>
            <p class="line" id="d-${slug}">${escapeHtml(line)}</p>
          </a>
        </li>`;
}

function candidateFolders() {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "site")
    .map((entry) => entry.name)
    .filter((slug) => existsSync(join(ROOT, slug, "README.md")))
    .filter((slug) => existsSync(join(ROOT, slug, "docs", "snapshot.png")))
    .sort();
}

async function main() {
  const branchExists = LOCAL || pagesBranchExists();
  if (LOCAL)
    console.log("Local mode: a piece counts as published when maps/dist/index.html exists.");
  else if (!branchExists)
    console.log(`${PAGES_BRANCH} does not exist yet: no map is published, no cards.`);

  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(join(DIST, "thumbs"), { recursive: true });

  const pieces = [];
  for (const slug of candidateFolders()) {
    if (!isPublished(slug, branchExists)) {
      console.log(`skip  ${slug} (not published)`);
      continue;
    }
    pieces.push({ slug, ...readCardText(slug), added: addedDate(slug) });
  }
  pieces.sort((a, b) => b.added.localeCompare(a.added));

  for (const piece of pieces) {
    const { bytes, quality } = await makeThumb(piece.slug);
    console.log(`card  ${piece.slug}: ${piece.title}`);
    console.log(`      thumbs/${piece.slug}.webp ${(bytes / 1024).toFixed(1)} KB (q${quality})`);
  }

  const cards = pieces.length
    ? `<ul class="grid">\n${pieces.map(cardHtml).join("\n")}\n      </ul>`
    : `<p class="empty">The first map is on its way.</p>`;
  const template = readFileSync(TEMPLATE, "utf8");
  for (const marker of [PLACEHOLDER, GLOBE_PLACEHOLDER])
    if (!template.includes(marker)) throw new Error(`template.html has no ${marker}`);
  const globe = globeSvg(PAGE_GLOBE, 'class="globe"');
  const html = template.replace(PLACEHOLDER, cards).replace(GLOBE_PLACEHOLDER, globe);
  writeFileSync(join(DIST, "index.html"), html);
  console.log(`      globe ${(globe.length / 1024).toFixed(1)} KB inline`);

  for (const file of STATIC_FILES) {
    const src = join(HERE, file);
    if (!existsSync(src)) throw new Error(`site/${file} is missing`);
    copyFileSync(src, join(DIST, file));
  }
  for (const dir of STATIC_DIRS) cpSync(join(HERE, dir), join(DIST, dir), { recursive: true });
  console.log(`wrote site/dist/index.html with ${pieces.length} card(s)`);
}

// Run only when called as a script, so the share image renderer can import globeSvg.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
