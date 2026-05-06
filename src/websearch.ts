import { Type } from "@mariozechner/pi-ai";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { runDdgr } from "./lib/ddgr.js";

const LIMIT_DEFAULT = 8;
const LIMIT_MAX = 25;

export const websearchTool = defineTool({
  name: "websearch",
  label: "Web Search",
  description:
    "Search the web via DuckDuckGo. Returns up to N results with title, URL and short snippet. Use when you need current information from the internet that isn't in your training data, or to find URLs to fetch with `webfetch`.",
  parameters: Type.Object({
    query: Type.String({ description: "The search query (free-form text)." }),
    limit: Type.Optional(
      Type.Number({
        description: `Max number of results (default ${LIMIT_DEFAULT}, hard cap ${LIMIT_MAX}).`,
        default: LIMIT_DEFAULT,
      }),
    ),
  }),
  async execute(_id, params, _signal, _onUpdate, _ctx) {
    const limit = Math.min(Math.max(1, params.limit ?? LIMIT_DEFAULT), LIMIT_MAX);
    const results = await runDdgr(params.query, limit);
    const payload = { query: params.query, results };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      details: { count: results.length, query: params.query },
    };
  },
});
