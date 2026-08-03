import { defineTool, formatSize, keyHint } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchAsMarkdown } from "./lib/pipeline.js";
import { MAX_CHARS_DEFAULT, MAX_CHARS_HARD_CAP, MAX_RESPONSE_BYTES } from "./lib/headers.js";
import { ensureText, type FormatterTheme } from "./lib/render.js";

// `additionalProperties: false` is not cosmetic: OpenAI/Codex providers
// validate every function schema up front and reject one that omits it
// ("'additionalProperties' is required to be supplied and to be false"),
// which kills the whole turn before the model runs — see #239. Every
// object in the parameter schema needs it; this schema is flat, so one
// options arg covers it. test/schema.test.ts guards it for all
// registered tools.
const webfetchSchema = Type.Object(
  {
    url: Type.String({ description: "Absolute http(s) URL to fetch." }),
    max_chars: Type.Optional(
      Type.Number({
        description: `Truncate output at N chars (default ${MAX_CHARS_DEFAULT}, hard cap ${MAX_CHARS_HARD_CAP}).`,
        default: MAX_CHARS_DEFAULT,
        // `minimum: 2` makes lib/paginate.ts's end-side surrogate-snap
        // asymmetry a true schema invariant rather than a "production
        // callers don't reach maxChars=1" assumption: at maxChars=1 the
        // snap would empty the slice, so `paginate` deliberately ships a
        // lone high surrogate instead — the only path that can desync the
        // half-open [offset, end) tiling. Schema rejects what runtime
        // would otherwise have to special-case.
        minimum: 2,
      }),
    ),
    offset: Type.Optional(
      // Type.Integer (not Type.Number) so schema validation rejects 1.5 /
      // negatives / out-of-range up front, before fetchAsMarkdown's runtime
      // throw. The runtime guard remains as defense-in-depth for callers
      // that bypass schema validation (e.g. direct fetchAsMarkdown imports).
      Type.Integer({
        minimum: 0,
        // -1 because the runtime past-end short-circuit makes
        // offset === MAX_RESPONSE_BYTES a no-op (always returns the
        // past-end marker, since total <= MAX_RESPONSE_BYTES). Single
        // source of truth: schema rejects what runtime would treat as
        // garbage.
        maximum: MAX_RESPONSE_BYTES - 1,
        description:
          "Character offset into the extracted markdown (default 0). When the previous fetch returned a `[TRUNCATED ... Re-call with offset=N ...]` footer, pass that N here to read the next chunk. There is no cache between calls — each paginated read re-fetches and re-extracts.",
        default: 0,
      }),
    ),
  },
  { additionalProperties: false },
);

export interface WebfetchToolDetails {
  url: string;
  /** Length of the LLM-facing markdown body in JS string units (not bytes). */
  chars: number;
  /**
   * UTF-8 byte length of the LLM-facing markdown body. Computed once in
   * `execute()` so the renderer is a pure lookup — no Buffer.byteLength on
   * every redraw. Optional because sessions persisted by older versions of
   * this tool didn't carry it; the renderer falls back to recomputing from
   * `body` when missing.
   */
  bytes?: number;
}

export interface WebfetchCallArgs {
  url?: string;
  max_chars?: number;
  offset?: number;
}

/**
 * Cap on rendered preview lines in the expanded view. Long pages are
 * trimmed with a `… +M more lines (full content was sent to the model)`
 * footer so the row never floods scrollback.
 *
 * 200 is a deliberate compromise: README/docs hit 1k–3k lines; 200 is
 * enough to skim structure (headings, first paragraph) without dwarfing
 * the surrounding chat. Bump if user feedback says "I keep expanding
 * twice"; lower if rows still feel oppressive at 200.
 *
 * Exported for the test that asserts the truncation footer math —
 * tying the test to the constant, not a magic number duplicate.
 */
export const WEBFETCH_PREVIEW_MAX_LINES = 200;

/**
 * Per-line character cap for the expanded preview. Bounds horizontal
 * blast radius the way `WEBFETCH_PREVIEW_MAX_LINES` bounds vertical:
 * a 200-line response where every line is 50KB (minified JSON, single-
 * line HTML that slipped past extraction) would still flood the
 * terminal without this. 500 fits a wide-terminal paragraph and most
 * "one log line per record" outputs; tune if real reports show it
 * cutting useful content. Lines over the cap are sliced with a single
 * … — the model still received the full content, see footer.
 */
export const WEBFETCH_PREVIEW_MAX_LINE_CHARS = 500;

/**
 * Compact display form of `url` for the collapsed result header:
 * `<host><pathname>`. Strips scheme (always http/https — see url-guard),
 * userinfo, query, and hash. Query is dropped because URLs routinely
 * carry secrets in `?token=...`, `?sig=...`, signed-request params, etc.,
 * and the collapsed header lands in chat scrollback / session exports.
 * The full URL (with query) is still shown in `renderCall` — that's the
 * user/LLM's own input, not derived display. Falls back to the raw
 * string when parsing fails so a malformed URL still renders something
 * recognizable instead of an empty header.
 */
function shortDisplayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Number of lines in `body` for the collapsed-header `~N lines` stat.
 * Empty body → 0 (rather than 1 from a naive split), so an error path
 * that hands an empty body to the formatter doesn't claim "~1 lines".
 */
function countLines(body: string): number {
  if (body.length === 0) return 0;
  return body.split("\n").length;
}

/**
 * Pure formatter for the webfetch tool call header.
 *
 * `max_chars` is shown muted only when the user (LLM) overrode the
 * default — default invocations stay compact. Mirrors
 * `formatWebsearchCall`'s convention.
 *
 * Security note: the URL is shown verbatim (including query string),
 * which mirrors the user/LLM's own input rather than derived display.
 * `shortDisplayUrl` strips `?...` from the *result* header to avoid
 * leaking secrets carried in query params (`?token=`, `?sig=`, signed
 * requests, etc.) into scrollback. The asymmetry is intentional: the
 * call header echoes what the agent already typed, the result header
 * is a new surface where redaction is cheap. Don't "fix" one to match
 * the other without re-reading both notes.
 */
export function formatWebfetchCall(
  args: WebfetchCallArgs | undefined,
  theme: FormatterTheme,
): string {
  const url = typeof args?.url === "string" ? args.url : "";
  let text = theme.fg("toolTitle", theme.bold("webfetch"));
  // Only emit the URL segment when we actually have one — otherwise the
  // header ends with a trailing space that's invisible on render but
  // shows up in copy/paste and snapshot diffs.
  if (url) text += " " + theme.fg("accent", url);
  // Show max_chars whenever the LLM explicitly passed a non-default value,
  // including 0 — `execute` will then truncate to 0 and the user needs to
  // see *why* the fetch came back empty. The default-value check keeps
  // headers compact for the common path.
  if (typeof args?.max_chars === "number" && args.max_chars !== MAX_CHARS_DEFAULT) {
    text += " " + theme.fg("muted", `max_chars=${args.max_chars}`);
  }
  // Mirror the max_chars convention: only show offset when the LLM passed
  // a non-default (i.e. paginated re-read), so the common single-shot
  // header stays compact. Issue #132.
  if (typeof args?.offset === "number" && args.offset !== 0) {
    text += " " + theme.fg("muted", `offset=${args.offset}`);
  }
  return text;
}

export interface FormatWebfetchResultInput {
  details: WebfetchToolDetails | undefined;
  /**
   * The LLM-facing markdown body (i.e. `result.content[0].text`).
   * Source of truth for both the collapsed `~lines` stat and the
   * expanded preview — not mirrored into `details` (see issue #100).
   * On the error path this is the error message, not a body.
   */
  body: string;
  expanded: boolean;
  isError: boolean;
  /** Used as the error message when `isError` is true. */
  errorText?: string;
  /** Pre-rendered "(press X to expand)" hint. Injected so tests don't depend on keybindings. */
  expandHint: string;
}

/**
 * Pure formatter for the webfetch tool result. See issue #100 for the
 * collapsed/expanded/error spec.
 */
export function formatWebfetchResult(
  input: FormatWebfetchResultInput,
  theme: FormatterTheme,
): string {
  const { details, body, expanded, isError, errorText, expandHint } = input;

  if (isError) {
    const msg = errorText && errorText.length > 0 ? errorText : "error";
    return theme.fg("error", `✗ webfetch: ${msg}`);
  }

  const display = details?.url ? shortDisplayUrl(details.url) : "";
  // Byte count is computed once in `execute()` and stashed on `details`
  // (see WebfetchToolDetails.bytes) so this renderer is a pure lookup —
  // no Buffer.byteLength on every redraw. Fall back to recomputing from
  // `body` when `details.bytes` is missing (older persisted sessions, or
  // the error path where there is no `details`). `chars` is deliberately
  // not used here — it's JS string length and undercounts non-ASCII
  // pages by ~half.
  // utf-8 is Buffer.byteLength's default encoding — omitted for clarity.
  const sizeBytes = details?.bytes ?? Buffer.byteLength(body);
  const lineCount = countLines(body);
  // No tilde: `lineCount` is an exact count of newline-separated segments
  // in the body we actually have. `body` may itself be truncated upstream
  // by `max_chars`, but that truncation is already reflected in `body` —
  // the count over what we hold is exact, not approximate.
  const stats = `(${formatSize(sizeBytes)}, ${lineCount} lines)`;
  const headerBody = display ? `✓ fetched ${display} ${stats}` : `✓ fetched ${stats}`;
  const header = theme.fg("success", headerBody);

  if (!expanded) {
    return `${header} (${expandHint})`;
  }

  if (lineCount === 0) return header;

  // Per-line cap: WEBFETCH_PREVIEW_MAX_LINES bounds vertical scrollback,
  // but a 200-line page where each line is 50KB (minified JSON, single-
  // line HTML that slipped past extraction) still floods the terminal
  // horizontally. 500 chars is plenty to skim a wrapped paragraph or a
  // shell-friendly JSON line; longer lines get an ellipsis so the user
  // knows content was elided for *this view*. Full content still went to
  // the model — see footer.
  const capLine = (line: string): string =>
    line.length > WEBFETCH_PREVIEW_MAX_LINE_CHARS
      ? line.slice(0, WEBFETCH_PREVIEW_MAX_LINE_CHARS) + "…"
      : line;
  const rawLines = body.split("\n");
  const lines = rawLines.map(capLine);
  if (lines.length <= WEBFETCH_PREVIEW_MAX_LINES) {
    return `${header}\n${lines.join("\n")}`;
  }
  const preview = lines.slice(0, WEBFETCH_PREVIEW_MAX_LINES).join("\n");
  const remaining = lines.length - WEBFETCH_PREVIEW_MAX_LINES;
  const footer = theme.fg(
    "muted",
    `… +${remaining} more lines (full content was sent to the model)`,
  );
  return `${header}\n${preview}\n${footer}`;
}

export const webfetchTool = defineTool<typeof webfetchSchema, WebfetchToolDetails>({
  name: "webfetch",
  label: "Web Fetch",
  // The description states capabilities and limits; behavioural advice lives
  // in `promptGuidelines` below. Keep it self-contained rather than deferring
  // to the guidelines: guidelines are appended to pi's *default* system
  // prompt, so a host that supplies its own prompt sees only this string.
  description:
    "Fetch a URL and return its main text content as markdown. HTML is converted via pandoc or w3m. If `trafilatura` or `rdrview` is on $PATH, runs a Reader-View-style extraction pre-pass to strip page chrome (nav/sidebar/footer), typically shrinking output 5–20× on chrome-heavy pages. Falls back transparently to the full page if no extractor is installed or extraction looks wrong. PDFs are supported when `pdftotext` (poppler) is on $PATH — text-layer only, so scanned PDFs return little or nothing — and are rejected when it is not installed. For documents larger than `max_chars`, re-call with the `offset` value reported in the truncation footer to read the next chunk. Cannot fetch images or other binary content. Cannot reach localhost or RFC1918 link-local addresses.",
  // Without this, pi omits custom tools from the "Available tools" section of
  // the default system prompt entirely — the tool is callable but never
  // advertised alongside the built-ins. One line, matching their phrasing.
  promptSnippet: "Fetch a URL and read its main content as markdown (HTML and PDF)",
  // Cost-shaped advice rather than capability, so it belongs here instead of
  // in the description: pagination is supported, it is just the expensive way
  // to read a document.
  promptGuidelines: [
    "`webfetch` has no cache: every paginated call re-fetches and re-extracts the whole document, and PDFs re-run pdftotext each time. Prefer a single call with a large `max_chars` over several `offset` reads.",
    "Use `webfetch` after `websearch` to read a promising result in full, or directly when the user supplies a URL.",
  ],
  // Ask the provider to constrain sampling to the parameter schema where it
  // can. "prefer" rather than "require" so providers without the capability
  // keep working unchanged — this is a reliability nudge, not a dependency.
  constrainedSampling: { type: "json_schema", strict: "prefer" },
  parameters: webfetchSchema,
  async execute(_id, params, _signal, _onUpdate, _ctx) {
    // Structural pass-through (not a cast): listing each field makes the
    // compiler catch schema/FetchInput drift here instead of relying on an
    // assertion to silently paper over a rename.
    const md = await fetchAsMarkdown({
      url: params.url,
      max_chars: params.max_chars,
      offset: params.offset,
    });
    return {
      content: [{ type: "text", text: md }],
      details: { url: params.url, chars: md.length, bytes: Buffer.byteLength(md, "utf-8") },
    };
  },

  renderCall(args, theme, context) {
    const text = ensureText(context.lastComponent);
    text.setText(formatWebfetchCall(args, theme));
    return text;
  },

  renderResult(result, options, theme, context) {
    const text = ensureText(context.lastComponent);
    const first = result.content[0];
    const bodyText = first && first.type === "text" ? first.text : "";
    text.setText(
      formatWebfetchResult(
        {
          details: result.details,
          body: bodyText,
          expanded: options.expanded,
          isError: context.isError,
          errorText: context.isError ? bodyText : undefined,
          expandHint: keyHint("app.tools.expand", "to expand"),
        },
        theme,
      ),
    );
    return text;
  },
});
