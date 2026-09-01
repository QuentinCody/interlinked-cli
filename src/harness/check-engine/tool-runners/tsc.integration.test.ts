// Behavioral unit tests for the TypeScript tool runners (sync + async).
//
// tsc.ts is structurally richer than the other runners because it owns the
// tsgo/tsc selection logic (`resolveTsgo` → `tscCommand`), the tsconfig
// walk-up (`findTsconfig`), and a standalone-file fallback. To exercise
// every branch deterministically we mock at the module edge so no real
// subprocess, filesystem, or module resolution is ever touched:
//   • node:child_process `spawnSync` — drives the sync runners + tsgo probe.
//   • node:fs `existsSync` — drives `findTsconfig` and the tsgo-bin check.
//   • node:module `createRequire` — drives `require.resolve` of tsgo.
//   • ../spawn-async.js `runProcessAsync` — drives the async runners.
// The real `parseTscOutput` / `filterResultsToFile` parsers run unmocked so
// we assert against actual parsed TS diagnostics, not re-stated fixtures.
//
// CRITICAL: tsc.ts caches its tsgo resolution in a module-level
// `_tsgoResolved`. Each scenario calls `loadTsc()` (which does
// `vi.resetModules()` + a fresh dynamic import) so the cache starts cold
// and the compiler-selection branch under test is the one that fires.

import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import type { RunProcessResult } from "../spawn-async.js";
import type { CheckScope, ToolRunnerInput } from "../types.js";

// --- Module-edge mocks (registered once; behavior swapped per test) ---------

const spawnSyncMock = vi.fn();
const existsSyncMock = vi.fn();
const requireResolveMock = vi.fn();
const runProcessAsyncMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	existsSync: (...args: unknown[]) => existsSyncMock(...args),
}));

// `createRequire(import.meta.url)` is called inside resolveTsgo; we return a
// shim whose `.resolve` is our spy. Throwing from it exercises the "tsgo not
// in CLI deps" fall-through.
vi.mock("node:module", () => ({
	createRequire: () => ({
		resolve: (...args: unknown[]) => requireResolveMock(...args),
	}),
}));

vi.mock("../spawn-async.js", () => ({
	runProcessAsync: (...args: unknown[]) => runProcessAsyncMock(...args),
}));

// --- Re-import helper: fresh module (cold tsgo cache) every scenario --------

type TscModule = typeof import("./tsc.js");
async function loadTsc(): Promise<TscModule> {
	vi.resetModules();
	return import("./tsc.js");
}

// --- Constants / fixtures ---------------------------------------------------

const PROJECT_ROOT = "/work/repo";
const TSGO_PKG_JSON = "/cli/node_modules/@typescript/native-preview/package.json";
const TSGO_BIN = "/cli/node_modules/@typescript/native-preview/bin/tsgo.js";

/** tsc/tsgo stdout for a file-level diagnostic (path is relative to tscRoot). */
function tscFileDiag(relPath = "src/app.ts"): string {
	return `${relPath}(12,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`;
}

/** tsc stdout for a project-level (no-file) diagnostic. */
function tscProjectDiag(): string {
	return "error TS2688: Cannot find type definition file for 'node'.";
}

function fileScope(overrides: Partial<CheckScope> = {}): CheckScope {
	return {
		projectRoot: PROJECT_ROOT,
		mode: "file",
		targetFile: `${PROJECT_ROOT}/src/app.ts`,
		filterToFile: true,
		...overrides,
	};
}

function projectScope(overrides: Partial<CheckScope> = {}): CheckScope {
	return { projectRoot: PROJECT_ROOT, mode: "project", ...overrides };
}

function input(scope: CheckScope, timeoutMs = 5_000): ToolRunnerInput {
	return { scope, timeoutMs };
}

/** Minimal SpawnSyncReturns; stdout widened to exercise the `|| ""` fallback. */
function spawnResult(
	over: Partial<Omit<SpawnSyncReturns<string>, "stdout" | "stderr">> & {
		stdout?: string | undefined;
		stderr?: string | undefined;
	},
): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: [],
		stdout: "",
		stderr: "",
		status: 0,
		signal: null,
		...over,
	} as SpawnSyncReturns<string>;
}

function procResult(over: Partial<RunProcessResult>): RunProcessResult {
	return { stdout: "", stderr: "", code: 0, timedOut: false, killed: false, ...over };
}

// --- existsSync routing helpers --------------------------------------------
// Each scenario declares which paths "exist". `findTsconfig` probes
// `<dir>/tsconfig.json`; `resolveTsgo` probes the tsgo bin path.

function existsForPaths(paths: Iterable<string>): (p: unknown) => boolean {
	const set = new Set(paths);
	return (p: unknown) => set.has(String(p));
}

/** tsconfig.json lives directly at PROJECT_ROOT. */
const TSCONFIG_AT_ROOT = `${PROJECT_ROOT}/tsconfig.json`;

// --- tsgo-selection wiring shorthands --------------------------------------

/**
 * Make `resolveTsgo()` pick the "node /abs/tsgo.js" (viaNode) path:
 * require.resolve succeeds, the bin exists, and `node tsgo.js --version`
 * exits 0. Returns nothing; mutates the shared mocks.
 *
 * `extraExists` lets the caller add tsconfig paths to the existsSync set.
 */
function wireTsgoViaNode(extraExists: string[] = []): void {
	requireResolveMock.mockReturnValue(TSGO_PKG_JSON);
	existsSyncMock.mockImplementation(existsForPaths([TSGO_BIN, ...extraExists]));
	// First spawnSync call is the tsgo --version probe → success.
	spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
		if (args?.includes("--version")) return spawnResult({ status: 0 });
		return spawnResult({ status: 0 });
	});
}

beforeEach(() => {
	spawnSyncMock.mockReset();
	existsSyncMock.mockReset();
	requireResolveMock.mockReset();
	runProcessAsyncMock.mockReset();
	// Safe default: nothing exists, tsgo unresolvable → tscCommand() = npx tsc.
	existsSyncMock.mockReturnValue(false);
	requireResolveMock.mockImplementation(() => {
		throw new Error("Cannot find module '@typescript/native-preview/package.json'");
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ===========================================================================
// resolveTsgo / tscCommand — compiler selection (exercised via runTsc)
// ===========================================================================

describe("compiler selection (resolveTsgo → tscCommand)", () => {
	it("uses `node /abs/tsgo.js` when tsgo resolves from CLI deps and --version exits 0", async () => {
		wireTsgoViaNode([TSCONFIG_AT_ROOT]);
		const { runTsc } = await loadTsc();
		runTsc(input(projectScope()));

		// Two spawnSync calls: [0] = tsgo --version probe, [1] = the real check.
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);
		const probe = spawnSyncMock.mock.calls[0] as [string, string[]];
		expect(probe[0]).toBe("node");
		expect(probe[1]).toEqual([TSGO_BIN, "--version"]);

		const check = spawnSyncMock.mock.calls[1] as [string, string[]];
		expect(check[0]).toBe("node");
		expect(check[1]).toEqual([TSGO_BIN, "--noEmit", "--pretty", "false"]);
	});

	it("falls back to `npx tsgo` when CLI-dep bin is absent but `npx tsgo --version` exits 0", async () => {
		// require.resolve succeeds but the bin file does NOT exist → first
		// branch skipped; npx probe succeeds → bin "tsgo", viaNode false.
		requireResolveMock.mockReturnValue(TSGO_PKG_JSON);
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT])); // no TSGO_BIN
		spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === "npx" && args?.[0] === "tsgo" && args?.includes("--version")) {
				return spawnResult({ status: 0 });
			}
			return spawnResult({ status: 0 });
		});
		const { runTsc } = await loadTsc();
		runTsc(input(projectScope()));

		const probe = spawnSyncMock.mock.calls[0] as [string, string[]];
		expect(probe[0]).toBe("npx");
		expect(probe[1]).toEqual(["tsgo", "--version"]);
		const check = spawnSyncMock.mock.calls[1] as [string, string[]];
		expect(check[0]).toBe("npx");
		expect(check[1]).toEqual(["tsgo", "--noEmit", "--pretty", "false"]);
	});

	it("falls back to `npx tsc` when require.resolve throws AND npx tsgo probe fails", async () => {
		// Default beforeEach already makes require.resolve throw + nothing exists.
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT]));
		spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
			if (args?.includes("--version")) return spawnResult({ status: 1 }); // npx tsgo probe fails
			return spawnResult({ status: 0 });
		});
		const { runTsc } = await loadTsc();
		runTsc(input(projectScope()));

		// [0] = npx tsgo --version (failed probe), [1] = npx tsc check.
		const probe = spawnSyncMock.mock.calls[0] as [string, string[]];
		expect(probe[0]).toBe("npx");
		expect(probe[1]).toEqual(["tsgo", "--version"]);
		const check = spawnSyncMock.mock.calls[1] as [string, string[]];
		expect(check[0]).toBe("npx");
		expect(check[1]).toEqual(["tsc", "--noEmit", "--pretty", "false"]);
	});

	it("falls back to `npx tsc` when the CLI-dep tsgo --version probe errors", async () => {
		// require.resolve ok + bin exists, but the version probe sets `error`
		// (status 0 but error truthy) → branch rejected; then npx tsgo probe
		// also fails → npx tsc.
		requireResolveMock.mockReturnValue(TSGO_PKG_JSON);
		existsSyncMock.mockImplementation(existsForPaths([TSGO_BIN, TSCONFIG_AT_ROOT]));
		spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === "node" && args?.includes("--version")) {
				return spawnResult({ status: 0, error: new Error("spawn node ENOENT") });
			}
			if (cmd === "npx" && args?.includes("--version")) {
				return spawnResult({ status: 1 });
			}
			return spawnResult({ status: 0 });
		});
		const { runTsc } = await loadTsc();
		runTsc(input(projectScope()));

		const check = spawnSyncMock.mock.calls.at(-1) as [string, string[]];
		expect(check[0]).toBe("npx");
		expect(check[1]).toEqual(["tsc", "--noEmit", "--pretty", "false"]);
	});

	it("falls back to `npx tsc` when the CLI-dep tsgo --version probe THROWS", async () => {
		// spawnSync itself throws inside the try → caught → npx fall-through.
		requireResolveMock.mockReturnValue(TSGO_PKG_JSON);
		existsSyncMock.mockImplementation(existsForPaths([TSGO_BIN, TSCONFIG_AT_ROOT]));
		spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === "node" && args?.includes("--version")) {
				throw new Error("spawnSync blew up");
			}
			if (cmd === "npx" && args?.includes("--version")) {
				return spawnResult({ status: 1 });
			}
			return spawnResult({ status: 0 });
		});
		const { runTsc } = await loadTsc();
		runTsc(input(projectScope()));

		const check = spawnSyncMock.mock.calls.at(-1) as [string, string[]];
		expect(check[0]).toBe("npx");
		expect(check[1]).toEqual(["tsc", "--noEmit", "--pretty", "false"]);
	});

	it("falls back to `npx tsc` when the npx tsgo probe THROWS", async () => {
		// require.resolve throws (skip branch 1); npx tsgo probe throws (skip
		// branch 2) → null → npx tsc.
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT]));
		spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === "npx" && args?.includes("--version")) {
				throw new Error("npx missing");
			}
			return spawnResult({ status: 0 });
		});
		const { runTsc } = await loadTsc();
		runTsc(input(projectScope()));

		const check = spawnSyncMock.mock.calls.at(-1) as [string, string[]];
		expect(check[0]).toBe("npx");
		expect(check[1]).toEqual(["tsc", "--noEmit", "--pretty", "false"]);
	});

	it("caches the tsgo resolution: a second runTsc on the same module re-probes 0 times", async () => {
		wireTsgoViaNode([TSCONFIG_AT_ROOT]);
		const { runTsc } = await loadTsc();
		runTsc(input(projectScope()));
		const callsAfterFirst = spawnSyncMock.mock.calls.length; // probe + check = 2
		expect(callsAfterFirst).toBe(2);

		runTsc(input(projectScope()));
		// Second run: cache hit → NO new --version probe, only the check call.
		const versionProbes = spawnSyncMock.mock.calls.filter((c) =>
			(c[1] as string[])?.includes("--version"),
		);
		expect(versionProbes).toHaveLength(1);
		expect(spawnSyncMock.mock.calls.length).toBe(3);
	});
});

// ===========================================================================
// findTsconfig — walk-up behavior (exercised via runTsc)
// ===========================================================================

describe("findTsconfig (walk-up)", () => {
	it("walks up parent directories to locate tsconfig.json (project mode)", async () => {
		// tsconfig is two levels above the deep projectRoot.
		const deepRoot = "/work/repo/packages/app/src";
		const tsconfigDir = "/work/repo/packages";
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		existsSyncMock.mockImplementation(existsForPaths([`${tsconfigDir}/tsconfig.json`]));
		spawnSyncMock.mockImplementation((_c: string, args: string[]) => {
			if (args?.includes("--version")) return spawnResult({ status: 1 });
			return spawnResult({ status: 1, stdout: tscFileDiag() });
		});
		const { runTsc } = await loadTsc();
		runTsc(input(projectScope({ projectRoot: deepRoot })));

		// The real check ran with cwd = the directory that had tsconfig.json.
		const check = spawnSyncMock.mock.calls.at(-1) as [
			string,
			string[],
			{ cwd: string },
		];
		expect(check[2].cwd).toBe(tsconfigDir);
	});

	it("returns [] (no spawn beyond probe) for a project-mode scope with no tsconfig anywhere", async () => {
		existsSyncMock.mockReturnValue(false); // no tsconfig at any level
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		spawnSyncMock.mockImplementation(() => spawnResult({ status: 1 })); // npx tsgo probe fails
		const { runTsc } = await loadTsc();
		const out = runTsc(input(projectScope()));
		expect(out).toEqual([]);
		// Only the tsgo --version probe should have run — never the tsc check.
		const checkCalls = spawnSyncMock.mock.calls.filter(
			(c) => !(c[1] as string[])?.includes("--version"),
		);
		expect(checkCalls).toHaveLength(0);
	});

	it("gives up after exactly 5 levels of walk-up without reaching filesystem root", async () => {
		// A path deep enough that 5 iterations of dirname() never reach "/"
		// (so the loop exhausts its bound rather than the parent===dir guard),
		// and no tsconfig exists at any level → the post-loop `return null`.
		const deepRoot = "/a/b/c/d/e/f/g/h/src";
		existsSyncMock.mockReturnValue(false); // no tsconfig at any probed dir
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		spawnSyncMock.mockImplementation(() => spawnResult({ status: 1 }));
		const { runTsc } = await loadTsc();
		// project mode + no tsconfig → []; the point is exercising the loop's
		// natural exhaustion (line 24) without spawning the compiler.
		expect(runTsc(input(projectScope({ projectRoot: deepRoot })))).toEqual([]);
		// existsSync probed tsconfig.json exactly 5 times (once per level).
		const tsconfigProbes = existsSyncMock.mock.calls.filter((c) =>
			String(c[0]).endsWith("tsconfig.json"),
		);
		expect(tsconfigProbes).toHaveLength(5);
		const checkCalls = spawnSyncMock.mock.calls.filter(
			(c) => !(c[1] as string[])?.includes("--version"),
		);
		expect(checkCalls).toHaveLength(0);
	});
});

// ===========================================================================
// runTsc (sync) — project mode
// ===========================================================================

describe("runTsc (sync) — project mode", () => {
	it("parses file-level diagnostics across the whole project (no filtering)", async () => {
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT]));
		spawnSyncMock.mockImplementation((_c: string, args: string[]) => {
			if (args?.includes("--version")) return spawnResult({ status: 1 });
			return spawnResult({ status: 1, stdout: tscFileDiag("src/other.ts") });
		});
		const { runTsc } = await loadTsc();
		const out = runTsc(input(projectScope()));
		expect(out).toEqual([
			{
				tool: "tsc",
				severity: "error",
				file: "src/other.ts",
				line: 12,
				column: 5,
				message:
					"TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
				ruleId: "TS2345",
			},
		]);
	});

	it("reads diagnostics from stderr too (stdout empty → stderr concatenated)", async () => {
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT]));
		spawnSyncMock.mockImplementation((_c: string, args: string[]) => {
			if (args?.includes("--version")) return spawnResult({ status: 1 });
			return spawnResult({ status: 1, stdout: "", stderr: tscProjectDiag() });
		});
		const { runTsc } = await loadTsc();
		const out = runTsc(input(projectScope()));
		expect(out).toEqual([
			{
				tool: "tsc",
				severity: "error",
				file: "tsconfig.json",
				line: 0,
				message: "TS2688: Cannot find type definition file for 'node'.",
				ruleId: "TS2688",
			},
		]);
	});

	it("returns [] cleanly on a passing project (status 0, empty output)", async () => {
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT]));
		spawnSyncMock.mockImplementation((_c: string, args: string[]) => {
			if (args?.includes("--version")) return spawnResult({ status: 1 });
			return spawnResult({ status: 0, stdout: "", stderr: "" });
		});
		const { runTsc } = await loadTsc();
		expect(runTsc(input(projectScope()))).toEqual([]);
	});

	it("reports unavailable when exit 1 has no output to parse", async () => {
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT]));
		spawnSyncMock.mockImplementation((_c: string, args: string[]) => {
			if (args?.includes("--version")) return spawnResult({ status: 1 });
			return spawnResult({ status: 1, stdout: undefined, stderr: undefined });
		});
		const { runTsc } = await loadTsc();
		expect(runTsc(input(projectScope()))).toEqual([
			expect.objectContaining({ ruleId: "tsc-unavailable", severity: "warning" }),
		]);
	});

	it("reports unavailable when the real spawnSync throws", async () => {
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT]));
		spawnSyncMock.mockImplementation((_c: string, args: string[]) => {
			if (args?.includes("--version")) return spawnResult({ status: 1 });
			throw new Error("kaboom in real check");
		});
		const { runTsc } = await loadTsc();
		expect(runTsc(input(projectScope()))).toEqual([
			expect.objectContaining({ ruleId: "tsc-unavailable", message: expect.stringContaining("kaboom") }),
		]);
	});
});

// ===========================================================================
// runTsc (sync) — file mode + filtering
// ===========================================================================

describe("runTsc (sync) — file mode", () => {
	it("filters project output down to the targetFile's diagnostics", async () => {
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT]));
		spawnSyncMock.mockImplementation((_c: string, args: string[]) => {
			if (args?.includes("--version")) return spawnResult({ status: 1 });
			// Two files in output; only src/app.ts matches the target.
			const out = `${tscFileDiag("src/app.ts")}\n${tscFileDiag("src/unrelated.ts")}`;
			return spawnResult({ status: 1, stdout: out });
		});
		const { runTsc } = await loadTsc();
		const out = runTsc(input(fileScope())); // targetFile = <root>/src/app.ts
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe("src/app.ts");
		expect(nonNull(out[0]).ruleId).toBe("TS2345");
	});

	it("does NOT filter when filterToFile is false (returns all parsed results)", async () => {
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT]));
		spawnSyncMock.mockImplementation((_c: string, args: string[]) => {
			if (args?.includes("--version")) return spawnResult({ status: 1 });
			const out = `${tscFileDiag("src/app.ts")}\n${tscFileDiag("src/unrelated.ts")}`;
			return spawnResult({ status: 1, stdout: out });
		});
		const { runTsc } = await loadTsc();
		const out = runTsc(input(fileScope({ filterToFile: false })));
		expect(out).toHaveLength(2);
	});

	it("re-runs standalone when the target has no project diagnostics AND is out of tsconfig scope", async () => {
		// targetFile lives under scripts/ → isFileInTscScope → false → standalone.
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT]));
		const scriptFile = `${PROJECT_ROOT}/scripts/tool.ts`;
		spawnSyncMock.mockImplementation((_c: string, args: string[]) => {
			if (args?.includes("--version")) return spawnResult({ status: 1 });
			// The standalone invocation passes the file path as the last arg.
			if (args?.[args.length - 1] === scriptFile) {
				return spawnResult({ status: 1, stdout: tscFileDiag(scriptFile) });
			}
			// The project run produces output for a DIFFERENT file → filter → [].
			return spawnResult({ status: 1, stdout: tscFileDiag("src/app.ts") });
		});
		const { runTsc } = await loadTsc();
		const out = runTsc(input(fileScope({ targetFile: scriptFile })));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe(scriptFile);
		// Three spawnSync calls: version probe, project run, standalone run.
		const checkCalls = spawnSyncMock.mock.calls.filter(
			(c) => !(c[1] as string[])?.includes("--version"),
		);
		expect(checkCalls).toHaveLength(2);
	});

	it("does NOT re-run standalone when the file IS in tsconfig scope (empty filtered result stays [])", async () => {
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT]));
		spawnSyncMock.mockImplementation((_c: string, args: string[]) => {
			if (args?.includes("--version")) return spawnResult({ status: 1 });
			// Output only for an unrelated in-scope file → filter to target → [].
			return spawnResult({ status: 1, stdout: tscFileDiag("src/unrelated.ts") });
		});
		const { runTsc } = await loadTsc();
		// target src/app.ts is in-scope (not under scripts/.claude/.interlinked).
		const out = runTsc(input(fileScope()));
		expect(out).toEqual([]);
		const checkCalls = spawnSyncMock.mock.calls.filter(
			(c) => !(c[1] as string[])?.includes("--version"),
		);
		expect(checkCalls).toHaveLength(1); // project run only, no standalone
	});
});

// ===========================================================================
// runTsc (sync) — standalone fallback (no tsconfig found)
// ===========================================================================

describe("runTsc (sync) — standalone (no tsconfig)", () => {
	it("type-checks a standalone .ts file with the minimal flag set (tsc, no --ignoreConfig)", async () => {
		const standalone = "/tmp/hooks/check.ts";
		// No tsconfig anywhere → tscRoot null. tsgo unresolved → npx tsc.
		existsSyncMock.mockReturnValue(false);
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		spawnSyncMock.mockImplementation((_c: string, args: string[]) => {
			if (args?.includes("--version")) return spawnResult({ status: 1 });
			return spawnResult({ status: 1, stdout: tscFileDiag(standalone) });
		});
		const { runTsc } = await loadTsc();
		const out = runTsc(input(fileScope({ targetFile: standalone })));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).ruleId).toBe("TS2345");

		const check = spawnSyncMock.mock.calls.at(-1) as [string, string[], { cwd: string }];
		expect(check[0]).toBe("npx");
		expect(check[1]).toEqual([
			"tsc",
			"--noEmit",
			"--pretty",
			"false",
			"--esModuleInterop",
			"--module",
			"nodenext",
			"--moduleResolution",
			"nodenext",
			"--target",
			"es2022",
			"--skipLibCheck",
			standalone,
		]);
		// cwd is the scope.projectRoot when no tsconfig was found.
		expect(check[2].cwd).toBe(PROJECT_ROOT);
	});

	it("adds --ignoreConfig to the standalone flag set when tsgo is the compiler", async () => {
		const standalone = "/tmp/hooks/check.ts";
		// tsgo via node, but NO tsconfig anywhere → standalone path with tsgo.
		requireResolveMock.mockReturnValue(TSGO_PKG_JSON);
		existsSyncMock.mockImplementation(existsForPaths([TSGO_BIN])); // bin yes, tsconfig no
		spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
			if (args?.includes("--version")) return spawnResult({ status: 0 });
			return spawnResult({ status: 1, stdout: tscFileDiag(standalone) });
		});
		const { runTsc } = await loadTsc();
		const out = runTsc(input(fileScope({ targetFile: standalone })));
		expect(out).toHaveLength(1);

		const check = spawnSyncMock.mock.calls.at(-1) as [string, string[]];
		expect(check[0]).toBe("node");
		expect(check[1]).toEqual([
			TSGO_BIN,
			"--noEmit",
			"--pretty",
			"false",
			"--ignoreConfig",
			"--esModuleInterop",
			"--module",
			"nodenext",
			"--moduleResolution",
			"nodenext",
			"--target",
			"es2022",
			"--skipLibCheck",
			standalone,
		]);
	});

	it("returns [] when no tsconfig and the target is not a .ts/.tsx file", async () => {
		existsSyncMock.mockReturnValue(false);
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		spawnSyncMock.mockImplementation(() => spawnResult({ status: 1 })); // tsgo probe
		const { runTsc } = await loadTsc();
		const out = runTsc(input(fileScope({ targetFile: `${PROJECT_ROOT}/README.md` })));
		expect(out).toEqual([]);
		const checkCalls = spawnSyncMock.mock.calls.filter(
			(c) => !(c[1] as string[])?.includes("--version"),
		);
		expect(checkCalls).toHaveLength(0); // never invoked the compiler
	});

	it("accepts .tsx files in the standalone path", async () => {
		const tsx = "/tmp/Component.tsx";
		existsSyncMock.mockReturnValue(false);
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		spawnSyncMock.mockImplementation((_c: string, args: string[]) => {
			if (args?.includes("--version")) return spawnResult({ status: 1 });
			return spawnResult({ status: 1, stdout: tscFileDiag(tsx) });
		});
		const { runTsc } = await loadTsc();
		const out = runTsc(input(fileScope({ targetFile: tsx })));
		expect(out).toHaveLength(1);
		expect((spawnSyncMock.mock.calls.at(-1) as [string, string[]])[1].at(-1)).toBe(tsx);
	});

	it("returns [] when no tsconfig and mode is not 'file' (project mode, nothing to do)", async () => {
		existsSyncMock.mockReturnValue(false);
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		spawnSyncMock.mockImplementation(() => spawnResult({ status: 1 }));
		const { runTsc } = await loadTsc();
		expect(runTsc(input(projectScope()))).toEqual([]);
	});

	it("reads standalone diagnostics from stderr when stdout is undefined (`|| \"\"` fallback)", async () => {
		const standalone = "/tmp/hooks/check.ts";
		existsSyncMock.mockReturnValue(false);
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		spawnSyncMock.mockImplementation((_c: string, args: string[]) => {
			if (args?.includes("--version")) return spawnResult({ status: 1 });
			// stdout undefined → first `|| ""` right side; diag arrives on stderr.
			return spawnResult({ status: 1, stdout: undefined, stderr: tscFileDiag(standalone) });
		});
		const { runTsc } = await loadTsc();
		const out = runTsc(input(fileScope({ targetFile: standalone })));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe(standalone);
		expect(nonNull(out[0]).ruleId).toBe("TS2345");
	});

	it("reports unavailable from the standalone catch block when spawnSync throws", async () => {
		const standalone = "/tmp/hooks/check.ts";
		existsSyncMock.mockReturnValue(false);
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		spawnSyncMock.mockImplementation((_c: string, args: string[]) => {
			if (args?.includes("--version")) return spawnResult({ status: 1 });
			throw new Error("standalone spawn blew up");
		});
		const { runTsc } = await loadTsc();
		expect(runTsc(input(fileScope({ targetFile: standalone })))).toEqual([
			expect.objectContaining({
				ruleId: "tsc-unavailable",
				message: expect.stringContaining("standalone spawn blew up"),
			}),
		]);
	});
});

// ===========================================================================
// isFileInTscScope — heuristic (exercised via the standalone re-run decision)
// ===========================================================================

describe("isFileInTscScope (heuristic branches)", () => {
	// All cases: a tsconfig exists at root, project run yields output for a
	// DIFFERENT file so the target's filtered result is empty, forcing the
	// `!isFileInTscScope(...)` decision. If the file is judged OUT of scope a
	// standalone re-run happens (2 check calls); if IN scope, none (1 call).
	function countCheckCalls(): number {
		return spawnSyncMock.mock.calls.filter(
			(c) => !(c[1] as string[])?.includes("--version"),
		).length;
	}

	async function runWithTarget(target: string) {
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT]));
		spawnSyncMock.mockImplementation((_c: string, args: string[]) => {
			if (args?.includes("--version")) return spawnResult({ status: 1 });
			if (args?.[args.length - 1] === target) {
				// standalone run for the target
				return spawnResult({ status: 1, stdout: tscFileDiag(target) });
			}
			return spawnResult({ status: 1, stdout: tscFileDiag("src/other.ts") });
		});
		const { runTsc } = await loadTsc();
		return runTsc(input(fileScope({ targetFile: target })));
	}

	it("treats a file OUTSIDE the tsconfig root (../) as out of scope → standalone re-run", async () => {
		const outside = "/work/sibling/foo.ts"; // relative(root, ..) starts with ".."
		await runWithTarget(outside);
		expect(countCheckCalls()).toBe(2);
	});

	it("treats scripts/ as out of scope → standalone re-run", async () => {
		await runWithTarget(`${PROJECT_ROOT}/scripts/build.ts`);
		expect(countCheckCalls()).toBe(2);
	});

	it("treats .claude/ as out of scope → standalone re-run", async () => {
		await runWithTarget(`${PROJECT_ROOT}/.claude/hook.ts`);
		expect(countCheckCalls()).toBe(2);
	});

	it("treats .interlinked/ as out of scope → standalone re-run", async () => {
		await runWithTarget(`${PROJECT_ROOT}/.interlinked/probe.ts`);
		expect(countCheckCalls()).toBe(2);
	});

	it("treats a normal src/ file as IN scope → no standalone re-run", async () => {
		await runWithTarget(`${PROJECT_ROOT}/src/feature.ts`);
		expect(countCheckCalls()).toBe(1);
	});
});

// ===========================================================================
// runTscAsync — project mode
// ===========================================================================

describe("runTscAsync — project mode", () => {
	it("serializes concurrent generations but never reuses the earlier result", async () => {
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT]));
		spawnSyncMock.mockImplementation(() => spawnResult({ status: 1 }));
		let finishFirst = (_result: RunProcessResult): void => undefined;
		const firstCompiler = new Promise<RunProcessResult>((resolveResult) => {
			finishFirst = resolveResult;
		});
		runProcessAsyncMock
			.mockReturnValueOnce(firstCompiler)
			.mockResolvedValueOnce(procResult({ code: 1, stdout: tscFileDiag("src/generation-b.ts") }));
		const { runTscAsync } = await loadTsc();
		const first = runTscAsync(input(projectScope()));
		await vi.waitFor(() => expect(runProcessAsyncMock).toHaveBeenCalledTimes(1));
		const second = runTscAsync(input(projectScope()));
		await Promise.resolve();
		expect(runProcessAsyncMock).toHaveBeenCalledTimes(1);
		finishFirst(procResult({ code: 0 }));
		await expect(first).resolves.toEqual([]);
		await vi.waitFor(() => expect(runProcessAsyncMock).toHaveBeenCalledTimes(2));
		await expect(second).resolves.toEqual([
			expect.objectContaining({ file: "src/generation-b.ts", ruleId: "TS2345" }),
		]);
	});

	it.each([
		["spawn failure", procResult({ code: null })],
		["timeout", procResult({ code: null, timedOut: true, killed: true })],
		["external kill", procResult({ code: null, killed: true })],
		["nonzero without diagnostics", procResult({ code: 1 })],
	])("reports unavailable on %s rather than returning clean", async (_label, result) => {
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT]));
		spawnSyncMock.mockImplementation(() => spawnResult({ status: 1 }));
		runProcessAsyncMock.mockResolvedValue(result);
		const { runTscAsync } = await loadTsc();
		const out = await runTscAsync(input(projectScope()));
		expect(out).toEqual([
			expect.objectContaining({ ruleId: "tsc-unavailable", severity: "warning" }),
		]);
	});

	it("parses file-level diagnostics from runProcessAsync output", async () => {
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT]));
		// tscCommand still uses spawnSync for the tsgo probe.
		spawnSyncMock.mockImplementation(() => spawnResult({ status: 1 }));
		runProcessAsyncMock.mockResolvedValue(
			procResult({ code: 1, stdout: tscFileDiag("src/x.ts") }),
		);
		const { runTscAsync } = await loadTsc();
		const out = await runTscAsync(input(projectScope()));
		expect(out).toEqual([
			{
				tool: "tsc",
				severity: "error",
				file: "src/x.ts",
				line: 12,
				column: 5,
				message:
					"TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
				ruleId: "TS2345",
			},
		]);
		// Invoked with the resolved compiler (npx tsc) + project flags.
		const [cmd, args, opts] = runProcessAsyncMock.mock.calls[0] as [
			string,
			string[],
			{ cwd: string; timeout: number },
		];
		expect(cmd).toBe("npx");
		expect(args).toEqual(["tsc", "--noEmit", "--pretty", "false"]);
		expect(opts).toEqual({ cwd: PROJECT_ROOT, timeout: 5_000 });
	});

	it("concatenates stdout+stderr (project-level diag arrives on stderr)", async () => {
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT]));
		spawnSyncMock.mockImplementation(() => spawnResult({ status: 1 }));
		runProcessAsyncMock.mockResolvedValue(
			procResult({ code: 1, stdout: "", stderr: tscProjectDiag() }),
		);
		const { runTscAsync } = await loadTsc();
		const out = await runTscAsync(input(projectScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe("tsconfig.json");
		expect(nonNull(out[0]).ruleId).toBe("TS2688");
	});

	it("returns [] for a project-mode scope with no tsconfig anywhere", async () => {
		existsSyncMock.mockReturnValue(false);
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		spawnSyncMock.mockImplementation(() => spawnResult({ status: 1 }));
		const { runTscAsync } = await loadTsc();
		expect(await runTscAsync(input(projectScope()))).toEqual([]);
		expect(runProcessAsyncMock).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// runTscAsync — file mode + standalone
// ===========================================================================

describe("runTscAsync — file mode + standalone", () => {
	it("filters project output to the targetFile when filterToFile is set", async () => {
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT]));
		spawnSyncMock.mockImplementation(() => spawnResult({ status: 1 }));
		runProcessAsyncMock.mockResolvedValue(
			procResult({
				code: 1,
				stdout: `${tscFileDiag("src/app.ts")}\n${tscFileDiag("src/other.ts")}`,
			}),
		);
		const { runTscAsync } = await loadTsc();
		const out = await runTscAsync(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe("src/app.ts");
	});

	it("re-runs standalone (async) when filtered result is empty AND file is out of scope", async () => {
		const scriptFile = `${PROJECT_ROOT}/scripts/tool.ts`;
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT]));
		spawnSyncMock.mockImplementation(() => spawnResult({ status: 1 }));
		runProcessAsyncMock.mockImplementation(
			(_cmd: string, args: string[]): Promise<RunProcessResult> => {
				if (args?.[args.length - 1] === scriptFile) {
					return Promise.resolve(
						procResult({ code: 1, stdout: tscFileDiag(scriptFile) }),
					);
				}
				return Promise.resolve(procResult({ code: 1, stdout: tscFileDiag("src/app.ts") }));
			},
		);
		const { runTscAsync } = await loadTsc();
		const out = await runTscAsync(input(fileScope({ targetFile: scriptFile })));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe(scriptFile);
		expect(runProcessAsyncMock).toHaveBeenCalledTimes(2); // project + standalone
	});

	it("does NOT re-run standalone (async) when the in-scope file's filtered result is empty", async () => {
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		existsSyncMock.mockImplementation(existsForPaths([TSCONFIG_AT_ROOT]));
		spawnSyncMock.mockImplementation(() => spawnResult({ status: 1 }));
		runProcessAsyncMock.mockResolvedValue(
			procResult({ code: 1, stdout: tscFileDiag("src/unrelated.ts") }),
		);
		const { runTscAsync } = await loadTsc();
		expect(await runTscAsync(input(fileScope()))).toEqual([]);
		expect(runProcessAsyncMock).toHaveBeenCalledTimes(1);
	});

	it("standalone-async (no tsconfig) uses minimal tsc flags ending in the file path", async () => {
		const standalone = "/tmp/script.ts";
		existsSyncMock.mockReturnValue(false);
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		spawnSyncMock.mockImplementation(() => spawnResult({ status: 1 }));
		runProcessAsyncMock.mockResolvedValue(
			procResult({ code: 1, stdout: tscFileDiag(standalone) }),
		);
		const { runTscAsync } = await loadTsc();
		const out = await runTscAsync(input(fileScope({ targetFile: standalone })));
		expect(out).toHaveLength(1);
		const [cmd, args, opts] = runProcessAsyncMock.mock.calls[0] as [
			string,
			string[],
			{ cwd: string; timeout: number },
		];
		expect(cmd).toBe("npx");
		expect(args).toEqual([
			"tsc",
			"--noEmit",
			"--pretty",
			"false",
			"--esModuleInterop",
			"--module",
			"nodenext",
			"--moduleResolution",
			"nodenext",
			"--target",
			"es2022",
			"--skipLibCheck",
			standalone,
		]);
		expect(opts).toEqual({ cwd: PROJECT_ROOT, timeout: 5_000 });
	});

	it("standalone-async adds --ignoreConfig when tsgo is the compiler", async () => {
		const standalone = "/tmp/script.ts";
		requireResolveMock.mockReturnValue(TSGO_PKG_JSON);
		existsSyncMock.mockImplementation(existsForPaths([TSGO_BIN])); // tsgo bin, no tsconfig
		// A synchronous version probe here would block the daemon event loop.
		spawnSyncMock.mockImplementation(() => spawnResult({ status: 0 }));
		runProcessAsyncMock.mockResolvedValue(
			procResult({ code: 1, stdout: tscFileDiag(standalone) }),
		);
		const { runTscAsync } = await loadTsc();
		await runTscAsync(input(fileScope({ targetFile: standalone })));
		expect(spawnSyncMock).not.toHaveBeenCalled();
		const [cmd, args] = runProcessAsyncMock.mock.calls[0] as [string, string[]];
		expect(cmd).toBe("node");
		expect(args).toEqual([
			TSGO_BIN,
			"--noEmit",
			"--pretty",
			"false",
			"--ignoreConfig",
			"--esModuleInterop",
			"--module",
			"nodenext",
			"--moduleResolution",
			"nodenext",
			"--target",
			"es2022",
			"--skipLibCheck",
			standalone,
		]);
	});

	it("returns [] (async) when no tsconfig and target is not .ts/.tsx", async () => {
		existsSyncMock.mockReturnValue(false);
		requireResolveMock.mockImplementation(() => {
			throw new Error("no tsgo");
		});
		spawnSyncMock.mockImplementation(() => spawnResult({ status: 1 }));
		const { runTscAsync } = await loadTsc();
		expect(
			await runTscAsync(input(fileScope({ targetFile: `${PROJECT_ROOT}/notes.txt` }))),
		).toEqual([]);
		expect(runProcessAsyncMock).not.toHaveBeenCalled();
	});
});
