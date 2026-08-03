// Fetch stubbing seam for webfetch tests.
//
// `doFetch` in src/lib/http.ts calls the *installed* undici's `fetch`, not
// Node's global one, so `vi.stubGlobal("fetch", ...)` no longer intercepts
// anything — a global stub would let the request escape to the real network.
// Tests install their fake through `__setFetchForTesting` instead.
//
// The cast lives here rather than at ~33 call sites: test fakes return the
// global `Response`, while the seam is typed as undici's `fetch`. At runtime
// both are WHATWG Responses and the consuming code only touches `status`,
// `statusText`, `headers.get`, `body` and `arrayBuffer` — all identical. The
// two types differ solely in the generic on `body`'s ReadableStream, which no
// test exercises. Same rationale as _helpers/context.ts and _helpers/theme.ts:
// one documented cast beats scattering `as any`.

import { vi } from "vitest";
import type { fetch as undiciFetch } from "undici";
import { __setFetchForTesting } from "../../src/lib/http.js";

/**
 * A test's stand-in for `fetch`. Arguments match undici's real signature so
 * fakes can forward to it; the return type stays loose because fakes resolve
 * global `Response` objects, which differ from undici's only in the generic
 * on `body`.
 */
export type FetchFake = (...args: Parameters<typeof undiciFetch>) => unknown;

/** Install `fn` as the fetch used by `doFetch` for the current test. */
export function stubFetch(fn: FetchFake): void {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- intentional: see file header.
  __setFetchForTesting(fn as unknown as Parameters<typeof __setFetchForTesting>[0]);
}

/** Restore the real undici fetch. Called from the file-level afterEach. */
export function restoreFetch(): void {
  __setFetchForTesting(null);
}

/**
 * Install a one-shot fetch fake that resolves a single `Response`. Shared by
 * the pipeline and tool test files, which both need it.
 */
export function mockFetchOnce(opts: {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}): ReturnType<typeof vi.fn> {
  const headers = new Headers(opts.headers ?? { "content-type": "text/html; charset=utf-8" });
  const status = opts.status ?? 200;
  const body = opts.body ?? "<h1>Hi</h1>";
  // Re-wrap any Uint8Array into a fresh `Uint8Array<ArrayBuffer>` so it lines
  // up with `BodyInit`. With recent @types/node + lib.dom, the default
  // `Uint8Array` type widens to `Uint8Array<ArrayBufferLike>` (allowing
  // SharedArrayBuffer), which `BodyInit` rejects. The copy is cheap and
  // semantically identical for these tests.
  const responseBody: BodyInit = typeof body === "string" ? body : new Uint8Array(body);
  // Returned so callers can assert on calls/args. `fetch` is no longer a
  // global stub, so `vi.mocked(fetch)` would inspect the wrong function.
  const mock = vi.fn().mockResolvedValueOnce(new Response(responseBody, { status, headers }));
  stubFetch(mock);
  return mock;
}
