// Minimal `ExtensionContext` stub for unit tests of tool `execute()` bodies
// that never read from the context. The webfetch and websearch tools accept
// `_ctx: ExtensionContext` and never touch it; constructing a faithful
// `ExtensionContext` (`ui`, `sessionManager`, `modelRegistry`, `model`,
// `getContextUsage`, ...) for every test would be a large pile of unused
// fakes. A `Proxy` that throws on any property read makes the contract
// explicit: if a future tool body starts dereferencing `ctx.foo` in a code
// path under test, the test fails loudly with the offending property name
// instead of `TypeError: Cannot read properties of undefined`.
//
// The single `as unknown as ExtensionContext` is the centralized assertion
// for this entire pattern across the test suite — it lives here, with this
// justification, instead of being scattered as `{} as any` at every call
// site.

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export function stubExtensionContext(): ExtensionContext {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- intentional: see file header. Centralized stub for tools whose execute() never reads ctx.
  const stub = new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(
          `stubExtensionContext: tool under test unexpectedly read ctx.${String(prop)}; ` +
            `provide a real fixture for this property or move the assertion out of execute()`,
        );
      },
    },
  ) as unknown as ExtensionContext;
  return stub;
}
