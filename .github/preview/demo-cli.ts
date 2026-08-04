// stdout runner for demo.tape — the thing VHS actually executes.
//
// There is no `websearch` / `webfetch` binary; the tools are pi
// extensions. This is the thinnest possible shim that runs the real
// implementations over the real network and prints the real rendered
// output, so the recorded frames are genuine tool output rather than a
// staged replay. demo.tape aliases the two subcommands to their tool
// names, so what you see typed in the video is what actually runs —
// including the query/URL argument, which is passed through rather
// than ignored in favour of a pinned constant.
//
// Renders come from render-websearch.ts / render-webfetch.ts, the same
// modules the fixture capture scripts use, whose pinned QUERY and URL
// are the defaults here — so the MP4 and the PNGs show the same query,
// URL, and colors.
//
// Run with: npx -y tsx .github/preview/demo-cli.ts <websearch|webfetch> [arg]
// (plain `node` won't strip the types, and won't map the `.js` specifiers
// below onto the `.ts` files on disk.)

import { renderWebsearch } from "./render-websearch.js";
import { renderWebfetch } from "./render-webfetch.js";

const USAGE = [
  "usage: demo-cli.ts websearch [query] [--limit N]",
  "       demo-cli.ts webfetch  [url]   [--max-chars N]",
  "       demo-cli.ts warm",
].join("\n");

const [command, ...rest] = process.argv.slice(2);

function die(message: string): never {
  console.error(`demo-cli.ts: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

/**
 * Positional value plus one optional numeric flag. `--limit` and
 * `--max-chars` are real parameters of the corresponding pi tools, not
 * demo-only knobs — the tape passes them so the recorded output fits
 * 720p, and what's typed on screen is a command a user could run.
 */
function parseArgs(flag: string): { value?: string; num?: number } {
  const flagIndex = rest.indexOf(flag);
  if (flagIndex === -1) {
    if (rest.length > 1) die(`${command} takes one positional argument, got ${rest.length}`);
    return { value: rest[0] };
  }
  // Reject `--limit 3 --limit 9` outright. Taking the first occurrence
  // and letting the leftovers fall through to the positional count below
  // reports "takes one positional argument, got 2", which points at the
  // wrong thing entirely.
  if (rest.lastIndexOf(flag) !== flagIndex) die(`${flag} given more than once`);

  const raw = rest[flagIndex + 1];
  if (raw === undefined) die(`${flag} requires a value`);
  const num = Number(raw);
  if (!Number.isInteger(num) || num <= 0) die(`${flag} expects a positive integer, got "${raw}"`);

  const positionals = rest.filter((_, i) => i !== flagIndex && i !== flagIndex + 1);
  if (positionals.length > 1) {
    die(`${command} takes one positional argument, got ${positionals.length}`);
  }
  return { value: positionals[0], num };
}

switch (command) {
  case "websearch": {
    const { value, num } = parseArgs("--limit");
    process.stdout.write((await renderWebsearch(value, num)) + "\n");
    break;
  }
  case "webfetch": {
    const { value, num } = parseArgs("--max-chars");
    const { text } = await renderWebfetch(value, num);
    process.stdout.write(text);
    break;
  }
  // `warm` exists so demo.tape can pay the npx/tsx cold-start cost
  // inside its Hide block — the static imports above mean reaching this
  // line has already resolved and compiled both render modules. Without
  // it the first visible command sits on a blank frame for a second or
  // two while tsx boots.
  case "warm":
    break;
  default:
    die(command === undefined ? "missing subcommand" : `unknown subcommand "${command}"`);
}
