import { describe, it, expect } from "vitest";
import { registeredTools } from "./_helpers/registered-tools.js";
import { STRICT_ALLOWED, violationsOf } from "./_helpers/strict-schema.js";
import contract from "./strict-contract.json" with { type: "json" };

/**
 * Holds the registered tool schemas — and the ruleset in
 * `_helpers/strict-schema.ts` — to what a real strict-mode provider actually
 * accepts.
 *
 * #239 and #241 were the same defect found twice, one rule per release, each
 * one found by a user running the released extension. The walk added in #242
 * stopped those two rules from regressing, but it encoded our *reading* of
 * the ruleset, and that reading had already been wrong twice.
 *
 * So the source of truth is `strict-contract.json`: one probe schema per
 * keyword and per known rule, each sent to a real provider, each verdict
 * recorded with the provider's verbatim message. `scripts/strict-probe.ts`
 * writes it; `bun run probe:strict` runs it. The fixture names the endpoint
 * and the date it was recorded.
 *
 * The three tests below close both directions:
 *
 *   - a keyword the provider accepts cannot stay out of `STRICT_ALLOWED`,
 *     which is what makes putting `minimum`/`pattern` back into the tool
 *     schemas justifiable rather than a fourth guess, and
 *   - a schema the provider rejects cannot pass our walk, which is how a rule
 *     nobody has met yet fails here instead of in someone's session.
 */

/** Keywords the recorded run proves the provider accepts. */
const ACCEPTED_KEYWORDS = new Set(
  contract.cases.filter((c) => c.accepted).flatMap((c) => c.keywords),
);

describe("recorded provider contract", () => {
  it("was recorded against a real provider", () => {
    // Guards the fixture against being hand-edited into meaninglessness: an
    // empty or endpoint-less run would make every assertion below vacuous.
    expect(contract.endpoint).toMatch(/^https:\/\//);
    expect(contract.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(contract.cases.length).toBeGreaterThan(0);
  });

  it("was recorded against an endpoint that enforces strict mode", () => {
    // The control for the recording itself. Every `rule:*` probe breaks a rule
    // #239 or #241 already proved is real, so an endpoint that accepts one did
    // not validate anything — it ignores `strict`, or it is a gateway that
    // rewrote the schema before forwarding it. Without this, such a recording
    // would look like permission to relax the ruleset below.
    const rules = contract.cases.filter((c) => c.name.startsWith("rule:"));
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.filter((c) => c.accepted).map((c) => c.name)).toEqual([]);
  });

  it("agrees with STRICT_ALLOWED in both directions", () => {
    // Both directions, reported separately, because they mean opposite
    // things. `withheld` is a keyword the provider takes that we refuse —
    // the reason `minimum`/`pattern` are missing from the tool schemas, and
    // the evidence that would justify putting them back. `unproven` is a
    // keyword we allow with no recorded verdict behind it, which is how #239
    // and #241 shipped.
    const withheld = [...ACCEPTED_KEYWORDS].filter((k) => !STRICT_ALLOWED.has(k));
    const unproven = [...STRICT_ALLOWED].filter((k) => !ACCEPTED_KEYWORDS.has(k));
    expect({ withheld, unproven }).toEqual({ withheld: [], unproven: [] });
  });

  it.each(contract.cases.map((c) => [c.name, c.accepted, c.schema] as const))(
    "%s: our ruleset matches the recorded verdict",
    (_name, accepted, schema) => {
      const violations = violationsOf(schema);
      if (accepted) {
        // Stricter than the provider: we would reject a schema it takes.
        expect(violations).toEqual([]);
      } else {
        // Looser than the provider: this is the #239/#241 failure mode, a
        // rule the provider enforces and our walk does not know about.
        expect(violations.length).toBeGreaterThan(0);
      }
    },
  );
});

describe("tool parameter schemas", () => {
  it("registers the expected tools", () => {
    // Without this, an entrypoint that stopped registering anything would
    // make the per-tool cases below vanish rather than fail. Registration
    // order is index.ts's source order — websearch first, which is why it
    // is the tool Codex rejected first in #239 and #241.
    expect(registeredTools().map((t) => t.name)).toEqual(["websearch", "webfetch"]);
  });

  it.each(registeredTools().map((t) => [t.name, t.parameters] as const))(
    "%s satisfies OpenAI/Codex strict mode",
    (_name, parameters) => {
      expect(violationsOf(parameters)).toEqual([]);
    },
  );
});
