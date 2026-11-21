# Credits and licenses

## Android shell

Orbit is based on [Html-Css-Js-Web-View-Apk-Template](https://github.com/fazle-rabbi-dev/Html-Css-Js-Web-View-Apk-Template) by fazle-rabbi-dev. Original source comments and attribution are retained. The upstream README identifies the template as MIT; upstream material retains its original terms.

## YouTube extraction

[NewPipeExtractor](https://github.com/TeamNewPipe/NewPipeExtractor) is GPL-3.0-or-later. It is a third-party extraction library, not an official YouTube SDK. Orbit's corresponding source includes the native adapter and the pinned dependency in `scripts/prepare-gradle.py`. Redistributors must supply the corresponding source and applicable dependency notices. GPL text is in `COPYING`.

NewPipe and InnerTune were studied as architecture references. Their branding and UI were not copied. No affiliation with those projects or YouTube is claimed.

## UI components

[ui-sdk](https://github.com/vercel-labs/ui) supplies build-free web-component behaviors and default styles. Pages retain the requested ui-sdk.dev script and stylesheet tags. Android packages `@ui-sdk/web` and `@ui-sdk/core` version `0.1.0-beta.13`, licensed under Apache-2.0, for offline controls. An SDK-only esbuild packaging helper adds the browser distribution's omitted agent entry and keeps its kernel shared with the components. Orbit's application remains unbundled. The upstream license and notices are copied into `app/ui-sdk/` during packaging. The installed skill retains its upstream terms.

## Artwork and audio

Orbit's artwork, logo, and four demo compositions were created for this project. `scripts/generate-audio.py` generates the original sample loops with the Python standard library. These samples do not contain third-party recordings. New Orbit source, artwork, and samples are offered under GPL-3.0-or-later.

The floating sound-island art was opened in [SpriteForge](https://www.spriteforge.tech/) for pixel editing. The app bundles its PNG, so runtime artwork does not depend on the editor.
