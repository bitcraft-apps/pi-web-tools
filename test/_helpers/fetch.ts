// Fetch stubbing seam for webfetch tests.
//
// `doFetch` calls the *installed* undici's `fetch`, not Node's global one, so
// `vi.stubGlobal("fetch", ...)` no longer intercepts anything — a global stub
// would let the request escape to the real network. Tests install their fake
// through `__setFetchForTesting` instead.
//
// The cast lives here rather than at ~33 call sites: test fakes return the
// global `Response`, while the seam is typed as undici's `fetch`. At runtime
// both are WHATWG Responses and the consuming code only touches `status`,
// `statusText`, `headers.get`, `body` and `arrayBuffer` — all identical. The
// two types differ solely in the generic on `body`'s ReadableStream, which no
// test exercises. Same rationale as _helpers/context.ts and _helpers/theme.ts:
// one documented cast beats scattering `as any`.

import type { fetch as undiciFetch } from "undici";
import { __setFetchForTesting } from "../../src/webfetch.js";

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
