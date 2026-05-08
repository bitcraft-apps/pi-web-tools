import { Type } from "@mariozechner/pi-ai";
import { defineTool, keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { DdgrResult, SafeSearch } from "./lib/ddgr.js";
import { runDdgr } from "./lib/ddgr.js";

const LIMIT_DEFAULT = 8;
const LIMIT_MAX = 25;
const SAFESEARCH_VALUES = ["off", "moderate", "strict"] as const;
const SAFESEARCH_DEFAULT: SafeSearch = "moderate";

const websearchSchema = Type.Object({
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
        "DuckDuckGo region code, e.g. 'pl-pl', 'us-en', 'de-de'. Default: ddgr's built-in (us-en). Invalid codes silently fall back to ddgr's default.",
      pattern: "^[a-z]{2}-[a-z]{2}$",
    }),
  ),
  safesearch: Type.Optional(
    Type.Union(
      SAFESEARCH_VALUES.map((v) => Type.Literal(v)),
      {
        description:
          "Safe search level. 'off' disables it (passes --unsafe to ddgr). 'moderate' (default) and 'strict' both use ddgr's default safe-search behavior; ddgr does not distinguish them.",
        default: SAFESEARCH_DEFAULT,
      },
    ),
  ),
});

export interface WebsearchToolDetails {
  query: string;
  count: number;
  /**
   * Full results array, included so renderResult is pure presentation
   * (no JSON.parse on content[0].text in the redraw path).
   *
   * Optional because sessions persisted before this field was added
   * deserialize without it; the renderer falls back to header-only.
   */
  results?: DdgrResult[];
}

export interface WebsearchCallArgs {
  query: string;
  limit?: number;
  region?: string;
  safesearch?: SafeSearch;
}

/**
 * Minimal Theme surface used by the pure formatters. The real Theme class
 * from @mariozechner/pi-coding-agent satisfies this structurally; tests
 * pass a no-op stub so they never depend on real ANSI output.
 */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/**
 * Pure formatter for the websearch tool call header. Keeps non-default
 * args muted so default invocations stay compact.
 */
export function formatWebsearchCall(args: WebsearchCallArgs | undefined, theme: ThemeLike): string {
  const query = typeof args?.query === "string" ? args.query : "";
  let text = theme.fg("toolTitle", theme.bold("websearch"));
  text += " " + theme.fg("accent", `"${query}"`);

  const extras: string[] = [];
  if (typeof args?.limit === "number" && args.limit !== LIMIT_DEFAULT) {
    extras.push(`limit=${args.limit}`);
  }
  if (typeof args?.region === "string" && args.region.length > 0) {
    extras.push(`region=${args.region}`);
  }
  if (typeof args?.safesearch === "string" && args.safesearch !== SAFESEARCH_DEFAULT) {
    extras.push(`safesearch=${args.safesearch}`);
  }
  if (extras.length > 0) {
    text += " " + theme.fg("muted", extras.join(" "));
  }
  return text;
}

export interface FormatWebsearchResultInput {
  details: WebsearchToolDetails | undefined;
  expanded: boolean;
  isError: boolean;
  /** First text content from the result, used as the error message when isError. */
  errorText?: string;
  /** Pre-rendered "(press X to expand)" hint. Injected so tests don't depend on keybindings. */
  expandHint: string;
}

/**
 * Pure formatter for the websearch tool result. See issue #99 for the
 * collapsed/expanded/empty/error spec.
 */
export function formatWebsearchResult(input: FormatWebsearchResultInput, theme: ThemeLike): string {
  const { details, expanded, isError, errorText, expandHint } = input;

  if (isError) {
    const msg = errorText && errorText.length > 0 ? errorText : "error";
    return theme.fg("error", `✗ websearch: ${msg}`);
  }

  const query = details?.query ?? "";
  const count = details?.count ?? 0;

  if (count === 0) {
    return theme.fg("warning", `no results for "${query}"`);
  }

  const noun = count === 1 ? "result" : "results";
  const header = theme.fg("success", `✓ ${count} ${noun} for "${query}"`);

  if (!expanded) {
    return `${header} (${expandHint})`;
  }

  // Expanded view. Old sessions persisted before details.results was
  // added render header-only rather than crashing.
  const results = details?.results;
  if (!results || results.length === 0) {
    return header;
  }

  const lines: string[] = [header];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    lines.push("");
    lines.push(`${i + 1}. ${theme.fg("accent", r.title)}`);
    lines.push(`   ${theme.fg("dim", r.url)}`);
    if (r.snippet) {
      lines.push(`   ${r.snippet}`);
    }
  }
  return lines.join("\n");
}

export const websearchTool = defineTool<typeof websearchSchema, WebsearchToolDetails>({
  name: "websearch",
  label: "Web Search",
  description:
    "Search the web via DuckDuckGo. Returns up to N results with title, URL and short snippet. Use when you need current information from the internet that isn't in your training data, or to find URLs to fetch with `webfetch`.",
  parameters: websearchSchema,
  async execute(_id, params, _signal, _onUpdate, _ctx) {
    const limit = Math.min(Math.max(1, params.limit ?? LIMIT_DEFAULT), LIMIT_MAX);
    const safesearch = params.safesearch ?? SAFESEARCH_DEFAULT;
    const results = await runDdgr(params.query, limit, {
      region: params.region,
      safesearch,
    });
    const payload = { query: params.query, results };
    const details: WebsearchToolDetails = {
      count: results.length,
      query: params.query,
      results,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      details,
    };
  },

  renderCall(args, theme, context) {
    // Narrowing Component → Text is the documented row-local component-reuse
    // pattern for renderCall/renderResult; see
    // node_modules/@mariozechner/pi-coding-agent/docs/extensions.md.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    text.setText(formatWebsearchCall(args, theme));
    return text;
  },

  renderResult(result, options, theme, context) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see renderCall above.
    const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    const first = result.content[0];
    const errorText = first && first.type === "text" ? first.text : undefined;
    text.setText(
      formatWebsearchResult(
        {
          details: result.details,
          expanded: options.expanded,
          isError: context.isError,
          errorText,
          expandHint: keyHint("app.tools.expand", "to expand"),
        },
        theme,
      ),
    );
    return text;
  },
});
