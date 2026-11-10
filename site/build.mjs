/**
 * Builds the landing page of the live maps, https://laurenzthiele.github.io/Atlas-Lab/.
 *
 * Reads:  every top-level folder of the repo that has README.md and docs/snapshot.png,
 *         the gh-pages branch (to see which maps are published), template.html and the icons here.
 * Writes: site/dist/ with index.html, the icons, og.png and thumbs/<piece-slug>.webp.
 * Run:    cd site && npm ci && npm run build
 *         node build.mjs --local   treats a piece as published when <piece>/maps/dist/index.html
 *                                  exists, so I can check the page before anything is public.
 *
 * I never edit the landing page by hand. A map gets a card once its folder is on gh-pages, so the
 * page cannot link to a map that is not online yet. A GitHub Action runs this on every push to main.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DIST = join(HERE, "dist");
const TEMPLATE = join(HERE, "template.html");
const PLACEHOLDER = "<!-- CARDS -->";
const STATIC_FILES = ["favicon.svg", "favicon-32.png", "apple-touch-icon.png", "og.png"];
const PAGES_BRANCH = "origin/gh-pages";
const THUMB_W_PX = 800;
const THUMB_H_PX = 500;
const THUMB_MAX_BYTES = 100 * 1024;
const THUMB_QUALITIES = [82, 76, 70, 64, 58, 52, 46, 40];
const LOCAL = process.argv.includes("--local");

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

function cardHtml({ slug, title, line }) {
  const t = escapeHtml(title);
  return `        <li>
          <a class="card" href="./${slug}/">
            <img src="thumbs/${slug}.webp" width="${THUMB_W_PX}" height="${THUMB_H_PX}" loading="lazy" alt="${t}" />
            <h2>${t}</h2>
            <p>${escapeHtml(line)}</p>
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
  if (!template.includes(PLACEHOLDER)) throw new Error(`template.html has no ${PLACEHOLDER}`);
  writeFileSync(join(DIST, "index.html"), template.replace(PLACEHOLDER, cards));

  for (const file of STATIC_FILES) {
    const src = join(HERE, file);
    if (!existsSync(src)) throw new Error(`site/${file} is missing`);
    copyFileSync(src, join(DIST, file));
  }
  console.log(`wrote site/dist/index.html with ${pieces.length} card(s)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
