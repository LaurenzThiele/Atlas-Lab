# Prompts I used

Real runs, 16 Nov 2026, Claude Code 2.1.325 in headless mode (`claude -p`), in a fresh empty folder each time. Tools allowed: Bash, Read, Write, Edit, Glob, Grep. Free tools and free data only.

## Run 1: the naive prompt (what most people would type)

```
Build a 3D map of every building in Miami that runs in a browser. Use Overture Maps open data for the buildings, with their real heights. Make it look like a neon dusk: pink and teal light, dark ground, a bit of fog. Then film it yourself: record a 30 second 1080x1920 video of the camera gliding down the coast, frame by frame in headless Chromium with Playwright, and save it as reel.mp4. Free tools and free data only. At the end, tell me what you couldn't do or had to guess.
```

What went wrong: it looked like a game because it made up lit windows, neon tower tops and traffic, and it wrote its own three.js engine instead of using MapLibre. It said so itself: "Lighting details are made up."

## Run 2: rules in the prompt

```
Build a 3D map of every building in Miami that runs in a browser, then film it yourself.

Data: Overture Maps buildings (latest release) for the box -80.32,25.70,-80.11,25.88, plus Overture land and water for the ground. Use the real height field. If a building has no height, use num_floors x 3.5 m, and if it has neither, give it 4 m. Count how many buildings fall in each of the three groups and print it.
Map: MapLibre GL JS with fill-extrusion, buildings served from one PMTiles file. Look: neon dusk, dark ground, pink and teal by height, pink sky at the horizon.
Rules: only draw what is in the data. No fake windows, no glow on random buildings, no made-up water effects. Put the data credit from Overture's attribution page in the corner.
Check your work: render 3 stills along the camera path, look at them, and fix anything that looks wrong before you record. Tell me what you changed.
Film: 30 s, 30 fps, 1080x1920, camera gliding south down the coast from Miami Beach past downtown. Step through the frames one by one in headless Chromium with Playwright (don't screen record in real time), wait until the map is fully loaded on each frame, then join them into reel.mp4 with ffmpeg.
Free tools and free data only. At the end, list what you couldn't do or had to guess.
```

## Run 3 (final): a short prompt plus a rules file

The rules moved out of the prompt into a rules file. Save [ai/rules-for-claude.md](ai/rules-for-claude.md) as CLAUDE.md in an empty folder: Claude Code reads a file with that name by itself at the start. The rules file works for any city; change the box in the prompt.

Prompt ([ai/prompt.txt](ai/prompt.txt)):

```
Follow CLAUDE.md. Build a 3D map of every building in Miami (Overture Maps buildings, latest release, box -80.32,25.70,-80.11,25.88) in a neon dusk look: dark ground, teal and pink by height, pink sky at the horizon. Then film a 30 s reel of the camera gliding south down the coast from Miami Beach to downtown and save it as reel.mp4.
```

Rules file ([ai/rules-for-claude.md](ai/rules-for-claude.md)):

```markdown
# Map rules

## Data
- Only draw what is in the data. No fake windows, no glow on random buildings, no made-up water effects. Light, sky and haze for mood are fine.
- Height: use `height`. If missing, `num_floors` x 3.5 m. If both are missing, 4 m. Print how many buildings fall in each group.
- Use `min_height` as the base when it's there.
- Pull land and water for a wider box than the buildings so the ground reaches the horizon.
- Credit from Overture's attribution page in the corner, readable on a phone (at least 22 px at 1080 wide). Name only the sources that are really in the box.

## Build
- MapLibre GL JS with fill-extrusion, one PMTiles file. Pin every version and write them in README.md.
- Write a README.md with the exact commands to rebuild everything from scratch.

## Check your work
- Before recording, render 3 stills along the camera path, look at them, fix what looks wrong, and render them again. Keep the first and the fixed stills (stills/first/, stills/fixed/).
- After recording, pull 3 frames from the finished video and look at them.

## Film
- 1080x1920, 30 fps. Step through frames one by one in headless Chromium with Playwright, wait until the map is fully loaded on each frame, then join them with ffmpeg. Never screen record in real time.
- Run the recording in the foreground and wait for it to finish.
- Also save one 1080x1350 still of the best view as hero.png.

## Report
- At the end, list what you changed after looking at the stills, and what you couldn't do or had to guess.
```

What the stills check caught: the first stills had no sky, because the horizon sat above the frame. It fixed the camera before it started filming.
