# Branding

This tool is built for LetzAI users and follows the [LetzAI brand guidelines](https://www.letz.ai/brandguidelines) and the [design system](https://www.letz.ai/brandguidelines/design-system) (v2, September 2026).

## What is followed

* **Monochrome.** Ink and paper; the accent is ink itself. Colour comes from the footage. Green, red and amber appear only as feedback (success, error, warning). All values are the design system's tokens, mirrored in [`ui/css/tokens.css`](../ui/css/tokens.css), light and dark.
* **One filled action per surface.** Controls are ghosts at rest, tint on hover, stronger tint when chosen. No borders, underlines or grey blocks.
* **Solid surfaces.** A hairline and one shadow (`--elevation-*`), no glass.
* **Type.** Inter for the product UI. Space Grotesk 600 with tight tracking for the single welcome headline, never in capitals.
* **Controls.** 34 px high, 8 px radius, 13 px Inter 500; one 24-unit line icon set with a 1.5 stroke.
* **Popups** close in the same place: the X, last on the right, labelled “Close (Esc)”. Escape closes the top layer only.
* **Writing.** “LetzAI” in running text. “LETZ.AI” is reserved for the wordmark and is not used.

## The LetzAI L

The kit is published by LetzAI, so the top bar and the browser tab show the LetzAI **L**. The files in [`ui/img`](../ui/img) are the official ones, unchanged (as the guidelines ask): `letzai-l.png`, the black tile, on light surfaces, and `letzai-l-inverted.png`, the white tile, on dark ones. The wordmark and lockup are not bundled; if you need them, use the kit on the [press page](https://www.letz.ai/press) and its clear-space and usage rules.

Fonts are loaded from Google Fonts when online and fall back to the system font offline.

## For forks

You may restyle the interface freely under the MIT license. The LetzAI marks are not covered by that license. A fork must remove the L (`ui/img`, the brand in `ui/js/app.js`, the favicon in `ui/index.html`) and must not be presented as an official LetzAI product.
