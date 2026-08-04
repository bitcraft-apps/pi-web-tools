## Summary

<!-- One or two sentences. What changed and why. -->

## Closes

Closes #<issue>
<!-- Per AGENTS.md: every PR should reference a pre-existing issue, one PR per issue. PRs without a linked issue may be closed for triage. -->

## Test plan

- [ ] `bun run test` passes
- [ ] `bun run typecheck` passes
- [ ] Manual verification: <what you ran, if applicable>
- [ ] Tool schema changed? Ran `bun run probe:strict`, committed `test/strict-contract.json`, and smoke-checked one `websearch` and one paginated `webfetch` on an `openai-codex` session (see AGENTS.md → Release checks)
