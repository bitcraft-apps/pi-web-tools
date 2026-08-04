// The tool schemas as the agent host sees them. Read through the real
// registration entrypoint (`index.ts`) rather than by importing the two tools
// directly, so a tool added later is covered without anyone remembering to
// extend the caller.
//
// Shared by `test/schema.test.ts` and `scripts/strict-probe.ts`. The test
// asserts our schemas against recorded provider verdicts; the probe records
// those verdicts. If the two read the schemas differently, the evidence stops
// applying to the thing it claims to cover — so they read them here, once.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerExtension from "../../index.js";

export interface SchemaShapedTool {
  name: string;
  parameters: Record<string, unknown>;
}

/** Every tool `index.ts` registers, in source order. */
export function registeredTools(): SchemaShapedTool[] {
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
