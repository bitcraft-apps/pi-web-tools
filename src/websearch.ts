import { Type } from "@mariozechner/pi-ai";
import { defineTool, keyHint } from "@mariozechner/pi-coding-agent";
import type { DdgrResult, SafeSearch } from "./lib/ddgr.js";
import { runDdgr } from "./lib/ddgr.js";
import { ensureText, type FormatterTheme } from "./lib/render.js";

/**
 * Wraps `s` in double quotes, escaping `"`, `\`, and C0 control chars
 * (incl. DEL). Unlike `JSON.stringify`, non-ASCII printable Unicode
 * passes through as-is, so `quote("привет")` renders readably in the
 * header instead of as `\uXXXX` sequences.
 */
function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"' || ch === "\\") {
      out += "\\" + ch;
    } else if (code < 0x20 || code === 0x7f) {
      out += "\\x" + code.toString(16).padStart(2, "0");
    } else {
      out += ch;
    }
  }
  return out + '"';
}

/**
 * Strips C0 control chars (0x00–0x1F), DEL (0x7F), and CSI escape
 * sequences (`ESC [ … final-byte`) from untrusted strings before they
 * hit the terminal. Result fields from `ddgr` are attacker-influenced
 * (a page title can contain `\x1b[2J` or other ANSI escapes); without
 * sanitization the expanded view would render them raw and let a
 * malicious page clear/repaint the user's screen.
 *
 * Only the ESC byte itself is required for CSI interpretation, so
 * dropping ESC is sufficient for *safety*. The CSI regex sweep is
 * cosmetic: it removes the leftover `[2J`-style parameter+final bytes
 * so the rendered title doesn't look like garbage. Tab and newline are
 * dropped too — the renderer composes its own layout and embedded
 * whitespace would break alignment.
 */
function sanitize(s: string): string {
  // CSI: ESC [ <params 0x30-0x3F>* <intermediates 0x20-0x2F>* <final 0x40-0x7E>
  // ESC byte injected via String.fromCharCode so the regex *source* never
  // contains a literal control char (oxlint's no-control-regex rule).
  const ESC = String.fromCharCode(0x1b);
  const csiStripped = s.replace(
    new RegExp(`${ESC}\\[[\\u0030-\\u003f]*[\\u0020-\\u002f]*[\\u0040-\\u007e]`, "g"),
    "",
  );
  let out = "";
  for (const ch of csiStripped) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code !== 0x7f) {
      out += ch;
    }
  }
  return out;
}

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
  /**
   * Full results array, included so renderResult is pure presentation
   * (no JSON.parse on content[0].text in the redraw path).
   *
   * Optional because sessions persisted before this field was added
   * deserialize without it; the renderer falls back to `count` then to 0.
   */
  results?: DdgrResult[];
  /**
   * @deprecated since 1.x — see #109. Read-only/legacy: only the
   * renderer's old-session fallback consumes this, and `execute()` no
   * longer writes it. New code MUST NOT set `count`; derive from
   * `results.length` instead. Kept solely so sessions persisted before
   * `results` existed still render the right header. Removal is
   * tracked in the linked issue and is non-breaking — the field is
   * renderer-internal and not part of the public API.
   */
  count?: number;
}

export interface WebsearchCallArgs {
  query: string;
  limit?: number;
  region?: string;
  safesearch?: SafeSearch;
}

/**
 * Pure formatter for the websearch tool call header. Keeps non-default
 * args muted so default invocations stay compact.
 *
 * Args explicitly set to their default value (e.g. `limit: 8`,
 * `safesearch: "moderate"`) are intentionally omitted from the header
 * — the goal is a compact line for the common case, and the default is
 * what the LLM gets if it omits the arg anyway. Callers that need to
 * see the literal arg list should inspect the raw tool call, not this
 * formatter's output.
 */
export function formatWebsearchCall(
  args: WebsearchCallArgs | undefined,
  theme: FormatterTheme,
): string {
  const query = typeof args?.query === "string" ? args.query : "";
  let text = theme.fg("toolTitle", theme.bold("websearch"));
  text += " " + theme.fg("accent", quote(query));

  const extras: string[] = [];
  // All three guards skip empty/zero values too — those only happen on
  // streaming partials and would otherwise render `limit=0` etc.
  if (typeof args?.limit === "number" && args.limit > 0 && args.limit !== LIMIT_DEFAULT) {
    extras.push(`limit=${args.limit}`);
  }
  if (typeof args?.region === "string" && args.region.length > 0) {
    extras.push(`region=${args.region}`);
  }
  if (
    typeof args?.safesearch === "string" &&
    args.safesearch.length > 0 &&
    args.safesearch !== SAFESEARCH_DEFAULT
  ) {
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
export function formatWebsearchResult(
  input: FormatWebsearchResultInput,
  theme: FormatterTheme,
): string {
  const { details, expanded, isError, errorText, expandHint } = input;

  if (isError) {
    const msg = errorText && errorText.length > 0 ? errorText : "error";
    return theme.fg("error", `✗ websearch: ${msg}`);
  }

  const query = details?.query ?? "";
  // Single source of truth: derive from results when present, fall back to
  // the legacy `count` field for sessions persisted before `results` existed.
  const count = details?.results?.length ?? details?.count ?? 0;

  if (count === 0) {
    return theme.fg("warning", `no results for ${quote(query)}`);
  }

  const noun = count === 1 ? "result" : "results";
  const header = theme.fg("success", `✓ ${count} ${noun} for ${quote(query)}`);

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
  // Blank line before every item — including the first — so the header
  // is visually separated from the list and items are separated from
  // each other. Intentional: header acts as the "zeroth" item.
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    // Sanitize ddgr-supplied fields: a malicious page title can carry
    // ANSI escapes that would otherwise be rendered raw by the TUI.
    const title = sanitize(r.title);
    const url = sanitize(r.url);
    const snippet = sanitize(r.snippet ?? "");
    lines.push("");
    lines.push(`${i + 1}. ${theme.fg("accent", title)}`);
    lines.push(`   ${theme.fg("dim", url)}`);
    if (snippet) {
      lines.push(`   ${snippet}`);
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
      query: params.query,
      results,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      details,
    };
  },

  renderCall(args, theme, context) {
    const text = ensureText(context.lastComponent);
    text.setText(formatWebsearchCall(args, theme));
    return text;
  },

  renderResult(result, options, theme, context) {
    const text = ensureText(context.lastComponent);
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
