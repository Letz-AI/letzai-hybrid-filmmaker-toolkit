# LetzAI Hybrid Filmmaker Kit

[![CI](https://github.com/Letz-AI/letzai-hybrid-filmmaker-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/Letz-AI/letzai-hybrid-filmmaker-toolkit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)
![Node 20+](https://img.shields.io/badge/node-20%2B-black.svg)
![Windows, macOS, Linux](https://img.shields.io/badge/runs%20on-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-black.svg)

**Review your shoot, see which shots are still missing, name and select your takes, and send the best ones to a [LetzAI Canvas](https://www.letz.ai/canvas).**

It runs on your own computer, with your own footage and your own LetzAI API key. Nothing is uploaded except the clips you choose to send to your canvas. No account is needed to use the review tools, and there is nothing to build: you install Node.js and ffmpeg, download this repository, and start it.

Made for a hybrid workflow: shoot real footage, name and select it quickly, then bring the best takes into LetzAI to generate around them.

![The Board shows every scene and shot, what is covered, and what is still missing](docs/screenshots/board.png)

## Contents

[What it does](#what-it-does) · [Install](#install) · [First session](#first-session) · [The tour](#the-tour) · [Compare](#compare-original-vs-ai) · [Shot list](#the-shot-list) · [Keyboard](#keyboard) · [File names](#how-files-are-named-and-renamed) · [LetzAI Canvas](#the-letzai-canvas-connection) · [4K and HEVC](#playback-4k-and-hevc) · [Your data](#your-data-and-privacy) · [Troubleshooting](#troubleshooting) · [Development](#development)

## What it does

| | |
|---|---|
| **Board** | Your shot list laid over what was actually shot. Every scene and shot with a thumbnail, take count, status and warnings. Missing shots are called out. |
| **Review** | A frame-accurate player built for dailies. Rate takes (void, ok, good), circle the one to print, write notes, set markers, mark in and out points, compare two takes side by side. Everything on the keyboard. |
| **Ingest** | Name raw camera files from the slate (the *Klappe*). Read it, type scene, shot and take, press Enter, next clip. Or select many clips and name them in one go. Every rename can be undone. |
| **Rename** | Fix names later: one take, a whole shot, a whole scene or any selection. Change scene or shot and renumber takes. Or apply a new naming scheme to every file at once. |
| **Folders** | A film is often several shoot days. Filter every view to one folder, browse folders as cards, and get told when new footage appears that the project does not look at yet. |
| **Compare** | Map the AI videos you generated to the take they came from, then judge them against the original with a slider, side by side, a cross-fade or a difference view. Both play in sync, frame by frame. |
| **Canvas** | Cut takes into snippets of at most 30 seconds and send them to a LetzAI Canvas, on one page or one page per scene. Every upload is verified, nothing is sent twice, and anything that fails stays on screen with the reason and a Retry. |

## Install

You need three things on your computer: **Node.js 20 or newer**, **ffmpeg**, and this repository. Nothing else, and no `npm install`: the kit has no dependencies.

### 1. Install Node.js and ffmpeg

Pick your system and run the commands in a terminal (Windows: PowerShell).

<table>
<tr><th>Windows 10 / 11</th><th>macOS</th><th>Linux (Debian, Ubuntu)</th></tr>
<tr><td>

```powershell
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
```
Then close and reopen the terminal.

</td><td>

```bash
brew install node ffmpeg
```
No Homebrew? Get it at [brew.sh](https://brew.sh).

</td><td>

```bash
sudo apt update
sudo apt install ffmpeg git
```
Node 20+: see [nodejs.org](https://nodejs.org/en/download) or use `nvm`. The `nodejs` in Debian and Ubuntu is often too old.

</td></tr>
</table>

Other Linux distributions: install `ffmpeg` (with `ffprobe`) and Node.js 20+ with your package manager (`dnf`, `pacman`, `zypper`…). Prefer not to use a package manager? Download Node.js from [nodejs.org](https://nodejs.org) and ffmpeg from [ffmpeg.org](https://ffmpeg.org/download.html) (on Windows, [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) builds work well). If ffmpeg lives somewhere unusual, set `LETZAI_KIT_FFMPEG` to its folder.

### 2. Get the kit

```bash
git clone https://github.com/Letz-AI/letzai-hybrid-filmmaker-toolkit.git
cd letzai-hybrid-filmmaker-toolkit
```

No git? On the GitHub page press **Code → Download ZIP**, unzip it, and open a terminal in that folder.

### 3. Check that everything is in place

```bash
npm run check
```

It lists what it found (Node, ffmpeg, your video encoder, a browser for the app window) and tells you exactly what to install if something is missing:

```
  ok       Node.js 22.11.0
  ok       ffmpeg 7.1  /opt/homebrew/bin/ffmpeg
  ok       ffprobe
  ok       video encoder: h264_videotoolbox  (hardware)
  ok       app window: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  ...
  Ready. Start the kit with:  npm start
```

### 4. Start it

```bash
npm start
```

The kit opens in its own window (Chrome, Edge or Brave in app mode; otherwise your default browser). Close the terminal window to stop it.

Prefer a double-click? Use **`Start-Kit.bat`** (Windows), **`Start-Kit.command`** (macOS, the first time: right-click, Open) or **`start-kit.sh`** (Linux and macOS: `sh start-kit.sh`).

**Just want a look around?** Run `npm run demo`. It builds a small synthetic film (slates, takes, two shoot days, a shot list with gaps, unnamed clips) and opens it. The demo lives in your temporary folder, so there is nothing to clean up.

### Updating and removing

```bash
git pull            # update (or download the ZIP again)
```

To remove the kit, delete its folder. Your footage is never touched by that. Settings and the saved API key live in a per-user folder (`%APPDATA%\LetzAI-Hybrid-Filmmaker-Kit` on Windows, `~/Library/Application Support/LetzAI-Hybrid-Filmmaker-Kit` on macOS, `~/.config/LetzAI-Hybrid-Filmmaker-Kit` on Linux) and review copies in the cache folder next to it; `npm run check` prints both locations. Delete them too for a clean removal. Each film also gets one small file, `letzai-kit.json`, in its folder.

### Platform notes

| | Windows | macOS | Linux |
|---|---|---|---|
| **Tested** | Windows 11, Edge | Automated tests on GitHub's macOS runners | Automated tests on GitHub's Linux runners, Node 20 and 22 |
| **Video encoder** | NVIDIA, Intel or AMD hardware, else processor | VideoToolbox, else processor | NVIDIA, Intel or AMD hardware if ffmpeg supports it, else processor |
| **Folder dialog** | built in | built in | needs `zenity` or `kdialog`; otherwise paste a folder path |
| **4K HEVC from phones and cameras** | Edge needs the "HEVC Video Extensions" add-on to play them directly; otherwise the kit makes small copies | plays directly in Safari and Chrome | Chrome and Firefox usually cannot; the kit makes small copies |
| **Browser** | Edge, Chrome, Brave | Chrome, Edge, Brave, Safari | Chrome, Chromium, Edge, Brave, Firefox |

The interface is developed against Chromium browsers. Safari and Firefox should work but are less tested; if something looks off there, please open an issue.

## First session

1. **Choose your film folder.** The kit adds one small file, `letzai-kit.json`, to it. Your footage is not moved or changed unless you rename or cut it here.
2. **Name the raw clips** in *Ingest*. Camera files like `A001_10171033_C047.mov` become `YourFilm-scene6-shot2-take1.mov`. To name many at once, press **Name several at once…** (see below). Subfolders and your camera's own `Proxy` folder are picked up automatically.
3. **Write the shot list** (*Board → Shot list*), or press *Use what's shot so far* and add the shots you still owe. The Board now shows what is missing. **Add scene** creates a whole scene in one step.
4. **Review** the takes. Rate with `1` `2` `3`, circle the keeper with `P`, add notes. `Ctrl K` (`Cmd K` on a Mac) jumps to any shot.
5. **Connect LetzAI** in *Canvas*: paste your API key, pick the canvas, select takes, press *Cut and send*.

## The tour

### Board and folders

The Board is home. Stat cards show what is covered, printed, still to review, and missing. *By scene* shows every shot as a card; *By folder* shows your shoot days and subfolders; *All clips* is a table you can tick takes in. The folder button limits any view to one folder.

![By folder: one card per shoot day](docs/screenshots/folders.png)

### Review

Frame-accurate stepping (`←` `→`), speeds (`J` `K` `L`), in and out points (`I` `O`), cuts (`Enter`), markers (`M`), ratings (`1` `2` `3`), print (`P`), and a take strip along the bottom. `C` compares two takes side by side, `T` hides the side panels for a bigger picture.

![Review: rate, print, cut](docs/screenshots/review.png)

![Compare two takes in focus mode](docs/screenshots/compare.png)

### Compare: original vs AI

Generated a restyled version of a take? Map it to the original and see exactly what changed.

1. Open **Compare** (`g` then `m`) and press **Add AI results…**. Choose the video files, pick them **from the canvas** (generations on your LetzAI Canvas), or paste an `https://` link. The kit guesses the take from the file name (`...scene6_shot2_take3_cut-2_v1.mp4`, the full take name, or the camera clip name); change it in the take menu if it guessed wrong or could not tell.
2. An AI clip is usually made from a *piece* of the take, such as snippet 2 you sent to the canvas. Say which snippet (or how many seconds into the take it starts) and both videos play in step. You can nudge the offset frame by frame.
3. Judge it. **Slider**: drag the divider, original on one side, AI on the other. **Side**: both next to each other. **Fade**: cross-fade between them. **Diff**: shows what changed, brightened. Several AI versions of one take sit in a strip below; switch between them to pick the best.

![Slider: original on the left, AI version on the right](docs/screenshots/ai-compare.png)

![Difference view highlights what the AI changed](docs/screenshots/ai-compare-diff.png)

Notes and labels are saved per AI result. Removing a result only forgets the mapping; the video file is never touched, and the mapping follows the take when you rename it.

### Ingest: naming clips from the slate

Each unnamed clip shows a big frame to read the slate from (click to enlarge; the buttons jump to later frames in case the slate comes in late). Type scene, shot and take, press `Enter`, and the next clip appears. The kit predicts the next take, warns about duplicates, and everything is undoable (`Ctrl Z`).

![Ingest: read the slate, type, Enter](docs/screenshots/ingest.png)

**Name several at once.** Press the white **Name several at once…** button at the top of the list. It shows every unnamed clip with a checkbox and the name it would get. Untick any you do not want, type the scene and shot from the slate, set the first take, and the takes count up in the order the clips were recorded (or choose *One shot each*). Press **Rename**. Names that exist already are never overwritten, and one **Undo** reverses the batch. Shortcut: `Ctrl K` → "Name several clips".

![Name several clips at once](docs/screenshots/batch-rename.png)

### Renaming takes that already have a name

- **Review → Rename ▾**: *This take*, *Whole shot* or *Whole scene*.
- **Board → By scene**: the **Rename** button on each scene.
- **Board → All clips**: tick takes, then **Rename selected…**.

Change the scene or shot (leave a field empty to keep it) and optionally renumber the takes. You see every new name before anything happens.

![Rename a whole shot](docs/screenshots/rename-takes.png)

**Rename all files** (*Settings → Naming*, the project menu, or `Ctrl K`) applies the current prefix, number padding and rating tags to every take you have named.

### Canvas

Cut takes into snippets and send them to LetzAI. See [The LetzAI Canvas connection](#the-letzai-canvas-connection).

## The shot list

Plain text, one shot per line. The preview next to it shows exactly what the Board will track.

```
Scene 6 - Kitchen
6.1  Wide, Mira enters  [WS]
6.2A Close on the cup   [CU]
?6.4 Optional insert        # a leading ? makes a shot optional
6.5-8                       # a range creates shots 5, 6, 7 and 8

Scene 7 - Street
7.1-3
```

Inside a scene header you can leave the scene number out (`2A  Close on the cup`). Without a shot list the Board still spots holes in your numbering (shots 1, 2 and 4 means 3 is flagged).

## Keyboard

On a Mac, `Ctrl` is `Cmd`.

| Anywhere | |
|---|---|
| `Ctrl K` | Jump to any shot, file or action |
| `g` then `b` `r` `m` `i` `c` `s` | Go to Board, Review, Compare, Ingest, Canvas, Settings |
| `?` | All shortcuts |

| Review | | | |
|---|---|---|---|
| `Space` / `K` | play, pause | `1` `2` `3` | void, ok, good |
| `J` / `L` | slower, faster | `P` | print this take |
| `←` `→` | one frame (`Shift`: one second) | `[` `]` | previous, next take |
| `I` `O` | in point, out point | `{` `}` | previous, next shot |
| `Enter` | add cut from in to out | `C` | compare with the next take |
| `M` | marker | `T` | focus (hide side panels) |
| `S` | send to canvas | `F` | full screen |

| Compare | | | |
|---|---|---|---|
| `Space` | play, pause | `1` `2` `3` `4` | slider, side by side, fade, difference |
| `←` `→` | one frame | `S` | swap sides |
| `[` `]` | previous, next AI result | `{` `}` | previous, next take |
| `F` | full screen | | |

| Ingest | |
|---|---|
| `Enter` | apply the name, go to the next clip |
| `Tab` | next field |
| `Esc` | skip |
| `Ctrl Z` | undo the last rename |

## How files are named and renamed

```
<Prefix>-scene<S>-shot<H>-take<T>.<ext>        MyFilm-scene6-shot2A-take3.mov
```

- The prefix and number padding are set per project (*Settings → Naming*).
- Ratings and print flags live in the project file, so a name never changes when you change your mind. Prefer the old style (`...-take3-good-print.mov`)? Turn on *Put the rating in the file name*.
- A second clip carrying a take that already exists can be kept as a duplicate: `...-take3-dupC149.mov`.
- Cut snippets go into a `cuts` folder next to the take: `...-take3-cut-1.mp4`, `-cut-2`, and so on. Renaming a take renames its cuts and its camera proxy with it.
- Renames are safe: files move through temporary names (swaps and chains cannot collide), everything is rolled back if one step fails, a file that is briefly locked by Dropbox or a preview is retried for several seconds, and every rename is one undo.

## The LetzAI Canvas connection

The kit talks to the public LetzAI API (`https://api.letz.ai`) with your own key. It never sends your key anywhere else. Get a key at [letz.ai/subscription](https://letz.ai/subscription), paste it into *Canvas → API key*, then choose your canvas.

- **Two layouts.** *One page*: everything goes to one page, each scene under a text node called `Scene N`. *Page per scene*: each scene goes to the page named after it (`Scene 6`, `Scene 14`…), in a grid below what is already there. The kit suggests the second when your canvas has pages like that. LetzAI's API cannot create pages, so a scene without a page is reported ("add a page called Scene 9") instead of being sent somewhere surprising. **Copy names** and **Open canvas** buttons help you add them.
- **What gets uploaded.** Only the snippets you send. Pictures are scaled to at most 1080p by default (configurable), clips are never scaled up, and each snippet is at most 30 seconds.
- **Order.** Three clips per row, ordered by shot, take and cut, each with a caption. The kit only moves nodes it created (they carry a `ltn:` id), never yours.
- **No duplicates, no stale clips.** A clip with the same file name is not uploaded twice. If you cut a take again, the changed snippet replaces the old one.
- **Errors are never swallowed.** Each upload is checked: the upload link, the bytes that arrived (compared with the file size on LetzAI), and the nodes that were created. Network problems, rate limits and stalled transfers are retried. One bad snippet does not stop the rest of its take. Whatever still fails stays on the take with the reason, shown in the top bar, on the Board, in Review and on the Canvas page, with **Retry**.

## Playback, 4K and HEVC

Phones and many cameras record 4K HEVC (H.265), which most browsers cannot play. The kit plays the original when it can, uses your camera's own `Proxy` file when there is one, and otherwise makes a small 720p copy (once, cached). By default it prepares those copies **in the background**, unnamed clips first, using one stream so your computer stays usable. The top bar shows "Preparing playback · N left · about X min" and a click on it pauses or resumes. Opening a clip jumps it to the front of the queue. *Settings → Playback* switches it off.

For instant playback with no copies: on Windows install **HEVC Video Extensions** from the Microsoft Store (paid, or free from your PC maker); on macOS Safari and Chrome already play HEVC.

## Your data and privacy

| What | Where |
|---|---|
| Ratings, notes, cuts, markers, shot list, naming and canvas settings, rename history | `letzai-kit.json` in your film folder. Plain JSON, safe to sync or commit. |
| Review copies, thumbnails, probe cache | Your user cache folder. Safe to delete. |
| API key | Your user settings folder, never in the film folder. The `LETZAI_API_KEY` environment variable also works. |

The server listens on `127.0.0.1` only. Every request needs a random key from the launch link, and requests with a foreign `Host` header are refused, so other websites cannot talk to it. Nothing leaves your computer except what you send to your canvas.

## Troubleshooting

| | |
|---|---|
| **`npm run check` says ffmpeg is missing** | Install it (see [Install](#1-install-nodejs-and-ffmpeg)), reopen the terminal, check again. Unusual location? Set `LETZAI_KIT_FFMPEG` to its folder. |
| **"Node.js 20 or newer is needed"** | Update Node.js. On Linux the distribution's package is often old: use [nodejs.org](https://nodejs.org/en/download) or `nvm`. |
| **A clip says "Preparing a review copy"** | It is a 4K camera file your browser cannot play directly. A small copy is being made (10 to 60 seconds); the kit prepares the rest in the background. See [Playback](#playback-4k-and-hevc). |
| **A rename says a file is "in use by another program"** | Dropbox, OneDrive or another program is reading it. The kit already waited and retried; nothing was changed. Wait until syncing finishes and try again. |
| **An upload failed** | Open *Canvas*. The failed take is listed with the reason and *Retry* sends only what is missing. "Scene N has no page" means the canvas has no page of that name: add one in LetzAI and press *Check again*. |
| **Opens in a tab, not a window** | No Chrome, Edge or Brave was found, so your default browser is used. It works the same. Add `--browser` to always use it. |
| **No folder dialog (Linux)** | Install `zenity` (or `kdialog` on KDE), or paste the folder path. |
| **Port in use** | `npm start -- --port 5000`. The kit also picks the next free port by itself. |
| **The window looks outdated after an update** | Reload it (`Ctrl R`). The kit reloads the page by itself when it restarts. |
| **Still stuck** | Run `npm run check` and open an [issue](https://github.com/Letz-AI/letzai-hybrid-filmmaker-toolkit/issues) with its output. |

## Coming from an older naming script

Open the same folder as a project, then *Settings → Import ratings from the old namer* to bring over ratings, print flags and notes from `continuity-log.csv`. Files named like `...-take3-good-print.mov` are understood as they are, and `cuts` folders and canvas nodes created by the old tool are recognised, so nothing is uploaded twice.

## Development

```bash
npm test                # unit, integration and HTTP tests (needs ffmpeg for the media tests)
npm run dev             # restart the server on file changes
npm run demo            # the synthetic demo film
npm run check           # is this computer ready?
```

No build step and no runtime dependencies: the server is plain Node (`server/`), the interface is plain ES modules (`ui/`). The test suite runs on Windows, macOS and Linux with Node 20 and 22 in [CI](.github/workflows/ci.yml); upload and error handling are tested against a fake LetzAI server that can refuse, truncate, stall and rate-limit on demand.

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it works
- [docs/ROADMAP.md](docs/ROADMAP.md): ideas for where it could go
- [CONTRIBUTING.md](CONTRIBUTING.md): ground rules and how to contribute
- [docs/BRANDING.md](docs/BRANDING.md): design system and trademark notes

## Brand

The interface follows the [LetzAI brand guidelines](https://www.letz.ai/brandguidelines) and design system: monochrome, Inter, one filled action per surface. The LetzAI logo files are not included in this repository.

## License

[MIT](LICENSE). "LetzAI" and its logos are not covered by that license.
