import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Required from vitest 4 on. `vi.spyOn` on an already-spied method now
    // returns the *existing* spy with its call history intact, where vitest 3
    // handed back a fresh one. Tests that re-spy in `beforeEach` (the
    // `console.warn` spies in extract/pdf) therefore accumulated counts across
    // tests and asserted on totals from earlier cases:
    //
    //   vitest 3.2.4 -> calls = 1, 1, 1
    //   vitest 4.1.10 -> calls = 1, 2, 3
    //
    // Restoring after each test puts the original method back, so the next
    // `spyOn` installs a clean spy. This is a global guarantee rather than an
    // afterEach in the two files that happen to need it today — the failure
    // mode is silent (assertions pass until a later test pushes the count up),
    // so it should not depend on remembering per file.
    restoreMocks: true,
  },
});
