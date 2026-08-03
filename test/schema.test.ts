import { describe, it, expect } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerExtension from "../index.js";

/**
 * Guards the OpenAI/Codex strict function-calling contract. Those providers
 * validate every registered function schema *before* the turn starts, so a
 * violation kills the whole session rather than a single call — and it kills
 * it for every user of the released extension, not in CI.
 *
 * #239 and #241 were the same defect found twice, one rule per release
 * (`additionalProperties`, then `required`). This walks the entire schema
 * tree and asserts the whole ruleset at once so the third rule fails here
 * instead of in someone's session:
 *
 *   - every object node has `additionalProperties: false`
 *   - every object node lists *all* of `properties` in `required`
 *     (optionality is expressed as required + nullable, see the tool schemas)
 *   - no keyword outside `STRICT_ALLOWED` appears anywhere
 *
 * The allowlist is deliberately narrower than what OpenAI's docs currently
 * permit (their strict examples do use `minimum`/`maximum`): our reading of
 * which keywords Codex's validator accepts has been wrong twice, so this
 * fails closed. Loosening it needs evidence from a real `openai-codex`
 * session, not another reading of the docs.
 *
 * Driven through the real registration entrypoint (`index.ts`) rather than
 * importing the two tools directly, so a tool added later is covered
 * without anyone remembering to extend this file.
 */
interface SchemaShapedTool {
  name: string;
  parameters: Record<string, unknown>;
}

function registeredTools(): SchemaShapedTool[] {
  const tools: SchemaShapedTool[] = [];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- intentional: the extension entrypoint only calls registerTool, so a faithful ExtensionAPI would be a pile of unused fakes (same rationale as _helpers/context.ts).
  const pi = {
    registerTool: (tool: SchemaShapedTool) => {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  registerExtension(pi);
  return tools;
}

/**
 * Keywords a schema node may carry. Structural (`properties`, `anyOf`, …)
 * plus the value constraints strict mode is documented to support and we
 * have actually shipped without a rejection. Everything else — `default`,
 * `minimum`, `maximum`, `pattern`, `format`, `minLength`, … — fails.
 */
const STRICT_ALLOWED = new Set([
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
]);

function isSchemaNode(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collects violations rather than asserting inline so one failure reports
 * every offending node at once — the whole point of this file is not to
 * learn about these one at a time. Paths are JSON-Pointer-ish
 * (`properties.offset.anyOf[0]`) so the message names the property.
 */
function strictViolations(node: unknown, path: string, out: string[]): void {
  if (!isSchemaNode(node)) return;

  for (const key of Object.keys(node)) {
    if (!STRICT_ALLOWED.has(key)) {
      out.push(`${path || "<root>"}: unsupported keyword \`${key}\``);
    }
  }

  if (node.type === "object") {
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
      const violations: string[] = [];
      strictViolations(parameters, "", violations);
      expect(violations).toEqual([]);
    },
  );
});
