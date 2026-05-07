# Working in this repo

## PR policy

- **Every PR must reference a pre-existing GitHub issue.** GitHub does not enforce this — open the issue first, link it from the PR.
- **One PR = one issue.** If an issue can't be delivered in a single reviewable PR, split it into smaller issues first and open one PR per child issue. Don't bundle unrelated changes into a single PR just because they share a parent issue.
  - Signs an issue needs granulating: it lists multiple independent measures ("do A, B, C") or touches unrelated areas.
  - When granulating, open the child issues, link them from the parent, and convert the parent into a tracking issue (preserves context and links children).

## Branch naming

`<area>/<short-description>`, kebab-case. Examples: `websearch/region-filter`, `webfetch/textdecoder-windows-1250`, `chore/release-action`.

## Out of scope (deliberately rejected, do not propose)

- **Build step.** Pi loads raw `.ts` via jiti — no Webpack, Rollup, tsc emit, etc.
- **HTML→markdown npm libraries** (Turndown, etc.). Pandoc/w3m via subprocess is the design.
- **API-key / account-based search providers** (Tavily, Brave, Exa, Perplexity, Anthropic web_search, Ollama Web Search). Zero-key is the project's reason to exist.
- **Headless browsers, JS execution** (Playwright, Puppeteer, etc.). Shell-only constraint.

## Bar for new tools

Every registered tool's name, description, and schema is loaded into every agent
turn that imports this package. New tools are not free — they're a recurring
prompt-token cost paid by every user, including users who never invoke them.

Before proposing a new tool, in order:

1. Can existing primitives plus one sentence in the caller's prompt do it? — do nothing.
2. Can existing primitives do it but produce wasteful output? — improve the primitive with a sane default.
3. Is it specific to one site, API, or CLI? — belongs in a personal skill (`~/.pi/agent/skills/`) or a separate package, not here.

`webfetch` deliberately does not contain per-host routing inside this package —
no `if hostname === "github.com"` branches, and no autodetection shims like
"if `gh` is on PATH, reroute github.com URLs through it." The agent picks the
right CLI for the host; this package provides general primitives only.
