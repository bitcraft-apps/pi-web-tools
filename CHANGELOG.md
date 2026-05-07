# Changelog

## [0.2.0](https://github.com/bitcraft-apps/pi-web-tools/compare/pi-web-tools-v0.1.1...pi-web-tools-v0.2.0) (2026-05-07)


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
