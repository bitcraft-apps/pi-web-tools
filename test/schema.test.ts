import { describe, it, expect } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerExtension from "../index.js";

/**
 * Guards the OpenAI/Codex schema contract from #239: those providers
 * validate every registered function schema before the turn starts and
 * reject any object schema without an explicit
 * `additionalProperties: false`, which kills the whole session rather
 * than a single call.
 *
 * Driven through the real registration entrypoint (`index.ts`) rather than
 * importing the two tools directly, so a tool added later is covered
 * without anyone remembering to extend this file.
 */
interface SchemaShapedTool {
  name: string;
  parameters: { additionalProperties?: unknown };
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

describe("tool parameter schemas", () => {
  it("registers the expected tools", () => {
    // Without this, an entrypoint that stopped registering anything would
    // make the per-tool cases below vanish rather than fail. Registration
    // order is index.ts's source order — websearch first, which is why it
    // is the tool Codex rejected first in #239.
    expect(registeredTools().map((t) => t.name)).toEqual(["websearch", "webfetch"]);
  });

  it.each(registeredTools().map((t) => [t.name, t.parameters] as const))(
    "%s declares additionalProperties: false",
    (_name, parameters) => {
      expect(parameters.additionalProperties).toBe(false);
    },
  );
});
