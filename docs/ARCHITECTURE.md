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

## Compare

An AI result is a generated video mapped to a named take: `state.clips[key].ai = [{id, kind: 'file'|'url', path|url, label, note, originalStart, duration, width, height, fps}]`. The mapping lives with the take's metadata, so it follows renames and undo like ratings do. `ai.js` guesses the take from a file name (take name, scene/shot/take numbers, camera clip name) and the snippet number, which `planCuts` turns into `originalStart`.

`Project.aiPlayback` mirrors `playback`: browser-safe files play as they are, others get a 720p proxy built in the background, links play remotely. `/ai-media` streams with Range, behind the same token guard as `/media`.

The view (`ui/js/views/compare.js`) uses the AI clip as the master timeline and plays the original at `originalStart + t`, re-seeking it when it drifts (more than 0.2 s while playing, more than 0.02 s when paused). Slider and fade are CSS (a `clip-path` over stacked videos, or opacity); the difference mode is `mix-blend-mode: difference` with a brightness filter, so no pixels are processed in JavaScript.

## AI slate reading

`vision.js` reads a slate with one of three providers, each one `fetch` (no SDKs, so the kit stays dependency-free): Claude through the Anthropic Messages API (the `report_slate` tool is offered, not forced, because current models refuse a forced tool call), ChatGPT through the OpenAI Responses API (JSON mode), and Gemini through `generateContent` (`responseMimeType: application/json`). All three get the same frames and rules; the answer is validated the same way (`6`, `12A`; anything else counts as not read) and confidence is capped when a field is missing. 429, 529, 5xx and network errors are retried with back-off; a bad key, a missing model or an empty account (Anthropic's "credit balance", OpenAI's `insufficient_quota`) is *fatal* and stops a batch instead of failing 40 times. Gemini answers a bad key with 400, which is reported as a bad key. `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` (with `/v1`) and `GEMINI_BASE_URL` are read at call time, so tests run against `test/helpers/fake-ai.js`.

`slate.js` does the project side: frames come from `Project.thumb` (1024 px, cached, from the proxy when there is one), the first pass looks at 0.4 to 4.8 s and a second pass at 6 to 14 s only if no slate was visible. Readings live in `state.clips[key].slate` with the file's fingerprint, so they follow renames and are dropped if the file is replaced. `view()` turns a reading into a status (`new`, `match`, `differs`, `unreadable`) and flags (`low`, `partial`, `taken`, `twice`, `not-in-plan`, `order`) against the library and the shot list. Batches are a job in their own lane (three clips at a time, progress, cancel). Keys live in the user config folder (`anthropic.key`, `openai.key`, `gemini.key`, or `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY`) and are never returned to the browser. The chosen provider, a model per provider and a consent flag per provider (agreeing to send frames to Anthropic is not agreeing for Google) are in `config.json` under `vision`; consent gates every run. Each reading records the provider and model that made it, and what it cost.

Costs are estimates: every model in `vision.js` carries its list price (USD per million tokens, with dated entries for announced price changes), and each request's reported token counts are priced and added to `spend.json` in the user config folder (this month only, written synchronously so parallel readings cannot lose an amount). `slate.estimate` prices a run before it starts (6 frames per clip; the second pass gives the upper bound). The budget in `config.json` (`vision.budget`: `monthly`, `confirmAbove`) is enforced on the server: `/api/slate/read` refuses when the month's budget is used up (`402`, code `budget`) and wants `confirmed: true` for a run above `confirmAbove` (`409`, code `confirm-cost`); `readMany` checks before each clip and stops cleanly when the budget runs out, so it can overshoot by at most the clips already in flight.

## First-run setup

`ui/js/setup.js` asks for the LetzAI key and an AI key, both optional. It opens on start while `config.json` has no `setupDone` (people with a saved LetzAI key or a recent project count as set up). Features without their key are shown disabled with a hint where the key is added: canvas sending in Review and Compare without the LetzAI key, every slate-reading entry point without an AI key. File names are not part of the request.

## Security

The server binds to `127.0.0.1`. A random token is generated per launch and exchanged for an `HttpOnly; SameSite=Strict` cookie; requests without it, or with another `Host`, are refused. Static files are confined to `ui/`. The API key is read from the environment or a user-only file and is never sent to the browser.

## Tests

`npm test` runs pure-logic tests (names, shot list, coverage, canvas sort), slate-reading tests against a fake of the Anthropic, OpenAI and Gemini APIs (key checks per provider, request shape, flags, retries, failures), project integration tests with ffmpeg-generated clips (scan, rename + undo, metadata follows renames, cuts, proxies), AI mapping tests (file-name matching, add, update, rename, missing file, Range streaming), HTTP tests (token guard, Host check, Range, reports), canvas tests against the fake LetzAI (every failure path above, partial takes, retry, page per scene) and a UI test that parses every module and checks that every import resolves (the UI has no build step, so a missing export would blank the page). The real LetzAI API is checked by hand against a scratch canvas (see CONTRIBUTING).
