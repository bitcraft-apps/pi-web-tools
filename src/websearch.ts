import { Type } from "@mariozechner/pi-ai";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { runDdgr, type SafeSearch } from "./lib/ddgr.js";

const LIMIT_DEFAULT = 8;
const LIMIT_MAX = 25;
const SAFESEARCH_VALUES = ["off", "moderate", "strict"] as const;

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
    region: Type.Optional(
      Type.String({
        description:
          "DuckDuckGo region code, e.g. 'pl-pl', 'us-en', 'de-de'. Default: ddgr's built-in (us-en).",
      }),
    ),
    safesearch: Type.Optional(
      Type.Union(
        SAFESEARCH_VALUES.map((v) => Type.Literal(v)),
        {
          description:
            "Safe search level. 'off' disables it (passes --unsafe to ddgr). 'moderate' (default) and 'strict' both use ddgr's default safe-search behavior; ddgr does not distinguish them.",
          default: "moderate",
        },
      ),
    ),
  }),
  async execute(_id, params, _signal, _onUpdate, _ctx) {
    const limit = Math.min(Math.max(1, params.limit ?? LIMIT_DEFAULT), LIMIT_MAX);
    const safesearch = (params.safesearch ?? "moderate") as SafeSearch;
    const results = await runDdgr(params.query, limit, {
      region: params.region,
      safesearch,
    });
    const payload = { query: params.query, results };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      details: { count: results.length, query: params.query },
    };
  },
});
