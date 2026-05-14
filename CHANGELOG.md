# Changelog

## [1.3.1](https://github.com/bitcraft-apps/pi-web-tools/compare/v1.3.0...v1.3.1) (2026-05-14)


### Bug Fixes

* **which:** use POSIX `command -v` via sh for busybox/distroless support ([#155](https://github.com/bitcraft-apps/pi-web-tools/issues/155)) ([5890f06](https://github.com/bitcraft-apps/pi-web-tools/commit/5890f06f054ff8454e4a0a5ace05677d3d982c63))

## [1.3.0](https://github.com/bitcraft-apps/pi-web-tools/compare/v1.2.0...v1.3.0) (2026-05-14)


### Features

* **webfetch:** detect JS-only shell pages and surface a clear error ([#137](https://github.com/bitcraft-apps/pi-web-tools/issues/137)) ([70bd3b1](https://github.com/bitcraft-apps/pi-web-tools/commit/70bd3b198c295e02a060c5c1a0a2752f984e43f7))
* **webfetch:** follow &lt;link rel=alternate&gt; in &lt;head&gt; when extraction is thin ([#134](https://github.com/bitcraft-apps/pi-web-tools/issues/134)) ([e97b2e4](https://github.com/bitcraft-apps/pi-web-tools/commit/e97b2e44554020181ff39e818cfc22dcb6fe794a))
* **webfetch:** paginate output via offset for content past MAX_CHARS_HARD_CAP ([#138](https://github.com/bitcraft-apps/pi-web-tools/issues/138)) ([d2d506f](https://github.com/bitcraft-apps/pi-web-tools/commit/d2d506f0194507b7c888812f594ea57dad47f297))
* **webfetch:** prefer text/markdown via Accept negotiation ([#136](https://github.com/bitcraft-apps/pi-web-tools/issues/136)) ([177e829](https://github.com/bitcraft-apps/pi-web-tools/commit/177e829539b460f0aab01005742a75eeb7a91e3d))
* **webfetch:** strip base64 data: URI payloads from converter output ([#130](https://github.com/bitcraft-apps/pi-web-tools/issues/130)) ([55ae1ab](https://github.com/bitcraft-apps/pi-web-tools/commit/55ae1abf0c93dfba4b9ba7fb869bd5cded26f610))
* **webfetch:** surface cross-host redirects to the model ([#139](https://github.com/bitcraft-apps/pi-web-tools/issues/139)) ([c907d34](https://github.com/bitcraft-apps/pi-web-tools/commit/c907d34d460a129a9fb804db18a58552b7c902e4))

## [1.2.0](https://github.com/bitcraft-apps/pi-web-tools/compare/v1.1.0...v1.2.0) (2026-05-11)


### Features

* **webfetch:** pdf support via optional pdftotext ([#126](https://github.com/bitcraft-apps/pi-web-tools/issues/126)) ([b5ba5ec](https://github.com/bitcraft-apps/pi-web-tools/commit/b5ba5ec4d1d0ae9a4213c7843637aa2e877c9fc6))
* **websearch:** time filter parameter (d|w|m|y) ([#123](https://github.com/bitcraft-apps/pi-web-tools/issues/123)) ([98c5802](https://github.com/bitcraft-apps/pi-web-tools/commit/98c58025098681e1496a71676e25be29a41e7e45))


### Bug Fixes

* **webfetch:** honor Retry-After on 429/503 with one bounded retry ([#125](https://github.com/bitcraft-apps/pi-web-tools/issues/125)) ([c750c98](https://github.com/bitcraft-apps/pi-web-tools/commit/c750c98a668ff72a637dd8388654b2112d25ba00))

## [1.1.0](https://github.com/bitcraft-apps/pi-web-tools/compare/v1.0.0...v1.1.0) (2026-05-09)


### Features

* **webfetch:** custom TUI renderer (renderCall + renderResult) ([#111](https://github.com/bitcraft-apps/pi-web-tools/issues/111)) ([bca6a83](https://github.com/bitcraft-apps/pi-web-tools/commit/bca6a83b26d3579966556f7fe02e2a111619c84c))
* **websearch:** custom TUI renderer (renderCall + renderResult) ([#108](https://github.com/bitcraft-apps/pi-web-tools/issues/108)) ([e829a6e](https://github.com/bitcraft-apps/pi-web-tools/commit/e829a6e03cd48d31489cb64d86525a5a8af79c78))

## [1.0.0](https://github.com/bitcraft-apps/pi-web-tools/compare/v0.4.1...v1.0.0) (2026-05-08)


### ⚠ BREAKING CHANGES

* **engines:** require Node >=22 ([#77](https://github.com/bitcraft-apps/pi-web-tools/issues/77))

### Features

* **engines:** require Node &gt;=22 ([#77](https://github.com/bitcraft-apps/pi-web-tools/issues/77)) ([6413fbf](https://github.com/bitcraft-apps/pi-web-tools/commit/6413fbf4c0be9f8b39b0d2ecfc4d7c8000cbeb57))


### Bug Fixes

* **security:** re-check resolved IP at connect time to block DNS rebinding ([#64](https://github.com/bitcraft-apps/pi-web-tools/issues/64)) ([#89](https://github.com/bitcraft-apps/pi-web-tools/issues/89)) ([bbfd8da](https://github.com/bitcraft-apps/pi-web-tools/commit/bbfd8da03c76ac43079b1008787a2898050d317c))

## [0.4.1](https://github.com/bitcraft-apps/pi-web-tools/compare/v0.4.0...v0.4.1) (2026-05-07)


### Bug Fixes

* **security:** re-release pending fixes ([#60](https://github.com/bitcraft-apps/pi-web-tools/issues/60), [#61](https://github.com/bitcraft-apps/pi-web-tools/issues/61), [#62](https://github.com/bitcraft-apps/pi-web-tools/issues/62)) skipped by release-please ([#73](https://github.com/bitcraft-apps/pi-web-tools/issues/73)) ([a828e6c](https://github.com/bitcraft-apps/pi-web-tools/commit/a828e6cd2abdc37adb8d0757f175286be042a92f))
* **webfetch:** cap Cloudflare challenge-detection body read to 4 KB ([#63](https://github.com/bitcraft-apps/pi-web-tools/issues/63)) ([2e6fa27](https://github.com/bitcraft-apps/pi-web-tools/commit/2e6fa2705456c23a223ffb6cf8dc4698ba97a9f5))

## [0.4.0](https://github.com/bitcraft-apps/pi-web-tools/compare/v0.3.0...v0.4.0) (2026-05-07)


### Features

* **webfetch:** content-extraction pre-pass to strip page chrome ([#40](https://github.com/bitcraft-apps/pi-web-tools/issues/40)) ([aaca7b0](https://github.com/bitcraft-apps/pi-web-tools/commit/aaca7b087f9e86d9f2b6bca857c7b9a6e2d6a1c6))

## [0.3.0](https://github.com/bitcraft-apps/pi-web-tools/compare/v0.2.0...v0.3.0) (2026-05-07)


### Features

* **webfetch:** honor HTML &lt;meta charset&gt; declarations ([#24](https://github.com/bitcraft-apps/pi-web-tools/issues/24)) ([d0003d2](https://github.com/bitcraft-apps/pi-web-tools/commit/d0003d2965900f9548dd44e07cb34960eb20f273))
* **websearch:** expose region + safesearch params ([#27](https://github.com/bitcraft-apps/pi-web-tools/issues/27)) ([a17ab4d](https://github.com/bitcraft-apps/pi-web-tools/commit/a17ab4df8bcdda59f982931f03e7945c0cc9bbd1))


### Performance Improvements

* **webfetch:** memoize converter detection ([#26](https://github.com/bitcraft-apps/pi-web-tools/issues/26)) ([ae67089](https://github.com/bitcraft-apps/pi-web-tools/commit/ae6708926d50cedb70861701cd7c3c1a390e0656))

## [0.2.0](https://github.com/bitcraft-apps/pi-web-tools/compare/v0.1.1...v0.2.0) (2026-05-07)


### Features

* **ddgr:** subprocess wrapper and output parser ([2eabe58](https://github.com/bitcraft-apps/pi-web-tools/commit/2eabe583c83edfb3811c95245893a795c2dcf721))
* extension entry point — register websearch + webfetch ([6f9022d](https://github.com/bitcraft-apps/pi-web-tools/commit/6f9022d68830a22984ecd39282e5dd59eea09210))
* **headers:** browser UA + size constants ([940ad6b](https://github.com/bitcraft-apps/pi-web-tools/commit/940ad6bd27dda14a9c40dcb5a234fa2f49237bfc))
* **html2md:** pandoc/w3m auto-detect converter ([1b619fd](https://github.com/bitcraft-apps/pi-web-tools/commit/1b619fdba38221c8f77687bb734dc473d2a30f12))
* **url-guard:** SSRF block and URL validation ([8bcbb93](https://github.com/bitcraft-apps/pi-web-tools/commit/8bcbb93c68597855ff16c06624991e6ea78ed85d))
* **webfetch:** Cloudflare retry hack with UA=opencode ([9539e2b](https://github.com/bitcraft-apps/pi-web-tools/commit/9539e2b3632eaeb4a0f8fc3b378f68e450dcd985))
* **webfetch:** core fetch + CT routing + size cap ([8dc00f4](https://github.com/bitcraft-apps/pi-web-tools/commit/8dc00f42e28291e6077ef82cd135591aa207a7e8))
* **webfetch:** decode response body using declared charset ([#17](https://github.com/bitcraft-apps/pi-web-tools/issues/17)) ([33a8fde](https://github.com/bitcraft-apps/pi-web-tools/commit/33a8fde813e17ef3fb2b962845e31a1a3649cda3))
* **webfetch:** pi tool wrapper ([f35530c](https://github.com/bitcraft-apps/pi-web-tools/commit/f35530ced2370edaa948d384d7b163b70ab1740c))
* **websearch:** pi tool wrapper around ddgr ([73751bd](https://github.com/bitcraft-apps/pi-web-tools/commit/73751bdc02b8206fb2de11eb25ad61c13daad8ff))


### Bug Fixes

* **ddgr.test:** drop unused static imports (runDdgr loaded dynamically) ([694c3ca](https://github.com/bitcraft-apps/pi-web-tools/commit/694c3ca1d8629012e4219946660165282aa2cda5))
* **tsconfig:** include vitest.config.ts so TS server resolves vitest/config ([4975740](https://github.com/bitcraft-apps/pi-web-tools/commit/4975740c712093297a7727268e14fe66042909ed))
* **webfetch.test:** drop unused md binding in CF retry test ([c2dd8d8](https://github.com/bitcraft-apps/pi-web-tools/commit/c2dd8d800f2daa83da97851c07d49fabdf0a5b1e))
