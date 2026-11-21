# ORBIT

An Android music player with a modern pixel-art world, a build-free website UI, and native audio playback.

## Features

- YouTube search and audio resolution through NewPipeExtractor in Android.
- Native background playback, media notifications, headset controls, queue, shuffle, repeat, and sleep timer.
- Offline downloads and audio import through Android's file picker.
- Playlists, liked tracks, and local custom track names.
- Four original, bundled 24-second demo loops. These are samples, not a commercial music catalogue.
- Responsive desktop and mobile layouts with pixel artwork, animated effects, and reduced-motion support.

The website uses plain HTML, CSS, JavaScript, and ui-sdk web components. There is no frontend build step.

## Website preview

Serve `app/` with the lightweight Python preview server:

```sh
python3 scripts/vendor-ui-sdk.py
python3 scripts/preview-server.py 8080
```

Open `http://localhost:8080`. Browser playback uses HTML audio. Native background playback and Android offline storage require the APK. Browser YouTube streaming requires a compatible HTTPS Piped endpoint configured in Settings; no unreliable public server is selected by default.

The preview server supports HTTP byte ranges for audio seeking. Python's default `http.server` does not, so its audio can play but cannot seek. Any production static host should support byte ranges too.

ui-sdk loads from `https://ui-sdk.dev/web.js` and `https://ui-sdk.dev/web.css`. Its components register when their tags appear. Read https://ui-sdk.dev/web.md and the installed `ui-sdk` skill before adding components. The skill is in `.agents/skills/ui-sdk/`.

The APK serves those requested URLs from bundled SDK assets offline. The import map directs component and agent entries to that same packaged runtime in desktop browsers. `scripts/vendor-ui-sdk.py` verifies the pinned web and core packages with SHA-512. An SDK-only esbuild helper packages the omitted agent entry alongside its components; it never bundles or compiles Orbit's app. Generated SDK assets support the build-free website preview.

## Cloud APK build

No Android SDK, Gradle, or APK build runs on the laptop.

1. Push this project to a GitHub repository you control.
2. Open **Actions**, then **Build APK**, or use **Run workflow**.
3. Download the **Orbit** artifact and extract `Orbit.apk`.

The workflow generates Gradle files with `scripts/prepare-gradle.py`, bundles original audio and matching launcher icons, then builds the Android shell. JDK 17, Gradle 8.7, Android SDK 34, and Android 6+ are used. `scripts/cloud-build.sh` provides the same build for a Daytona sandbox.

The APK is a debug build for testing. A production release needs your own signing key. Do not disable security protections to bypass installation warnings.

## Source and limits

The app does not use YouTube credentials or the official YouTube player. NewPipeExtractor may fail when YouTube changes its service, rate-limits traffic, or restricts a video. Stream links expire; source video IDs are kept instead of treating resolved links as permanent.

Custom track names change your library, not the title on YouTube. Download only music you have permission to store. Browser downloads do not become Android offline-library items.

NewPipeExtractor is GPL-3.0-or-later. New Orbit code is licensed under GPL-3.0-or-later; see `COPYING` and `THIRD_PARTY.md`. Provide corresponding source when distributing an APK. Upstream template material retains its original ownership and terms.

The original shell is from [fazle-rabbi-dev's WebView APK template](https://github.com/fazle-rabbi-dev/Html-Css-Js-Web-View-Apk-Template). Its original README is preserved in `TEMPLATE.md`; claims in that file describe the upstream template, not Orbit's test results.
