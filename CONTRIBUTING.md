# Contributing

Thanks for helping. The aim is a fast, calm tool for people who shoot and then generate. Keep it dependency-free and keep it quiet.

## Setup

```bash
git clone https://github.com/<your-user>/letzai-hybrid-filmmaker-toolkit.git
cd letzai-hybrid-filmmaker-toolkit
npm test            # needs Node 20+ and ffmpeg on PATH
npm run demo        # a synthetic film to click around in
npm run dev         # restart the server on changes (open the link it prints)
```

## Ground rules

* **No runtime dependencies, no build step.** If something needs a package, it probably needs rethinking.
* **Follow the design system.** Use tokens from `ui/css/tokens.css`, no hex in component CSS, one filled button per surface, sentence case, icons from the set in `ui/js/lib.js`. See [docs/BRANDING.md](docs/BRANDING.md).
* **Never lose footage.** Anything that moves or writes files must write to a temporary name first, roll back on failure, and (for renames) be undoable. Never delete a user's media.
* **Keyboard first.** Every frequent action needs a shortcut and a visible hint.
* **Say what is wrong and what to do.** Error text should read like a sentence a director can act on.
* **Test the logic you change.** Pure logic belongs in `server/lib` with a test in `test/`.

## Canvas changes

Canvas code is checked by hand against a scratch canvas of your own, never a production one. Use a throwaway canvas, a synthetic clip, and clean up the nodes you created (see how the layout ids `ltn:` / `ltn-cap:` make that easy).

## Pull requests

Describe what changed for the user, not just the code. Include a screenshot for UI changes (`scripts/screenshot.mjs`, run on the demo project, not on real footage).
