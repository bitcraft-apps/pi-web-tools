import { describe, it, expect } from "vitest";
import { registeredTools } from "./_helpers/registered-tools.js";
import { isSchemaNode, STRICT_ALLOWED, violationsOf } from "./_helpers/strict-schema.js";
import { MAX_RESPONSE_BYTES } from "../src/lib/headers.js";
import { REGION_PATTERN } from "../src/lib/ddgr.js";
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
 *   - a keyword the provider accepts cannot stay out of `STRICT_ALLOWED`.
 *     That is what made putting `minimum`, `maximum` and `pattern` back into
 *     the tool schemas (#248) evidence rather than a fourth guess, and
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
    // how `minimum`, `maximum` and `pattern` came to be missing from the tool
    // schemas between #242 and #248. `unproven` is a keyword we allow with no
    // recorded verdict behind it, which is how #239 and #241 shipped.
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

  it("states its bounds in the schema, not only in the prose (#248)", () => {
    // The other direction of the same argument. Every test above says what a
    // schema may *not* contain, so deleting a bound passes all of them —
    // which is exactly how #242 removed these without anything going red.
    // Pinning the keywords means the next strip has to be deliberate.
    //
    // Values, not just presence: `minimum: 2` on `max_chars` is what makes
    // paginate's surrogate-snap asymmetry an invariant, and
    // MAX_RESPONSE_BYTES - 1 is the last addressable offset. An off-by-one
    // here is a real behaviour change, not a cosmetic one.
    const byName = new Map(registeredTools().map((t) => [t.name, t.parameters]));
    // anyOf[0] is the non-null branch: optionality is required + nullable
    // (#241), so every bounded field is a two-branch union carrying its
    // constraint on the typed branch. Walked with the same `isSchemaNode`
    // guard the ruleset uses, so a shape change fails with the path that
    // broke rather than a `cannot read property of undefined`.
    const constrainedBranch = (tool: string, property: string): Record<string, unknown> => {
      const schema = byName.get(tool);
      const properties = isSchemaNode(schema) ? schema.properties : undefined;
      const field = isSchemaNode(properties) ? properties[property] : undefined;
      const branches = isSchemaNode(field) ? field.anyOf : undefined;
      const branch = Array.isArray(branches) ? branches[0] : undefined;
      if (!isSchemaNode(branch)) {
        throw new Error(`${tool}.${property} is not a nullable union with a typed first branch`);
      }
      return branch;
    };

    expect(constrainedBranch("webfetch", "max_chars").minimum).toBe(2);
    expect(constrainedBranch("webfetch", "offset")).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: MAX_RESPONSE_BYTES - 1,
    });
    // Same regex `buildDdgrArgs` re-checks, by construction rather than by a
    // second copy — see the note on REGION_PATTERN.
    expect(constrainedBranch("websearch", "region").pattern).toBe(REGION_PATTERN.source);
  });
});
