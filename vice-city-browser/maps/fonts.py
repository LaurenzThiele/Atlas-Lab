"""Cut the map's five font files down to the characters the map shows.

What it does: reads Righteous 400, Outfit 400 and 600 and JetBrains Mono 400 and 700 from
node_modules/@fontsource, keeps printable ASCII plus every other character that appears in the
page, its scripts and the layers it shows as text, and writes small WOFF2 files with one
stylesheet. The labels on the map use the same Outfit SemiBold file through MapLibre's
font-faces, so the page and the map draw the very same letters.
Reads:  node_modules/@fontsource/{righteous,outfit,jetbrains-mono}, maps/index.html, maps/*.js,
        maps/layers/figures.json, maps/layers/meta.json, maps/layers/labels.geojson
Writes: maps/fonts/*.woff2, maps/fonts/fonts.css, maps/fonts/LICENSE-*.txt (the fonts' OFL)
Run:    uv run maps/fonts.py   (npm run dev and npm run build run it first)

What you learn: a font file carries hundreds of glyphs a page never uses. Keeping only the
characters in the text cuts each file to a third or less, and the page looks exactly the same.
"""

import html
import re
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

HERE = Path(__file__).parent
PIECE_DIR = HERE.parent
FONTSOURCE = PIECE_DIR / "node_modules" / "@fontsource"
OUT_DIR = HERE / "fonts"

# Every face, by the family name the stylesheet asks for. At most two weights per family.
FACES = [
    {"family": "Righteous", "pkg": "righteous", "weight": 400},
    {"family": "Outfit", "pkg": "outfit", "weight": 400},
    {"family": "Outfit", "pkg": "outfit", "weight": 600},
    {"family": "JetBrains Mono", "pkg": "jetbrains-mono", "weight": 400},
    {"family": "JetBrains Mono", "pkg": "jetbrains-mono", "weight": 700},
]

# Where visible text lives besides the page and its scripts.
LAYER_TEXT = ["layers/figures.json", "layers/meta.json", "layers/labels.geojson"]
# Characters the scripts write as escapes (  and the like), so a text search misses them.
ALWAYS = " ²×–’©…"


def used_characters() -> str:
    characters = {chr(c) for c in range(0x20, 0x7F)} | set(ALWAYS)
    files = sorted(HERE.glob("*.html")) + sorted(HERE.glob("*.js"))
    files += [HERE / name for name in LAYER_TEXT]
    for path in files:
        if not path.exists():
            raise SystemExit(f"Missing {path.relative_to(PIECE_DIR)}: run uv run maps/prepare.py")
        text = html.unescape(path.read_text(encoding="utf-8"))
        characters |= {c for c in text if c >= " "}
    return "".join(sorted(characters))


def font_file(face: dict) -> Path:
    path = FONTSOURCE / face["pkg"] / "files" / f"{face['pkg']}-latin-{face['weight']}-normal.woff2"
    if not path.exists():
        raise SystemExit(f"Missing {path.name}: run npm install")
    return path


def write_subset(face: dict, text: str) -> Path:
    font = TTFont(font_file(face))
    options = subset.Options()
    options.flavor = "woff2"
    # Keep the copyright and licence entries of the name table: the OFL travels with the font.
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    options.layout_features = ["kern", "liga", "calt", "tnum", "case"]
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=text)
    subsetter.subset(font)
    out = OUT_DIR / f"{face['pkg']}-{face['weight']}.woff2"
    font.flavor = "woff2"
    font.save(out)
    return out


def main() -> None:
    text = used_characters()
    extra = " ".join(c for c in text if c > "~")
    print(f"{len(text)} characters: printable ASCII plus {extra}")
    OUT_DIR.mkdir(exist_ok=True)
    rules = []
    for face in FACES:
        out = write_subset(face, text)
        before = font_file(face).stat().st_size / 1024
        print(f"{out.name:<26} {before:6.1f} KB -> {out.stat().st_size / 1024:5.1f} KB")
        # font-display swap: text shows at once in a fallback face, then swaps when loaded.
        rules.append(
            f'@font-face {{\n  font-family: "{face["family"]}";\n  font-style: normal;\n'
            f"  font-weight: {face['weight']};\n  font-display: swap;\n"
            f'  src: url("./{out.name}") format("woff2");\n}}\n'
        )
    for pkg in dict.fromkeys(face["pkg"] for face in FACES):
        licence = (FONTSOURCE / pkg / "LICENSE").read_text(encoding="utf-8")
        (OUT_DIR / f"LICENSE-{pkg}.txt").write_text(licence, encoding="utf-8")
    header = "/* Written by maps/fonts.py: the map's fonts, cut to the characters it shows. */\n"
    (OUT_DIR / "fonts.css").write_text(header + "\n".join(rules), encoding="utf-8")
    if not re.search(r"Outfit", (OUT_DIR / "fonts.css").read_text()):
        raise ValueError("fonts.css lost the Outfit faces")


if __name__ == "__main__":
    main()
