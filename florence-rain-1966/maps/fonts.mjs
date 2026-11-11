/**
 * Cut the map's fonts down to the characters it actually shows.
 *
 * What it does: reads the six font files the map uses (Bodoni Moda italic, regular and bold,
 * Courier Prime, Source Serif 4 regular and semibold) from node_modules/@fontsource, keeps only
 * printable ASCII plus every other character that appears in the page, its scripts and the layers
 * it shows as text, and writes them as small WOFF2 files with one stylesheet.
 * Reads:  node_modules/@fontsource/*, maps/index.html, maps/ui.js, maps/main.js,
 *         maps/layers/key_figures.json, maps/layers/points.geojson, maps/layers/meta.json
 * Writes: maps/fonts/*.woff2, maps/fonts/fonts.css, maps/fonts/LICENSE-*.txt (the fonts' OFL)
 * Run:    node maps/fonts.mjs   (npm run dev and npm run build run it first)
 *
 * What you learn: a font file carries hundreds of glyphs for languages a page never uses. A
 * typical web font is split by script already, but even its Latin part holds accents, ligatures
 * and symbols this map never draws. Keeping only the characters in the text cuts each file by
 * about half, and the page shows exactly the same letters.
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import subsetFont from "subset-font";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT_DIR = resolve(HERE, "fonts");
const FONTSOURCE = resolve(ROOT, "node_modules", "@fontsource");

// Every face the map uses, by the family name the stylesheets ask for.
const FACES = [
  { family: "Bodoni Moda", pkg: "bodoni-moda", weight: 400, style: "italic" },
  { family: "Bodoni Moda", pkg: "bodoni-moda", weight: 400, style: "normal" },
  { family: "Bodoni Moda", pkg: "bodoni-moda", weight: 700, style: "normal" },
  { family: "Courier Prime", pkg: "courier-prime", weight: 400, style: "normal" },
  { family: "Source Serif 4", pkg: "source-serif-4", weight: 400, style: "normal" },
  { family: "Source Serif 4", pkg: "source-serif-4", weight: 600, style: "normal" },
];

// Where the visible text lives. Labels and figures come from the layers at run time.
const TEXT_FILES = [
  "index.html",
  "ui.js",
  "main.js",
  "layers/key_figures.json",
  "layers/points.geojson",
  "layers/meta.json",
];

// HTML entities in index.html stand for characters the raw text does not show.
const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", times: "×" };

/** Printable ASCII, always kept, so any number, name or sentence in plain English still works. */
function asciiCharacters() {
  return Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i));
}

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, name) => {
    if (name[0] === "#") {
      const hex = name[1].toLowerCase() === "x";
      return String.fromCodePoint(parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    if (!(name in ENTITIES)) throw new Error(`index.html uses &${name}; add it to ENTITIES`);
    return ENTITIES[name];
  });
}

async function usedCharacters() {
  const characters = new Set(asciiCharacters());
  characters.add(" ");
  for (const file of TEXT_FILES) {
    const text = decodeEntities(await readFile(resolve(HERE, file), "utf8"));
    for (const character of text) {
      // Line breaks and tabs are layout, not glyphs.
      if (character >= " ") characters.add(character);
    }
  }
  return [...characters].sort().join("");
}

function fileName({ pkg, weight, style }) {
  return `${pkg}-${weight}-${style}.woff2`;
}

async function main() {
  const text = await usedCharacters();
  const extra = [...text].filter((c) => c > "~").join(" ");
  console.log(`${text.length} characters: printable ASCII plus ${extra || "nothing"}`);
  await mkdir(OUT_DIR, { recursive: true });
  const rules = [];
  for (const face of FACES) {
    const file = `${face.pkg}-latin-${face.weight}-${face.style}.woff2`;
    const source = resolve(FONTSOURCE, face.pkg, "files", file);
    const original = await readFile(source);
    // The fonts are under the SIL Open Font License, which has to travel with them: I keep the
    // copyright and licence entries of the name table (IDs 0, 13 and 14) that the file carries,
    // and copy the full licence text next to the fonts below.
    const subset = await subsetFont(original, text, {
      targetFormat: "woff2",
      preserveNameIds: [0, 13, 14],
    });
    await writeFile(resolve(OUT_DIR, fileName(face)), subset);
    const kb = (bytes) => (bytes / 1024).toFixed(1);
    console.log(`${fileName(face)}: ${kb(original.length)} KB -> ${kb(subset.length)} KB`);
    // font-display swap: the text shows at once in a fallback face and swaps when the font is in.
    rules.push(
      `@font-face {\n  font-family: "${face.family}";\n  font-style: ${face.style};\n` +
        `  font-weight: ${face.weight};\n  font-display: swap;\n` +
        `  src: url("./${fileName(face)}") format("woff2");\n}\n`,
    );
  }
  for (const pkg of new Set(FACES.map((face) => face.pkg))) {
    await copyFile(resolve(FONTSOURCE, pkg, "LICENSE"), resolve(OUT_DIR, `LICENSE-${pkg}.txt`));
  }
  const header =
    "/* Written by maps/fonts.mjs: the map's fonts, cut down to the characters it shows. */\n";
  await writeFile(resolve(OUT_DIR, "fonts.css"), header + rules.join("\n"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
