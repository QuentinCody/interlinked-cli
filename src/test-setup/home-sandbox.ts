// Test-worker HOME sandbox — closes the real-user-data write leak for the
// whole suite, including mutation runs.
//
// Why per-test-file `INTERLINKED_HOME` redirects are not enough (measured
// 2026-08-10): `globalCorpusPath()` is `INTERLINKED_HOME ?? homedir()`. A
// Stryker mutant that deletes the `??` left arm routes every corpus write to
// the REAL `~/.interlinked/findings-corpus.jsonl` while the redirected test
// passes — 1443 fixture rows (32% of the user's cross-repo corpus) accumulated
// this way, fingerprinted by `stryker_was_here` markers the mutants injected
// into fixture strings. Cooperative env seams break BY DESIGN under mutation;
// the defense must sit below the code being mutated.
//
// `os.homedir()` reads `$HOME` (libuv `uv_os_homedir`) per call, so pointing
// HOME at a per-worker tmp dir makes homedir() itself resolve into the
// sandbox. Subprocesses spawned by integration tests inherit the env, so they
// are covered too. No cleanup: the dirs are tiny and live under the OS tmp
// root, which the OS reclaims.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandboxHome = mkdtempSync(join(tmpdir(), "interlinked-test-home-"));
process.env.INTERLINKED_TEST_PROJECT_ROOT = process.cwd();
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome; // win32 homedir() source
// Deliberately NOT set: INTERLINKED_HOME. It is not a fake-home knob — it
// relocates the ENTIRE .interlinked data dir (config-paths.ts getConfigDir:
// INTERLINKED_HOME > {cwd}/.interlinked), so setting it suite-wide collapses
// every per-test-cwd activity/collection log into one shared dir and breaks
// cwd-scoped tests (218 failures when tried, 2026-08-10). Deleting it instead
// keeps the suite deterministic against ambient shell exports; tests that
// exercise the override set and restore it themselves.
delete process.env.INTERLINKED_HOME;

/** Exported for the regression pin; also handy for tests that want to assert
 *  against the sandbox root explicitly. */
export const TEST_SANDBOX_HOME = sandboxHome;
