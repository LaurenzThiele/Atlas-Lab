<!-- Save this file as CLAUDE.md in an
empty folder, then give Claude Code the
prompt in prompt.txt. -->
# Map rules

## Data
- Only draw what is in the data. No fake
  windows, no glow on random buildings,
  no made-up water effects. Light, sky
  and haze for mood are fine.
- Height: use `height`. If missing,
  `num_floors` x 3.5 m. If both are
  missing, 4 m. Print how many buildings
  fall in each group.
- Use `min_height` as the base when it's
  there.
- Pull land and water for a wider box
  than the buildings so the ground
  reaches the horizon.
- Credit from Overture's attribution
  page in the corner, readable on a
  phone (at least 22 px at 1080 wide).
  Name only the sources that are really
  in the box.

## Build
- MapLibre GL JS with fill-extrusion,
  one PMTiles file. Pin every version
  and write them in README.md.
- Write a README.md with the exact
  commands to rebuild everything from
  scratch.

## Check your work
- Before recording, render 3 stills
  along the camera path, look at them,
  fix what looks wrong, and render them
  again. Keep the first and the fixed
  stills (stills/first/, stills/fixed/).
- After recording, pull 3 frames from
  the finished video and look at them.

## Film
- 1080x1920, 30 fps. Step through frames
  one by one in headless Chromium with
  Playwright, wait until the map is
  fully loaded on each frame, then join
  them with ffmpeg. Never screen record
  in real time.
- Run the recording in the foreground
  and wait for it to finish.
- Also save one 1080x1350 still of the
  best view as hero.png.

## Report
- At the end, list what you changed
  after looking at the stills, and what
  you couldn't do or had to guess.
