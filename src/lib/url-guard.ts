// SSRF guard. Rejects URLs whose host resolves (by parsing alone, no DNS) to
// an address in any of the blocked ranges below. Operates on the URL string
// only — DNS rebinding (host validates as public, then resolves to internal IP
// at connect time) is a separate concern not handled here.
//
// Blocked v4 ranges:
//   127.0.0.0/8       loopback
//   10.0.0.0/8        RFC1918
//   172.16.0.0/12     RFC1918
//   192.168.0.0/16    RFC1918
//   169.254.0.0/16    link-local (incl. AWS IMDS 169.254.169.254)
//   100.64.0.0/10     CGNAT
//   0.0.0.0/8         "this network" / route-of-last-resort (incl. bare 0)
//   255.255.255.255   limited broadcast
//   224.0.0.0/4       multicast
//
// Blocked v6 ranges:
//   ::1/128           loopback
//   ::/128            unspecified
//   fc00::/7          unique local addresses (ULA)
//   fe80::/10         link-local
//   ::ffff:0:0/96     IPv4-mapped — re-checked against v4 rules
//   ::/96             IPv4-compatible (deprecated) — re-checked against v4 rules
//   2002::/16         6to4 — embedded v4 (bytes 2..5) re-checked against v4 rules
//   2001:0::/32       Teredo — embedded client v4 (bytes 12..15 XOR 0xff) re-checked
//
// IPv4 parsing follows the WHATWG URL "ipv4 parser" so non-canonical encodings
// the URL parser accepts (decimal `2130706433`, octal `0177.0.0.1`, hex
// `0x7f.0.0.1`, 1/2/3-part shorthand `127.1`, bare `0`) all normalize before
// the range check. A host that is not parseable as an IP is treated as a DNS
// name and only the literal-string blocklist applies.

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  // Common /etc/hosts loopback aliases that resolve to 127.0.0.1 / ::1 via DNS,
  // bypassing the IP-literal checks below.
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

// Parse one IPv4 part per WHATWG: 0x/0X → hex, leading 0 → octal, else decimal.
// Returns null on any malformed input (caller treats whole host as non-IPv4).
//
// Note: WHATWG URL Standard (2023+) actually *fails* IPv4 parsing on a part
// with a leading zero rather than interpreting it as octal. We deliberately
// interpret it as octal here: failing would fall through to the DNS-name
// branch and let `0177.0.0.1` slip past the SSRF guard. Interpreting (the
// pre-2023 behaviour, also what curl/wget do) is the safer SSRF choice.
function parseV4Part(part: string): number | null {
  if (part.length === 0) return null;
  let radix = 10;
  let s = part;
  if (s.length >= 2 && (s.startsWith("0x") || s.startsWith("0X"))) {
    radix = 16;
    s = s.slice(2);
    if (s.length === 0) return 0; // "0x" alone = 0 per WHATWG
    if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  } else if (s.length >= 2 && s.startsWith("0")) {
    radix = 8;
    s = s.slice(1);
    if (!/^[0-7]+$/.test(s)) return null;
  } else {
    if (!/^[0-9]+$/.test(s)) return null;
  }
  const n = parseInt(s, radix);
  return Number.isFinite(n) ? n : null;
}

// Parse host as IPv4 per WHATWG; returns 4 bytes or null.
function parseIPv4(host: string): Uint8Array | null {
  // Strip exactly one trailing dot (WHATWG "ends in a single U+002E").
  const h = host.endsWith(".") && !host.endsWith("..") ? host.slice(0, -1) : host;
  const parts = h.split(".");
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const n = parseV4Part(p);
    if (n === null) return null;
    nums.push(n);
  }
  // All but last part must be < 256. Last part holds the remaining bytes.
  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i]! > 255) return null;
  }
  const remaining = 4 - (nums.length - 1);
  const max = 256 ** remaining;
  if (nums[nums.length - 1]! >= max) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < nums.length - 1; i++) out[i] = nums[i]!;
  let tail = nums[nums.length - 1]!;
  for (let i = 3; i >= nums.length - 1; i--) {
    out[i] = tail & 0xff;
    tail = Math.floor(tail / 256);
  }
  return out;
}

// Parse host as IPv6; returns 16 bytes or null. Handles `::` expansion and
// trailing embedded IPv4 (e.g. `::ffff:127.0.0.1`). Strict: groups must be 1-4
// hex digits, max one `::`, exactly 8 groups after expansion (or 6 + embedded
// v4 = 8 effective).
function parseIPv6(host: string): Uint8Array | null {
  if (!host.includes(":")) return null;
  const doubleColonCount = (host.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;

  let head: string[];
  let tail: string[];
  if (doubleColonCount === 1) {
    const [h, t] = host.split("::");
    head = h === "" ? [] : h!.split(":");
    tail = t === "" ? [] : t!.split(":");
  } else {
    head = host.split(":");
    tail = [];
  }

  // Embedded IPv4 in the last group of `tail` (or `head` if no `::`).
  const lastList = tail.length > 0 ? tail : head;
  let embeddedV4: Uint8Array | null = null;
  if (lastList.length > 0 && lastList[lastList.length - 1]!.includes(".")) {
    const v4 = parseIPv4(lastList[lastList.length - 1]!);
    if (!v4) return null;
    embeddedV4 = v4;
    lastList.pop();
  }

  const totalGroups = head.length + tail.length + (embeddedV4 ? 2 : 0);
  if (doubleColonCount === 0 && totalGroups !== 8) return null;
  if (doubleColonCount === 1 && totalGroups >= 8) return null;

  const groups: number[] = Array<number>(8).fill(0);
  for (let i = 0; i < head.length; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(head[i]!)) return null;
    groups[i] = parseInt(head[i]!, 16);
  }
  const tailStart = 8 - tail.length - (embeddedV4 ? 2 : 0);
  for (let i = 0; i < tail.length; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(tail[i]!)) return null;
    groups[tailStart + i] = parseInt(tail[i]!, 16);
  }
  if (embeddedV4) {
    groups[6] = (embeddedV4[0]! << 8) | embeddedV4[1]!;
    groups[7] = (embeddedV4[2]! << 8) | embeddedV4[3]!;
  }

  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = (groups[i]! >> 8) & 0xff;
    out[i * 2 + 1] = groups[i]! & 0xff;
  }
  return out;
}

function isBlockedV4(b: Uint8Array): boolean {
  // 127.0.0.0/8 loopback
  if (b[0] === 127) return true;
  // 10.0.0.0/8
  if (b[0] === 10) return true;
  // 172.16.0.0/12
  if (b[0] === 172 && (b[1]! & 0xf0) === 16) return true;
  // 192.168.0.0/16
  if (b[0] === 192 && b[1] === 168) return true;
  // 169.254.0.0/16 link-local
  if (b[0] === 169 && b[1] === 254) return true;
  // 100.64.0.0/10 CGNAT
  if (b[0] === 100 && (b[1]! & 0xc0) === 64) return true;
  // 0.0.0.0/8 — incl. bare 0 / route-of-last-resort
  if (b[0] === 0) return true;
  // 255.255.255.255 limited broadcast
  if (b[0] === 255 && b[1] === 255 && b[2] === 255 && b[3] === 255) return true;
  // 224.0.0.0/4 multicast
  if ((b[0]! & 0xf0) === 0xe0) return true;
  return false;
}

function isBlockedV6(b: Uint8Array): boolean {
  // ::1 loopback or :: unspecified — both are 15 zero bytes followed by 0 or 1.
  let allZeroExceptLast = true;
  for (let i = 0; i < 15; i++) {
    if (b[i] !== 0) {
      allZeroExceptLast = false;
      break;
    }
  }
  if (allZeroExceptLast && (b[15] === 0 || b[15] === 1)) return true;

  // fc00::/7 ULA — first byte's top 7 bits == 0xfc >> 1 == 0b1111110
  if ((b[0]! & 0xfe) === 0xfc) return true;

  // fe80::/10 link-local — first 10 bits == 0b1111111010
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true;

  // ::ffff:0:0/96 IPv4-mapped — recheck against v4 rules.
  let mapped = true;
  for (let i = 0; i < 10; i++)
    if (b[i] !== 0) {
      mapped = false;
      break;
    }
  if (mapped && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedV4(b.slice(12));
  }

  // ::/96 IPv4-compatible (deprecated, but fold for safety).
  let v4compat = true;
  for (let i = 0; i < 12; i++)
    if (b[i] !== 0) {
      v4compat = false;
      break;
    }
  if (v4compat) return isBlockedV4(b.slice(12));

  // 2002::/16 6to4 — embedded v4 in bytes 2..5. Routes via 6to4 relay to the
  // embedded v4, so 2002:7f00:0001:: reaches 127.0.0.1.
  if (b[0] === 0x20 && b[1] === 0x02) {
    return isBlockedV4(b.slice(2, 6));
  }

  // 2001:0::/32 Teredo — client v4 in bytes 12..15, XOR'd with 0xff per RFC 4380.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) {
    const v4 = new Uint8Array(4);
    for (let i = 0; i < 4; i++) v4[i] = b[12 + i]! ^ 0xff;
    return isBlockedV4(v4);
  }

  return false;
}

export function validateUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported scheme: ${url.protocol}`);
  }

  // WHATWG URL accepts `http:///path` and shifts "path" into the host slot;
  // detect the empty-authority form on the raw input string before that lift.
  if (!url.hostname || /^[a-z][a-z0-9+.-]*:\/\/(\/|$|\?|#)/i.test(input)) {
    throw new Error(`Empty host in URL: ${input}`);
  }

  const host = stripBrackets(url.hostname).toLowerCase();

  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new Error(`Blocked host (SSRF guard): ${host}`);
  }

  // Try IPv6 first (only candidate if URL came in bracketed; URL strips
  // brackets in `hostname`, so an unbracketed v6 was already rejected by URL).
  // For unbracketed input, parseIPv6 still recognizes a colon-bearing string
  // belt-and-braces, but URL would normally have rejected it.
  const v6 = parseIPv6(host);
  if (v6) {
    if (isBlockedV6(v6)) throw new Error(`Blocked host (SSRF guard): ${host}`);
    return url;
  }

  const v4 = parseIPv4(host);
  if (v4) {
    if (isBlockedV4(v4)) throw new Error(`Blocked host (SSRF guard): ${host}`);
    return url;
  }

  // Not an IP literal — treat as DNS name. We cannot tell here whether DNS
  // will resolve to an internal address; that's the DNS-rebinding gap noted
  // in the module header. The literal-name blocklist (BLOCKED_HOSTNAMES) is
  // the only check that applies.
  return url;
}
