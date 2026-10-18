# Roadmap and ideas

Where the kit could go next. Nothing here is promised; it is a list of ideas, roughly in the order they would pay off for someone shooting real footage and then generating around it. Open an issue to discuss, vote on, or take one.

## The hybrid loop (what makes this tool different)

- **Frame to generation.** Grab the current frame of a take (or a printed take's first frame) and send it straight to LetzAI: as a reference for an image edit, as the first frame of a video, or as input for a trained `@model`. The result comes back to the project.
- **Generated shots as first-class takes.** Bring generated clips back into the Board next to the real takes of the same shot: marked as generated, rated and printed the same way, and counted in coverage. "Shot 6.4 is covered by a generated take" becomes visible.
- **Canvas to shot list.** Read a canvas page such as "Shotlist" or "Storyboard" and offer to turn its frames into planned shots, so the plan lives where the team already works.
- **Pull selects back from the canvas.** Show which printed takes already have generations on the canvas, and link a generation to the take it came from.

## Faster, smarter ingest

- **Slate reading, next steps.** Slate reading with Claude exists (your own Anthropic key, confirmation before any rename). Still to do: other providers (an OpenAI-compatible endpoint, a local model through Ollama, the Claude Code CLI) for people without an API key, and naming clips that have no slate at all by what is in the picture, matched against the descriptions in the shot list.
- **Clap sync and audio.** Waveform in Review, sync double-system sound to picture by the clap, and name audio files from the slate too.
- **Offload verification.** Checksum files after copying from the card (and write a simple report), so you know the footage is safe before you format it.
- **Watch folders.** Notice new clips as they land (card dump, Dropbox) and offer to name them, instead of on rescan.

## Review

- **Overlay for two takes.** The Compare view already does slider, side by side, fade and difference between an original and its AI result. Offer the same between two *takes*, for matching performances and continuity.
- **Compare more than two.** A grid of every AI version of a take playing together, with a pick-the-winner flow that sends the chosen version back to the canvas.
- **Numbers behind the picture.** A difference heat-map and a score per AI version (how far it drifted from the original).
- **Timecoded comments.** Notes tied to a moment, with initials, and a comment list you can walk through.
- **Search the dialogue.** Local speech-to-text so you can find "the take where she says the line".
- **Quality hints.** Flag likely soft focus, camera shake or a clipped slate, as hints only.
- **Take statistics.** How many takes per shot, time per setup, where the day went.

## Handing over to the edit

- **Selects to an editor.** Export printed takes with their in and out points and markers as OpenTimelineIO, EDL, FCPXML or a Resolve / Premiere project, with the original files.
- **Reports.** A one-page dailies report (PDF) for each shoot day: scenes completed, shots missing, notes, runtime. A wrap report for the production.
- **Continuity sheets.** Frame stills side by side for each shot, with props and wardrobe notes.

## Plan and import

- **Script and shot list import.** CSV, Fountain and Final Draft files, so scenes come with their descriptions.
- **Multi-camera.** Group clips from several cameras by time and treat them as one setup.
- **Shoot days with dates.** Read the recording date and group by day automatically, with a call-time and wrap-time view.

## Working together

- **Shared projects.** Merge ratings and notes when two people use the same synced folder, with a clear conflict message.
- **On-set tablet.** Serve the review screen on the local network (with a proper access code) so the director can watch on a tablet.

## Packaging

- **One-click installers** for Windows and macOS (a signed app that bundles Node and ffmpeg), plus an auto-update check.
- **Publish to npm** so `npx` can run it without cloning.
- **Docker image** for running it on a NAS next to the footage.

## Housekeeping

- **Cache manager.** See what the review copies take up, clear them per film, set a size limit.
- **Accessibility pass.** Screen-reader labels for every control, a high-contrast option, full keyboard reach in dialogs.
- **Translations.** The interface is English only today.
