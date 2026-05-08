# Working in this repo

## PR policy

- **Every PR must reference a pre-existing GitHub issue.** GitHub does not enforce this — open the issue first, link it from the PR.
- **One PR = one issue.** If an issue can't be delivered in a single reviewable PR, split it into smaller issues first and open one PR per child issue. Don't bundle unrelated changes into a single PR just because they share a parent issue.
  - Signs an issue needs granulating: it lists multiple independent measures ("do A, B, C") or touches unrelated areas.
  - When granulating, open the child issues, link them from the parent, and convert the parent into a tracking issue (preserves context and links children).

## Branch naming

`<area>/<short-description>`, kebab-case. Examples: `websearch/region-filter`, `webfetch/textdecoder-windows-1250`, `chore/release-action`.

## Commit / PR title format

PRs are squash-merged. **The PR title is used verbatim as the squash commit subject**, so the PR title must itself be a valid [Conventional Commits](https://www.conventionalcommits.org/) subject. release-please reads these subjects to decide whether (and how) to cut the next release.

### Allowed types

Use only the types release-please recognizes. With this repo's default config (no `changelog-sections` override in `release-please-config.json`), the defaults apply:

`feat`, `fix`, `perf`, `revert`, `docs`, `style`, `chore`, `refactor`, `test`, `build`, `ci`

- `feat:` → minor bump, **Features** section
- `fix:` → patch bump, **Bug Fixes** section
- `perf:` → patch bump, **Performance Improvements** section
- `revert:` → patch bump, **Reverts** section
- `docs:`, `style:`, `chore:`, `refactor:`, `test:`, `build:`, `ci:` → patch bump if they appear alone, but **hidden from CHANGELOG by default** (won't produce an entry)
- `<type>!:` or a `BREAKING CHANGE:` footer → major bump

Note: `deps` is **not** a default release-please type. Dependabot PRs in this repo use `ci(deps): …` (type `ci`, scope `deps`), which is hidden from the changelog.

### Common mistake: unknown types produce no changelog entry and no version bump

A subject like `security(webfetch): ...` looks conventional but `security` isn't a recognized type, so release-please neither bumps the version nor records a changelog entry — even for user-visible fixes. Use `fix:` with a `security` scope instead, so the change lands in **Bug Fixes** and triggers a patch:

- ❌ `security(webfetch): re-validate URL on every redirect hop`
- ✅ `fix(security): re-validate URL on every redirect hop in webfetch`

(The trailing `(security)` annotation seen in some prior commits is a soft convention, not enforced by any lint or template.)

### Examples from this repo

- `feat(websearch): add region filter`
- `fix(webfetch): handle windows-1250 via TextDecoder`
- `ci(deps): bump googleapis/release-please-action from 4.4.1 to 5.0.0`
- `docs(agents): require one-issue-one-PR and document granulation`

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

## GitHub Actions naming

- **Filename:** kebab-case, named after purpose. Tool names are fine when the tool *is* the purpose (e.g. `release-please.yml`, `dependabot.yml`).
- **Workflow `name:`:** lowercase, kebab-case, mirrors the filename stem.
- **Job ID** (the YAML key): kebab-case, names the gate (e.g. `typecheck`, `publish-npm`).
- **Job `name:`:** omit unless it adds info beyond the ID. It adds info when the ID alone is ambiguous, e.g. matrix legs: `name: node ${{ matrix.node }}`.

Rationale: the workflow/job ID is what appears in PR required-status-check config and failure notifications, so it must match the filename and be greppable.
