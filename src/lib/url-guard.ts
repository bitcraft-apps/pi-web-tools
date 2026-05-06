const BLOCKED_HOSTS = new Set([
  "localhost",
  "0.0.0.0",
  "::",
  "::1",
]);

function isLoopbackV4(host: string): boolean {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isLinkLocalV4(host: string): boolean {
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host);
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
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

  if (!url.hostname || /:(\/\/)(\/|$)/.test(input)) {
    throw new Error(`Empty host in URL: ${input}`);
  }

  const host = stripBrackets(url.hostname).toLowerCase();
  if (BLOCKED_HOSTS.has(host) || isLoopbackV4(host) || isLinkLocalV4(host)) {
    throw new Error(`Blocked host (SSRF guard): ${host}`);
  }

  return url;
}
