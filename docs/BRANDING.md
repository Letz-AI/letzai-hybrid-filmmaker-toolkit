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

## What is not included

The LetzAI logos, wordmark and app icon are **not** bundled. They are trademarks and the guidelines ask that the original files be used unchanged. Fonts are loaded from Google Fonts when online and fall back to the system font offline.

The top bar shows the name of the tool in text. If you are a LetzAI partner and want the official lockup in the header, download the kit from the [press page](https://www.letz.ai/press), and follow its clear-space and usage rules. Write to press@letz.ai before publishing anything that implies endorsement.

## For forks

You may restyle the interface freely under the MIT license. Please do not present a fork as an official LetzAI product, and do not use the LetzAI marks in a way that suggests it is one.
