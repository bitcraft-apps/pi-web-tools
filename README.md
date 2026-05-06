# @bitcraft/pi-web-tools

Shell-only web search and fetch tools for [pi.dev](https://pi.dev). **Zero API keys, zero accounts** — just `ddgr` + `pandoc`/`w3m` running locally.

## Tools

- **`websearch`** — DuckDuckGo search via [`ddgr`](https://github.com/jarun/ddgr). Returns up to 25 results with title, URL, snippet.
- **`webfetch`** — `fetch` + HTML→markdown via `pandoc` (preferred) or `w3m` (fallback). Auto-handles Cloudflare challenges via UA hack. Blocks SSRF (localhost/RFC1918).

## Install

```bash
# 1. System deps (one-time)
brew install ddgr pandoc        # macOS
# or: pip install ddgr; apt install pandoc w3m

# 2. Extension (from git for now; npm coming in v0.2)
pi install git:https://github.com/bitcraft-apps/pi-web-tools

# Or for local dev / hacking on the source:
pi install -e /path/to/pi-web-tools
```

After install, restart pi and the `websearch` and `webfetch` tools become available.

## Usage examples

In a pi session:

```
> Find me docs for Bun's native Sqlite API
[agent uses websearch → gets bun.sh URL → uses webfetch → reads docs]
```

You don't call them directly — pi's agent calls them when it needs.

## Limits and behavior

- `websearch`: default 8 results, hard cap 25. DuckDuckGo rate-limits ~10 req/min/IP. If you hit it, wait or use `webfetch` directly.
- `webfetch`: default 50k chars output, hard cap 200k. 5 MB response cap. 30s timeout. **Cannot fetch:** PDFs, images, video, audio, localhost, 127/8, 169.254/16. **Cannot render:** JS-heavy SPAs (you'll get an empty markdown).
- Non-Latin charsets may render as replacement characters; UTF-8 and Latin-1/Windows-1252 work correctly. Custom `TextDecoder` for `windows-1250` etc. is planned for v0.2.
- All operations are read-only and synchronous. No persistent state, no cache.

## Troubleshooting

- `ddgr not installed` → `brew install ddgr` or `pip install ddgr`
- `Need pandoc or w3m installed` → `brew install pandoc`
- `DuckDuckGo timed out (likely rate-limited)` → wait 1–2 min
- `Site requires JS, cannot fetch in shell-only mode` → site uses Cloudflare/JS-only; not solvable without headless browser, out of scope for this tool

## Development

```bash
# one-time, if you don't have bun:
#   macOS:        brew install bun
#   Linux / WSL:  curl -fsSL https://bun.sh/install | bash
# (or see https://bun.sh for other options)
git clone https://github.com/bitcraft-apps/pi-web-tools
cd pi-web-tools
bun install
bun run test                # unit tests, no network
bun run test:network        # integration tests (requires net)
```

**Lockfile:** this repo uses `bun.lock` only — no `package-lock.json`. `pi install git:...` runs `npm install` under the hood and resolves transitive deps fresh against the registry, so **end-user installs are not byte-reproducible** until we publish to npm in v0.2 (#5). This is acceptable for now because our peer deps are wildcard-pinned and we have no runtime deps that drift in breaking ways.

Hot-reload during dev:

```bash
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-web-tools
# in pi session: /reload
```

## License

MIT
