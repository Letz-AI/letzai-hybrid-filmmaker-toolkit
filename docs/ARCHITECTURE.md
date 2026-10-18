# Architecture

A small local web app. No build step and no runtime dependencies: Node's standard library on the server, plain ES modules in the browser.

```
bin/letzai-kit.js        npx / global entry
server/
  index.js               HTTP server: static UI, JSON API, media (Range), thumbnails, SSE events, OS helpers
  app.js                 the running app: open project, job queue, canvas orchestration
  lib/
    project.js           one film: scan, metadata, rename + undo, cuts, playback choice, reports
    coverage.js          shot list x footage -> statuses (pure, unit tested)
    shotlist.js          shot list text <-> structure
    names.js             file name format / parse
    ffmpeg.js            discovery, probe, encoder pick, proxies, posters, cuts
    canvas.js            LetzAI client: retries, verified uploads, layouts (labels / page per scene), sort
    jobs.js              lanes (proxy / cut / upload / misc) with progress
    config.js            per-user config, key, cache dirs
ui/
  index.html, css/       tokens.css = design system tokens; components.css = controls; views.css
  js/app.js              shell, routing, shortcuts, live events
  js/views/              welcome, board, review, ingest, canvas, settings, shotlist
test/                    node:test; media tests use real ffmpeg
scripts/                 make-demo.mjs (synthetic film), screenshot.mjs (headless screenshots)
```

## Data flow

* **The project file** `letzai-kit.json` holds everything a person decided: ratings, print flags, notes, markers, cut ranges, shot list, naming and canvas settings, rename history. Clips are keyed by path relative to the project folder (absolute if outside it). Each entry also stores a size+mtime fingerprint, so metadata follows a file that was renamed outside the kit.
* **The library** is rebuilt by scanning the footage folders (three levels deep; `cuts`, `Proxy` and dot files skipped). ffprobe results are cached by fingerprint in the user cache folder.
* **The UI** gets a full snapshot (`GET /api/library`) and refetches when the server emits a `library` event on `/api/events` (Server-Sent Events). Job progress has its own channel so a progress tick never re-renders a view.

## Playback

`Project.playback()` picks, in order: the original (if H.264 8-bit in mp4/mov and not above 1440p), the camera's `Proxy` file (if the browser can decode it), a generated 720p H.264 proxy (short GOP, built once, cached), else it queues the proxy and tells the client to wait. Everything streams with HTTP Range so scrubbing and frame stepping are instant.

## Renaming

Renames move the take, its `cuts/` snippets and its camera proxy together, roll back if any move fails, and write an undo record. A collision is refused with a suggested free take; the client can retry as “next free take” or “keep as duplicate”.

“Rename all” (`planRenameAll` / `renameAll`) computes the new name of every take under the current scheme, drops takes whose target is taken by a file that stays (settled iteratively, because which takes move depends on which conflict), and moves everything through `_moveAll`: every file to a temporary name first, then to its final name, rolled back on any failure. That makes swaps and chains safe, and undo uses the same routine. Numbers are normalised (`pad` strips and re-adds leading zeros).

## Canvas

Node ids match the filmmaker's earlier command-line namer script (not part of this repository) so both can work on one canvas: media `ltn:<file>`, caption `ltn-cap:<file>`, scene label `Scene N`. Only nodes with these ids are ever moved.

Two layouts (`canvas.mode`): `labels` (one page, a `Scene N` text node per scene) and `pages` (the page named `Scene N` per scene, `findScenePage`). `planSort` / `planSortPage` compute the moves; `pageForScene` resolves where a scene goes and fails with a friendly message when no page exists (the API cannot create pages).

Uploads are `POST /user-assets`, a signed `PUT` (stall-guarded), a `HEAD` on the public URL whose `content-length` must equal the local file size, then `POST .../nodes/batch`, whose response must contain the clip node. Reads, `PUT`, `PATCH`, `DELETE` and the slot request are retried on network errors, 429, 502-504 and stalls with back-off; the creating `POST` is only retried on 429, and after an ambiguous failure the page is re-read before reporting. Each snippet is attempted separately; failures are collected into `project.canvasErrors` (per take, shown in every view) and the job fails with a summary. `state.sent[file]` remembers the size sent, so a re-cut snippet replaces its stale node. Page mutations are serialised through one promise chain.

`CanvasClient` reads `LETZAI_API_BASE` at call time, so tests run the whole pipeline against `test/helpers/fake-letzai.js`, which can refuse, truncate, stall, rate-limit and drop nodes on demand.

## Security

The server binds to `127.0.0.1`. A random token is generated per launch and exchanged for an `HttpOnly; SameSite=Strict` cookie; requests without it, or with another `Host`, are refused. Static files are confined to `ui/`. The API key is read from the environment or a user-only file and is never sent to the browser.

## Tests

`npm test` runs pure-logic tests (names, shot list, coverage, canvas sort), project integration tests with ffmpeg-generated clips (scan, rename + undo, metadata follows renames, cuts, proxies), HTTP tests (token guard, Host check, Range, reports), canvas tests against the fake LetzAI (every failure path above, partial takes, retry, page per scene) and a UI test that parses every module and checks that every import resolves (the UI has no build step, so a missing export would blank the page). The real LetzAI API is checked by hand against a scratch canvas (see CONTRIBUTING).
