# Working in this repo

## PR policy

- **Every PR must reference a pre-existing GitHub issue.** GitHub does not enforce this — open the issue first, link it from the PR.

## Branch naming

`<area>/<short-description>`, kebab-case. Examples: `websearch/region-filter`, `webfetch/textdecoder-windows-1250`, `chore/release-action`.

## Out of scope (deliberately rejected, do not propose)

- **Build step.** Pi loads raw `.ts` via jiti — no Webpack, Rollup, tsc emit, etc.
- **HTML→markdown npm libraries** (Turndown, etc.). Pandoc/w3m via subprocess is the design.
- **API-key / account-based search providers** (Tavily, Brave, Exa, Perplexity, Anthropic web_search, Ollama Web Search). Zero-key is the project's reason to exist.
- **Headless browsers, JS execution** (Playwright, Puppeteer, etc.). Shell-only constraint.
