← [README](../README.md) · see also: [AGENTS.md](../AGENTS.md)

# Release runbook (npm publish)

Read this when a release does not reach npm. The publish path runs a few times a
month, so nobody holds it in memory. Every step below is a command you can run.

## Normal flow

1. You merge a PR to `main`. Its title becomes the squash commit subject.
2. `release-please.yml` runs the `release-please` job. It opens or updates a
   release PR titled `chore(main): release <x.y.z>`.
3. You merge the release PR. release-please creates tag `v<x.y.z>` and a GitHub
   release. It sets the `release_created` output to `true`.
4. The `publish-npm` job runs in the same workflow. It publishes the tarball with
   `npm publish --access public --provenance`.

One package: `@bitcraft-apps/pi-web-tools`, versioned in the root
`package.json`. There is no build step. `jiti` loads the raw `.ts` on the
consumer side.

## Find the failed stage

Start here. Every diagnosis needs the run first.

```bash
gh run list --workflow release-please.yml --limit 10   # find the run
gh run view <run-id>                                   # which job and step failed
gh run view <run-id> --log-failed                      # output of the failed step only
```

Then answer these questions in order. Stop at the first `no`.

| Question | Command | Go to |
| --- | --- | --- |
| Is a release PR open? | `gh pr list --author app/bitcraft-release` | [No release PR](#no-release-pr) |
| Does the release PR have checks? | `gh pr view <n> --json statusCheckRollup` | [Release PR has no checks](#release-pr-has-no-checks) |
| Does the tag exist? | `gh release list --limit 5` | [Tag exists, npm does not have it](#tag-exists-npm-does-not-have-it) |
| Is the version on npm? | `npm view @bitcraft-apps/pi-web-tools versions --json` | [Publish step returned 4xx](#publish-step-returned-4xx) |

## No release PR

The `release-please` job succeeded but opened nothing. Two causes.

**Cause 1: no commit subject asks for a release.** release-please reads commit
subjects. `docs`, `style`, `chore`, `refactor`, `test`, `build` and `ci` bump a
patch but stay out of the changelog. A type outside the allowed list bumps
nothing at all. Check what landed:

```bash
git log --oneline origin/main -10
```

The allowed types live in `.github/workflows/pr-title.yml`. A type absent from
that list silently disables release-please for the PR. Use `fix:` with a scope
instead of inventing a type. See `AGENTS.md`, "Common mistake".

**Cause 2: the app token failed.** Read the `app-token` step:

```bash
gh run view <run-id> --log-failed
```

A failure here means the `bitcraft-release` GitHub App credentials broke. The
secrets `RELEASE_BOT_CLIENT_ID` and `RELEASE_BOT_PRIVATE_KEY` are org-level, not
repo-level. `gh secret list` on the repo returns nothing. Listing them needs org
admin rights:

```bash
gh secret list --org bitcraft-apps
```

The action input is `client-id`, not the deprecated `app-id` (#76). Confirm the
App is still installed on `bitcraft-apps/pi-web-tools`.

## Release PR has no checks

`gh pr view <n> --json statusCheckRollup` returns `[]`. The release commit would
merge untested. This is #28.

Cause: the release PR was authored by `GITHUB_TOKEN`. GitHub suppresses workflow
runs for events that a workflow's own `GITHUB_TOKEN` produced. App-authored
events do not hit that guard. Check the author:

```bash
gh pr view <n> --json author --jq .author.login   # must be app/bitcraft-release
```

If the author is `github-actions`, the `token:` input on
`googleapis/release-please-action` no longer receives
`steps.app-token.outputs.token`. Restore it. Do not merge the release PR until
`ci-gate` and `contract` report green.

## Tag exists, npm does not have it

The tag and the GitHub release exist. `publish-npm` failed. This is #32 and #42.
Read the failed step:

```bash
gh run view <run-id> --log-failed
```

Match the output against this table.

| Output | Cause | Fix |
| --- | --- | --- |
| `npm 10.9.7 < 11.5.1 — Trusted Publishing unsupported` | The `assert npm` guard fired. The corepack step did not install npm 11.5.1. | Read the corepack step output. npm below 11.5.1 cannot do Trusted Publishing. |
| `Cannot find module 'promise-retry'` | The npm bundled in the runner toolcache is broken and cannot upgrade itself (#42). | The workflow already avoids this with `corepack install -g`. Never restore `npm i -g npm@...`. |
| `npm error code E403` | See [Publish step returned 4xx](#publish-step-returned-4xx). | — |

The guards run in this order. Each one exists to fail loudly instead of falling
back to a token path that would drop provenance:

1. `install npm 11.5.1 via corepack` — Node 22 LTS bundles npm 10.9.x.
2. `scrub stale _authToken from .npmrc` — `setup-node` writes an empty token
   line. Removing it forces the OIDC path.
3. `assert npm >= 11.5.1` — the backstop if step 1 silently no-ops.
4. `publish to npm` — skips a version already on the registry.

## Publish step returned 4xx

| Error | Meaning | Action |
| --- | --- | --- |
| `403` and the version already exists | The skip guard did not run. npm refuses to overwrite a published version. | Confirm with `npm view @bitcraft-apps/pi-web-tools@<version> version`. If the version is live, the release is done. Close the run. |
| `403` and the version does not exist | OIDC gave npm no publish rights for this package. | See [Confirm the OIDC setup](#confirm-the-oidc-setup). |
| `401`, `ENEEDAUTH`, or a message about a missing token | npm took the token path, not the OIDC path. | Check that `id-token: write` is still on the `publish-npm` job. Check that the scrub step ran. |
| An OIDC or token-exchange error naming the provenance step | GitHub would not issue an ID token. | Confirm `id-token: write`. A fork or a `pull_request` trigger cannot mint one, but this job only runs on `push` to `main`. |

## Recover a failed publish

A re-run is safe. The publish step reads the version from `package.json` and asks
the registry first:

```bash
npm view "<name>@<version>" version   # if this resolves, the step skips
```

So a re-run can never publish twice and can never 403.

**If the failure was transient** (registry error, runner error), re-run only the
failed jobs:

```bash
gh run rerun <run-id> --failed
```

Use `--failed`. A full re-run runs `release-please` again. It finds the release
already created, sets `release_created` to `false`, and `publish-npm` skips.

**If the failure needs a workflow change**, that tag cannot reach npm through CI.
A re-run replays the workflow file from the original commit, so it repeats the
same failure. The workflow has no `workflow_dispatch` trigger, so you cannot
dispatch it by hand.

Do this instead:

1. Fix the workflow in a normal PR. Merge it to `main`.
2. The fix commit cuts the next patch version. That release publishes normally.
3. Leave the stuck version unpublished. Skipping a version number costs nothing.

This is the path taken after #42. `0.4.0` was published by hand and lost its
provenance. `0.4.1` shipped six hours later through the fixed workflow. Skipping
straight to `0.4.1` would have been the better call.

## Confirm the OIDC setup

Publishing needs three things at once. No `NPM_TOKEN` is involved.

1. **`id-token: write`** on the `publish-npm` job. It lets npm exchange the
   GitHub OIDC token for a short-lived publish credential.
2. **npm >= 11.5.1** in the runner. Older npm has no OIDC token exchange.
3. **A registered trusted publisher** on npm, matching org `bitcraft-apps`, repo
   `pi-web-tools`, workflow file `release-please.yml`.

Check the registration at
<https://www.npmjs.com/package/@bitcraft-apps/pi-web-tools/access>. The match is
exact and server-side. Renaming `release-please.yml` breaks publishing until you
update the registration.

Confirm a published version carries provenance:

```bash
npm view @bitcraft-apps/pi-web-tools@<version> dist.attestations
```

A CI publish returns a `provenance` predicate. An empty result means the version
was published by hand. Versions `0.2.0`, `0.3.0` and `0.4.0` are empty. Every
version from `0.4.1` has provenance.

## Never do these by hand

- **Never run `npm publish` from a laptop.** A local publish cannot mint an OIDC
  token, so that version loses its provenance attestation permanently. `0.4.0`
  is the standing proof (#42). Fix the workflow and let CI publish instead.
- **Never rename or move `release-please.yml`.** The npm trusted publisher is
  bound to that exact filename.
- **Never edit `.release-please-manifest.json` or the `version` in
  `package.json` by hand.** release-please owns both. A manual edit desynchronizes
  the tag, the changelog and the published version.
- **Never restore `NODE_AUTH_TOKEN` or an `NPM_TOKEN` secret.** Trusted
  Publishing replaced them (#21).

## Past failures

| Issue | Symptom | Section that resolves it |
| --- | --- | --- |
| #28 | Release PR arrives with zero status checks. | [Release PR has no checks](#release-pr-has-no-checks) |
| #32 | Publish fails on `npm 10.9.7 < 11.5.1`. | [Tag exists, npm does not have it](#tag-exists-npm-does-not-have-it) |
| #42 | Publish fails on `MODULE_NOT_FOUND promise-retry`. Tag exists, npm does not. | [Tag exists, npm does not have it](#tag-exists-npm-does-not-have-it) |
| #76 | `app-id` input deprecated in `create-github-app-token`. A warning then, a broken `app-token` step later. | [No release PR](#no-release-pr), cause 2 |
