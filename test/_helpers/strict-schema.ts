/**
 * The OpenAI/Codex strict function-calling ruleset, as this repo understands
 * it, plus a walk that reports every place a schema breaks it.
 *
 * Those providers validate every registered function schema *before* the turn
 * starts, so a violation kills the whole session rather than a single call —
 * and it kills it for every user of the released extension, not in CI. #239
 * and #241 were the same defect found twice, one rule per release
 * (`additionalProperties`, then `required`).
 *
 * The rules encoded here:
 *
 *   - every object node has `additionalProperties: false`
 *   - every object node lists *all* of `properties` in `required`
 *     (optionality is expressed as required + nullable, see the tool schemas)
 *   - no keyword outside `STRICT_ALLOWED` appears anywhere
 *
 * `test/schema.test.ts` holds this to recorded provider verdicts
 * (`test/strict-contract.json`, written by `scripts/strict-probe.ts`), in both
 * directions: a rule the provider enforces but this walk misses fails there,
 * and so does a keyword the provider accepts but `STRICT_ALLOWED` withholds.
 * So neither this set nor these rules may be edited on their own — change the
 * fixture first, by running the probe against a real provider.
 */

/**
 * Keywords a schema node may carry. Must equal the set of keywords
 * `test/strict-contract.json` records as accepted; `test/schema.test.ts`
 * asserts that equality. To change it, run `bun run probe:strict`.
 *
 * Every entry is a recorded acceptance, not a reading of the docs. The value
 * constraints below were absent until 2026-08-04, because #242 read them as
 * refused; the probe shows OpenAI takes all of them. What it refuses is
 * `allOf`, `oneOf` and `not`.
 */
export const STRICT_ALLOWED = new Set([
  // Structural.
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "anyOf",
  "items",
  "enum",
  "const",
  "$defs",
  "$ref",
  // Value constraints.
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "default",
  "title",
  "examples",
]);

export function isSchemaNode(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collects violations rather than asserting inline so one failure reports
 * every offending node at once — the whole point of this check is not to
 * learn about these one at a time. Paths are JSON-Pointer-ish
 * (`properties.offset.anyOf[0]`) so the message names the property.
 */
export function strictViolations(node: unknown, path: string, out: string[]): void {
  if (!isSchemaNode(node)) return;

  for (const key of Object.keys(node)) {
    if (!STRICT_ALLOWED.has(key)) {
      out.push(`${path || "<root>"}: unsupported keyword \`${key}\``);
    }
  }

  if (node.type === "object") {
    // Exactly `false`, which is stricter than the provider: measured
    // 2026-08-04, OpenAI accepts a schema-valued `additionalProperties` and
    // only refuses it absent or `true`. Every schema this package ships uses
    // `false`, so the narrower rule costs nothing and keeps the error message
    // it produces unambiguous.
    if (node.additionalProperties !== false) {
      out.push(`${path || "<root>"}: object without \`additionalProperties: false\``);
    }
    const properties = isSchemaNode(node.properties) ? node.properties : undefined;
    if (!properties) {
      out.push(`${path || "<root>"}: object without \`properties\``);
    } else {
      // Set comparison rather than a sorted deep-equal: order is irrelevant
      // to the provider, and reporting the missing/extra names is what a
      // reader needs. `required` may not carry names absent from
      // `properties` either — that is its own strict-mode rejection.
      const declared = Object.keys(properties);
      const required = Array.isArray(node.required) ? node.required.map(String) : [];
      const requiredSet = new Set(required);
      const missing = declared.filter((key) => !requiredSet.has(key));
      const extra = required.filter((key) => !(key in properties));
      if (missing.length > 0) {
        out.push(
          `${path || "<root>"}: \`required\` omits ${JSON.stringify(missing)} — every key in \`properties\` must be listed`,
        );
      }
      if (extra.length > 0) {
        out.push(
          `${path || "<root>"}: \`required\` lists ${JSON.stringify(extra)}, absent from \`properties\``,
        );
      }
    }
  }

  const prefix = path ? `${path}.` : "";
  if (isSchemaNode(node.properties)) {
    for (const [key, child] of Object.entries(node.properties)) {
      strictViolations(child, `${prefix}properties.${key}`, out);
    }
  }
  if (isSchemaNode(node.$defs)) {
    for (const [key, child] of Object.entries(node.$defs)) {
      strictViolations(child, `${prefix}$defs.${key}`, out);
    }
  }
  // allOf/oneOf are not in STRICT_ALLOWED (so their presence already fails),
  // but recursing into them keeps the report complete instead of stopping at
  // the container.
  for (const combinator of ["anyOf", "allOf", "oneOf"] as const) {
    const branches = node[combinator];
    if (Array.isArray(branches)) {
      branches.forEach((child, i) => {
        strictViolations(child, `${prefix}${combinator}[${i}]`, out);
      });
    }
  }
  if (Array.isArray(node.items)) {
    node.items.forEach((child, i) => {
      strictViolations(child, `${prefix}items[${i}]`, out);
    });
  } else if (isSchemaNode(node.items)) {
    strictViolations(node.items, `${prefix}items`, out);
  }
}

/** Every violation in `schema`, empty when it satisfies the ruleset. */
export function violationsOf(schema: unknown): string[] {
  const out: string[] = [];
  strictViolations(schema, "", out);
  return out;
}
