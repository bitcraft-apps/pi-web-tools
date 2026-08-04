/**
 * Ask a real strict-mode provider which JSON Schema keywords and rules it
 * accepts, and write the answers to `test/strict-contract.json`.
 *
 * Why this exists (#243): #239 and #241 were the same defect found twice, one
 * rule per release, each one found by a user running the released extension.
 * `test/schema.test.ts` stopped those two rules from regressing, but it
 * encoded our *reading* of the ruleset. This script replaces the reading with
 * recorded verdicts, in both directions:
 *
 *   - a rule we do not know about yet shows up as a probe the provider
 *     rejects but our walk accepts, and
 *   - a keyword we withhold without cause shows up as a probe the provider
 *     accepts. That is what the first run found: `minimum`, `maximum` and
 *     `pattern` were accepted all along, and #248 put them back on this
 *     evidence rather than on a fourth reading of the docs.
 *
 * Hand-run, not part of `bun run test`: it needs a key and a network. Run it
 * again after you change a tool schema, or to refresh stale verdicts.
 *
 *   OPENAI_API_KEY=sk-... bun run probe:strict
 *
 * Environment:
 *   STRICT_PROBE_API_KEY   Sent as a bearer token. Falls back to
 *                          OPENAI_API_KEY, then OPENROUTER_API_KEY.
 *   STRICT_PROBE_ENDPOINT  Default https://api.openai.com/v1/responses
 *   STRICT_PROBE_MODEL     Default gpt-5
 *   STRICT_PROBE_EXTRA_BODY  JSON merged into every request body. For gateway
 *                          knobs that decide whether the schema reaches the
 *                          real validator, e.g. OpenRouter's
 *                          '{"provider":{"only":["openai"],"require_parameters":true}}'.
 *                          Recorded in the fixture, because it changes what
 *                          the verdicts mean.
 *
 * The request shape follows the endpoint path: `/chat/completions` gets the
 * Chat Completions shape, anything else gets the Responses shape. That is
 * what lets a gateway such as OpenRouter be probed:
 *
 *   STRICT_PROBE_ENDPOINT=https://openrouter.ai/api/v1/chat/completions \
 *   STRICT_PROBE_MODEL=openai/gpt-5 OPENROUTER_API_KEY=sk-or-... bun run probe:strict
 *
 * A gateway is only usable evidence if it forwards the schema unchanged and
 * surfaces the upstream rejection. The four `rule:*` probes are the control:
 * they encode rules we have already been burned by, so a run that reports
 * them as *accepted* proves nothing validated the schemas, and the fixture is
 * worthless. `test/schema.test.ts` fails on such a recording rather than
 * trusting it.
 *
 * The endpoint and the model go into the fixture. That provenance matters:
 * the OpenAI API is a close proxy for the `openai-codex` provider, not the
 * same validator, so a reader must be able to see which one gave the answers.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { registeredTools } from "../test/_helpers/registered-tools.js";
import { STRICT_ALLOWED } from "../test/_helpers/strict-schema.js";

const ENDPOINT = process.env.STRICT_PROBE_ENDPOINT ?? "https://api.openai.com/v1/responses";
const MODEL = process.env.STRICT_PROBE_MODEL ?? "gpt-5";
const FIXTURE = new URL("../test/strict-contract.json", import.meta.url);

/**
 * Extra top-level request fields. Parsed once, so a malformed value fails
 * before the run instead of turning every case into a rejection.
 */
const EXTRA_BODY: Record<string, unknown> = process.env.STRICT_PROBE_EXTRA_BODY
  ? JSON.parse(process.env.STRICT_PROBE_EXTRA_BODY)
  : {};

/** Chat Completions and Responses nest the schema differently. */
const API: "chat" | "responses" = new URL(ENDPOINT).pathname.endsWith("/chat/completions")
  ? "chat"
  : "responses";

/** Pause between requests. Keeps a 20-case run under the burst rate limit. */
const REQUEST_GAP_MS = 250;

interface ProbeCase {
  /** Stable identifier. Prefixed by what the case proves. */
  name: string;
  /**
   * Keywords this case proves, when the provider accepts it. Empty for cases
   * that prove a structural rule rather than a keyword.
   */
  keywords: string[];
  /** What we expect, so a surprise is visible in the run output. */
  expect: "accept" | "reject";
  schema: Record<string, unknown>;
}

/** A minimal object schema that satisfies every rule we currently know. */
function object(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/** One string property, no constraints. The baseline every probe builds on. */
const PLAIN_PROPERTY = { type: "string", description: "A probe property." };

/**
 * One case per keyword, each adding exactly that keyword to the baseline and
 * changing nothing else, so a rejection names one keyword and not a
 * combination.
 */
const KEYWORD_PROBES: Array<{
  keyword: string;
  /** Keywords the case proves, when it proves more than the one it is named for. */
  proves?: string[];
  property: Record<string, unknown>;
}> = [
  // Already in STRICT_ALLOWED. Probed so acceptance is recorded, not assumed.
  { keyword: "anyOf", property: { anyOf: [{ type: "string" }, { type: "null" }] } },
  { keyword: "enum", property: { type: "string", enum: ["a", "b"] } },
  { keyword: "const", property: { type: "string", const: "a" } },
  { keyword: "items", property: { type: "array", items: { type: "string" } } },
  // $defs and $ref travel in one case: a $ref with no target is its own
  // rejection, which would be evidence about neither keyword.
  {
    keyword: "$defs",
    proves: ["$defs", "$ref"],
    property: { $ref: "#/$defs/probe" },
  },

  // Withheld today. OpenAI's strict-mode examples use several of these, but
  // our reading of the docs has been wrong twice, so only a verdict counts.
  { keyword: "minimum", property: { type: "number", description: "d", minimum: 0 } },
  { keyword: "maximum", property: { type: "number", description: "d", maximum: 10 } },
  {
    keyword: "exclusiveMinimum",
    property: { type: "number", description: "d", exclusiveMinimum: 0 },
  },
  {
    keyword: "exclusiveMaximum",
    property: { type: "number", description: "d", exclusiveMaximum: 10 },
  },
  { keyword: "multipleOf", property: { type: "number", description: "d", multipleOf: 2 } },
  { keyword: "pattern", property: { type: "string", description: "d", pattern: "^[a-z]{2}$" } },
  { keyword: "format", property: { type: "string", description: "d", format: "date-time" } },
  { keyword: "minLength", property: { type: "string", description: "d", minLength: 1 } },
  { keyword: "maxLength", property: { type: "string", description: "d", maxLength: 8 } },
  {
    keyword: "minItems",
    property: { type: "array", description: "d", items: { type: "string" }, minItems: 1 },
  },
  {
    keyword: "maxItems",
    property: { type: "array", description: "d", items: { type: "string" }, maxItems: 4 },
  },
  { keyword: "default", property: { type: "string", description: "d", default: "a" } },
  { keyword: "title", property: { type: "string", description: "d", title: "Probe" } },
  { keyword: "examples", property: { type: "string", description: "d", examples: ["a"] } },
  { keyword: "allOf", property: { allOf: [{ type: "string" }] } },
  { keyword: "oneOf", property: { oneOf: [{ type: "string" }, { type: "number" }] } },
  { keyword: "not", property: { type: "string", description: "d", not: { const: "a" } } },
];

/** Probes for the two rules we already learned, plus the near miss of each. */
const RULE_PROBES: ProbeCase[] = [
  {
    name: "rule:additional-properties-absent",
    keywords: [],
    expect: "reject",
    // #239: the object carries no `additionalProperties` at all.
    schema: {
      type: "object",
      properties: { value: PLAIN_PROPERTY },
      required: ["value"],
    },
  },
  {
    name: "rule:additional-properties-true",
    keywords: [],
    expect: "reject",
    schema: {
      type: "object",
      properties: { value: PLAIN_PROPERTY },
      required: ["value"],
      additionalProperties: true,
    },
  },
  // A `rule:additional-properties-not-boolean` probe (`additionalProperties`
  // set to a schema rather than `false`) lived here briefly, to tell a gateway
  // that repairs the field apart from a provider that stopped enforcing it.
  // Measured 2026-08-04 against api.openai.com: OpenAI *accepts* it, so both
  // cases give the same answer and it discriminates nothing. Removed rather
  // than kept — `rule:additional-properties-absent` already detects a
  // repairing gateway (OpenAI rejects it, OpenRouter accepted it), and a probe
  // the provider accepts while our walk rejects would be a standing
  // contradiction in the fixture. The walk still demands exactly `false`,
  // which is stricter than OpenAI, on purpose.
  {
    name: "rule:required-omits-key",
    keywords: [],
    expect: "reject",
    // #241: `optional` is declared but left out of `required`.
    schema: {
      type: "object",
      properties: { value: PLAIN_PROPERTY, optional: PLAIN_PROPERTY },
      required: ["value"],
      additionalProperties: false,
    },
  },
  {
    name: "rule:nested-object-additional-properties-absent",
    keywords: [],
    expect: "reject",
    // The same rule one level down. Proves the provider walks the tree, which
    // is why our own check is a walk and not a root-level assertion.
    schema: object({
      nested: {
        type: "object",
        properties: { value: PLAIN_PROPERTY },
        required: ["value"],
      },
    }),
  },
];

/**
 * Probes for the *shape* the tool schemas emit, as opposed to the keywords
 * they use. A `keyword:minimum` acceptance proves the provider takes `minimum`
 * on a plain numeric property; it says nothing about the same keyword one
 * level down, inside an `anyOf` branch — which is where every bound in these
 * tools lives, because optionality is expressed as required + nullable (#241).
 *
 * Without these, a rejection of that placement would surface only as
 * `tool:webfetch` failing, with nothing naming the part of the schema that
 * caused it. `keywords: []` on purpose: the keyword cases already claim these
 * names, and a shape case proves a placement, not a keyword.
 *
 * Named `shape:`, not `rule:`, because `test/schema.test.ts` reads every
 * `rule:*` case as a probe that must have been *rejected* — they are the
 * control that proves the endpoint validated anything at all.
 */
const SHAPE_PROBES: ProbeCase[] = [
  {
    name: "shape:nullable-union-minimum",
    keywords: [],
    expect: "accept",
    // webfetch's `max_chars`.
    schema: object({
      value: {
        anyOf: [{ type: "number", minimum: 2 }, { type: "null" }],
        description: "A probe property.",
      },
    }),
  },
  {
    name: "shape:nullable-union-range",
    keywords: [],
    expect: "accept",
    // webfetch's `offset`: two bounds on an integer branch.
    schema: object({
      value: {
        anyOf: [{ type: "integer", minimum: 0, maximum: 10 }, { type: "null" }],
        description: "A probe property.",
      },
    }),
  },
  {
    name: "shape:nullable-union-pattern",
    keywords: [],
    expect: "accept",
    // websearch's `region`.
    schema: object({
      value: {
        anyOf: [{ type: "string", pattern: "^[a-z]{2}-[a-z]{2}$" }, { type: "null" }],
        description: "A probe property.",
      },
    }),
  },
];

function buildCases(): ProbeCase[] {
  const baseline: ProbeCase = {
    name: "baseline",
    // These five cannot be isolated: every probe schema needs all of them to
    // be a legal object schema in the first place. One case proves the set.
    keywords: ["type", "description", "properties", "required", "additionalProperties"],
    expect: "accept",
    schema: object({ value: PLAIN_PROPERTY }),
  };

  const keywordCases: ProbeCase[] = KEYWORD_PROBES.map(({ keyword, proves, property }) => {
    const schema = object({ value: property });
    if (JSON.stringify(property).includes("#/$defs/")) {
      schema.$defs = { probe: { type: "string", description: "A probe definition." } };
    }
    return {
      name: `keyword:${keyword}`,
      keywords: proves ?? [keyword],
      // `expect` is only what STRICT_ALLOWED says today, so a disagreement is
      // visible in the run output. For the withheld keywords, a disagreement
      // is the point of the run, not an error.
      expect: STRICT_ALLOWED.has(keyword) ? "accept" : "reject",
      schema,
    };
  });

  const toolCases: ProbeCase[] = registeredTools().map((tool) => ({
    name: `tool:${tool.name}`,
    keywords: [],
    expect: "accept",
    schema: tool.parameters,
  }));

  return [baseline, ...keywordCases, ...RULE_PROBES, ...SHAPE_PROBES, ...toolCases];
}

interface Verdict {
  accepted: boolean;
  status: number;
  /** Verbatim provider message. Null when the provider accepted the schema. */
  error: string | null;
}

const PROBE_FUNCTION = {
  name: "probe",
  description: "A schema probe. Never called.",
};

/**
 * One request carrying `schema` as its only tool.
 *
 * `tool_choice: "none"` keeps the run cheap: strict validation happens when
 * the request is validated, before any generation, so a bad schema returns
 * 400 without producing a single token.
 */
function requestBody(schema: Record<string, unknown>): Record<string, unknown> {
  if (API === "chat") {
    return {
      ...EXTRA_BODY,
      model: MODEL,
      messages: [{ role: "user", content: "ok" }],
      max_tokens: 16,
      tool_choice: "none",
      tools: [
        { type: "function", function: { ...PROBE_FUNCTION, parameters: schema, strict: true } },
      ],
    };
  }
  return {
    ...EXTRA_BODY,
    model: MODEL,
    input: "ok",
    max_output_tokens: 16,
    tool_choice: "none",
    tools: [{ type: "function", ...PROBE_FUNCTION, parameters: schema, strict: true }],
  };
}

/**
 * Statuses that answer the question this script asks. A schema the provider
 * refuses comes back as a request-validation error; anything else — 401, 404,
 * 429, 5xx — says nothing about the schema.
 */
const VERDICT_STATUSES = new Set([200, 400, 422]);

/** Thrown when a response cannot be read as a verdict. Aborts the run. */
class UnusableResponse extends Error {}

/** Send one probe and read what came back, or refuse to read it. */
async function probe(apiKey: string, schema: Record<string, unknown>): Promise<Verdict> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody(schema)),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new UnusableResponse(`cannot reach ${ENDPOINT}: ${reason}`);
  }

  const body: unknown = await response.json().catch(() => null);
  const message = errorMessage(body);

  // A 401 is not a verdict that the schema is bad, and neither is a 404 on the
  // model or a rate limit. Recording one as a rejection would write a fixture
  // full of fabricated evidence — and a run that fails this way fails on every
  // case at once, so the whole file would look like a strict provider.
  if (!VERDICT_STATUSES.has(response.status)) {
    throw new UnusableResponse(
      `HTTP ${response.status}${message ? `: ${message}` : ""} — not a schema verdict`,
    );
  }

  // A gateway may relay an upstream rejection inside a 200 body (OpenRouter
  // does). Reading only the status would record that as an acceptance, which
  // is the one mistake this script must not make.
  if (response.ok && message === null) {
    return { accepted: true, status: response.status, error: null };
  }
  return { accepted: false, status: response.status, error: message ?? `HTTP ${response.status}` };
}

/**
 * The provider's own message, verbatim, or null when the body carries none.
 *
 * A gateway may replace the upstream message with its own summary and put the
 * real one in `error.metadata` (OpenRouter says only "Provider returned
 * error"). Keep both: a fixture whose errors do not name the offending
 * keyword records that a rejection happened but not why, which is half the
 * evidence #243 asks for.
 */
function errorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  const error = body.error;
  // The Responses API carries `"error": null` on success, so the key being
  // present is not an error. Reading it as one turned every 200 into a
  // rejection and would have recorded a fixture claiming the provider
  // refuses everything we ship.
  if (error === null || error === undefined) return null;
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return JSON.stringify(error);

  const message =
    "message" in error && typeof error.message === "string" ? error.message : JSON.stringify(error);
  if ("metadata" in error && error.metadata !== undefined) {
    return `${message} — ${JSON.stringify(error.metadata)}`;
  }
  return message;
}

async function main(): Promise<void> {
  const apiKey =
    process.env.STRICT_PROBE_API_KEY ??
    process.env.OPENAI_API_KEY ??
    process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(
      "No key. Set STRICT_PROBE_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY. " +
        "This script needs a real provider key.",
    );
    process.exit(1);
  }

  const cases = buildCases();
  console.error(`Probing ${ENDPOINT} (${API}) with model ${MODEL} — ${cases.length} cases.`);

  const recorded = [];
  let surprises = 0;
  for (const probeCase of cases) {
    let verdict: Verdict;
    try {
      verdict = await probe(apiKey, probeCase.schema);
    } catch (error) {
      if (!(error instanceof UnusableResponse)) throw error;
      // Nothing is written. A partial or fabricated fixture is worse than no
      // fixture: the test suite would treat it as recorded evidence.
      console.error(`\nABORTED at ${probeCase.name}: ${error.message}`);
      console.error("No fixture written. Fix the request, then run again.");
      process.exit(1);
    }

    // The baseline is the schema shape both shipping tools already use. If a
    // provider refuses it, the request is wrong — wrong model, wrong API
    // shape — and every verdict after it would be noise.
    if (probeCase.name === "baseline" && !verdict.accepted) {
      console.error(`\nABORTED: the provider refused the baseline schema — ${verdict.error}`);
      console.error(
        "That is a broken request, not a strict ruleset. Check the model and the endpoint.\n" +
          "No fixture written.",
      );
      process.exit(1);
    }

    const expected = (verdict.accepted ? "accept" : "reject") === probeCase.expect;
    if (!expected) surprises += 1;
    console.error(
      `  ${verdict.accepted ? "accept" : "reject"} ${expected ? "     " : "  !  "} ${probeCase.name}` +
        (verdict.error ? ` — ${verdict.error}` : ""),
    );
    recorded.push({
      name: probeCase.name,
      keywords: probeCase.keywords,
      schema: probeCase.schema,
      accepted: verdict.accepted,
      status: verdict.status,
      error: verdict.error,
    });
    await new Promise((resolve) => setTimeout(resolve, REQUEST_GAP_MS));
  }

  const fixture = {
    endpoint: ENDPOINT,
    api: API,
    model: MODEL,
    extraBody: EXTRA_BODY,
    recordedAt: new Date().toISOString().slice(0, 10),
    cases: recorded,
  };
  const fixturePath = fileURLToPath(FIXTURE);
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  // `format:check` covers test/, so an unformatted fixture would turn a
  // correct recording into a red CI run. Format it here instead of leaving
  // that trap for whoever runs the probe.
  spawnSync(fileURLToPath(new URL("../node_modules/.bin/oxfmt", import.meta.url)), [fixturePath], {
    stdio: "ignore",
  });

  console.error(`\nWrote ${fixturePath}`);

  // The control. Each `rule:*` probe breaks a rule we have already been burned
  // by, so a run that accepts one did not validate anything: the endpoint
  // ignores `strict`, or a gateway rewrote the schema before forwarding it.
  // Say so loudly — a fixture that records permissiveness would relax the
  // ruleset in test/schema.test.ts and ship the next #239.
  const rules = recorded.filter((c) => c.name.startsWith("rule:"));
  const unenforced = rules.filter((c) => c.accepted);
  if (unenforced.length > 0) {
    const partial = unenforced.length < rules.length;
    console.error(
      `\nUNUSABLE RECORDING: ${unenforced.length} of ${rules.length} rule probes were accepted ` +
        `(${unenforced.map((c) => c.name).join(", ")}).\n` +
        (partial
          ? "Some rule probes were rejected and some were accepted. That is a gateway\n" +
            "rewriting the schema before it forwards it, not a lenient validator: the\n" +
            "rules it repairs for you can never be observed through it. Every verdict\n" +
            "here is suspect, including the ones that look right."
          : "Nothing validated these schemas. The endpoint ignores `strict`, so none of\n" +
            "the verdicts above are evidence.") +
        "\nDo not commit this fixture. Probe the provider directly.",
    );
  }

  if (surprises > 0) {
    // Not a failure. A surprise is the finding this script exists to produce:
    // reconcile STRICT_ALLOWED in test/schema.test.ts with the new verdicts.
    console.error(
      `${surprises} case(s) marked \`!\` disagree with what we assumed. ` +
        "Read them, then bring test/schema.test.ts in line with the fixture.",
    );
  }
}

await main();
