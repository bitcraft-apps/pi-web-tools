/**
 * Helpers for asserting against `commandExists()` probe spawns in tests.
 *
 * `commandExists()` (src/lib/which.ts) invokes:
 *
 *   spawn("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "_", cmd], …)
 *
 * Tests need to (a) recognize those probe calls inside `mockImplementation`
 * to return canned exit codes, and (b) filter `mock.calls` to count probes
 * or read which command was probed. Both cases hardcoded `args[3]` until
 * this helper centralized the argv shape — now if the spawn shape ever
 * changes, only this file (and which.ts itself) need to update.
 */

/** A single entry from `vi.mocked(spawn).mock.calls`. */
export type SpawnCall = readonly [unknown, unknown, ...unknown[]];

/**
 * True if `(cmd, args)` matches a `commandExists()` probe spawn. If `target`
 * is given, also requires the probed binary to equal `target`.
 *
 * Use inside `mockImplementation((cmd, args) => …)`:
 *
 *   if (isWhichSpawn(cmd, args, "trafilatura")) return fakeChild("/x\n", 0);
 */
export function isWhichSpawn(cmd: unknown, args: unknown, target?: string): boolean {
  if (cmd !== "sh" || !Array.isArray(args) || args[0] !== "-c") return false;
  if (target === undefined) return true;
  return args[3] === target;
}

/**
 * Extracts the probed binary name from a `mock.calls` entry, or `undefined`
 * if the call isn't a `commandExists()` probe.
 *
 *   const probes = vi.mocked(spawn).mock.calls
 *     .map(whichSpawnTarget)
 *     .filter((t): t is string => t !== undefined);
 *   expect(probes).toEqual(["trafilatura"]);
 */
export function whichSpawnTarget(call: SpawnCall): string | undefined {
  const args = call[1];
  if (!isWhichSpawn(call[0], args) || !Array.isArray(args)) return undefined;
  const target: unknown = args[3];
  return typeof target === "string" ? target : undefined;
}
