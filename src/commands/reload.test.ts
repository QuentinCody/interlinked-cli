// interlinked reload — one-command dogfood loop (build → hook refresh → daemon).
// SANDBOX-SAFE unit companion: recovers the mutation-kill coverage that used to
// live only in reload.integration.test.ts (now mutation-quarantined for
// spawns/dist-hashing against the REAL repo checkout). Every fs touch here is
// either a throwaway mkdtemp tree or a synthetic `distState` object that
// intercepts the two live build-artifact paths by SUFFIX, so no test ever
// reads this repo's actual dist/ bytes — `cliRoot` may resolve to the real
// checkout (reloadCommand's internal findCliRoot() has no DI seam), but every
// fs call against its dist/ subtree is answered synthetically. No
// process.chdir, no subprocess spawns (execFileSync is fully mocked), no real
// clock/network dependency.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	daemonIsStale,
	distBuildHash,
	findCliRoot,
	reloadCommand,
	shouldRestartDaemon,
} from "./reload.js";

// ===========================================================================
// Module mocks
// ===========================================================================

const {
	execFileSyncMock,
	harnessRestartMock,
	detectClientsMock,
	refreshClientSkillsMock,
	writeHookScriptMock,
	installAllHooksMock,
	distState,
} = vi.hoisted(() => ({
	execFileSyncMock: vi.fn(),
	harnessRestartMock: vi.fn(),
	detectClientsMock: vi.fn(),
	refreshClientSkillsMock: vi.fn(),
	writeHookScriptMock: vi.fn(),
	installAllHooksMock: vi.fn(),
	// Synthetic build-artifact state for the two paths distBuildHash /
	// serverArtifactMtimeMs touch. Suffix-matched (see distSlot below) so it
	// intercepts regardless of what the real, ambient cliRoot prefix is —
	// these two artifact paths are NEVER read from the real filesystem by any
	// test in this file.
	distState: {
		server: { exists: true, content: "server-v1", mtimeMs: 1_700_000_000_000, statThrows: false },
		hook: { exists: true, content: "hook-v1" },
	},
}));

const SERVER_SUFFIX = join("dist", "harness", "server.js");
const HOOK_SUFFIX = join("dist", "hook-entry.js");

function distSlot(p: unknown): "server" | "hook" | null {
	const s = String(p);
	if (s.endsWith(SERVER_SUFFIX)) return "server";
	if (s.endsWith(HOOK_SUFFIX)) return "hook";
	return null;
}

vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: (...args: Parameters<typeof actual.existsSync>) => {
			const slot = distSlot(args[0]);
			if (slot) return distState[slot].exists;
			return actual.existsSync(...args);
		},
		readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
			const slot = distSlot(args[0]);
			if (slot) {
				if (!distState[slot].exists) throw new Error(`ENOENT (simulated): ${String(args[0])}`);
				return Buffer.from(distState[slot].content);
			}
			return actual.readFileSync(...args);
		},
		statSync: (...args: Parameters<typeof actual.statSync>) => {
			const slot = distSlot(args[0]);
			if (slot === "server") {
				if (distState.server.statThrows) throw new Error("ENOENT (simulated stat)");
				// SAFETY: serverArtifactMtimeMs only ever reads `.mtimeMs` off this
				// result — a full fs.Stats instance isn't needed for this stub.
				return { mtimeMs: distState.server.mtimeMs } as unknown as ReturnType<typeof actual.statSync>;
			}
			return actual.statSync(...args);
		},
	};
});

vi.mock("./harness.js", () => ({ harnessRestartCommand: harnessRestartMock }));
vi.mock("../lib/hooks.js", () => ({
	writeHookScript: writeHookScriptMock,
	installAllHooks: installAllHooksMock,
}));
vi.mock("../lib/settings.js", () => ({ detectClients: detectClientsMock }));
vi.mock("./skill-refresh.js", () => ({ refreshClientSkills: refreshClientSkillsMock }));

// ===========================================================================
// Shared helpers
// ===========================================================================

/** Mirrors distBuildHash/hashFileSafe's exact algorithm: sequential
 *  createHash("sha256").update(...) calls (one per part, in order), then
 *  digest("hex").slice(0, 8). Used to pin EXACT expected hash values rather
 *  than pattern-matching, so a StringLiteral mutant on "sha256"/"hex" or a
 *  dropped .slice(0,8) fails the assertion instead of slipping past a regex. */
function sha256Prefix(...parts: (string | Buffer)[]): string {
	const h = createHash("sha256");
	for (const part of parts) h.update(typeof part === "string" ? Buffer.from(part) : part);
	return h.digest("hex").slice(0, 8);
}

function buildNestedPath(base: string, depth: number): string {
	let p = base;
	for (let i = 0; i < depth; i++) p = join(p, `lvl${i}`);
	return p;
}

function resetDistState(): void {
	distState.server = { exists: true, content: "server-v1", mtimeMs: 1_700_000_000_000, statThrows: false };
	distState.hook = { exists: true, content: "hook-v1" };
}

const DEFAULT_DIST_HASH = sha256Prefix("server-v1", "hook-v1");

// The real interlinked-cli checkout's root. reloadCommand's internal
// findCliRoot() call has no DI seam (bare local call, not an injectable
// dependency) so this is unavoidable — but findCliRoot itself only ever
// touches package.json files, never dist/, so resolving it is sandbox-safe.
const REAL_CLI_ROOT = findCliRoot();
if (!REAL_CLI_ROOT) throw new Error("test setup: could not resolve the real interlinked-cli checkout root");

let dir: string;

function pidfile(content: string): void {
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
	writeFileSync(join(dir, ".interlinked", "harness.pid"), content);
}

function utcDateOffsetFromServerMtime(deltaMs: number): string {
	return new Date(distState.server.mtimeMs + deltaMs).toUTCString();
}

let psResult: string | (() => string) = "";
let buildSideEffect: (() => void) | null = null;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "interlinked-reload-unit-"));
	process.exitCode = 0;
	psResult = "";
	buildSideEffect = null;
	execFileSyncMock.mockReset();
	execFileSyncMock.mockImplementation((cmd: string) => {
		if (cmd === "npm") {
			buildSideEffect?.();
			return "";
		}
		if (cmd === "ps") return typeof psResult === "function" ? psResult() : psResult;
		return "";
	});
	harnessRestartMock.mockReset();
	harnessRestartMock.mockImplementation(async () => {
		console.log("Harness started (PID 99999)");
	});
	detectClientsMock.mockReset();
	detectClientsMock.mockReturnValue([]);
	refreshClientSkillsMock.mockReset();
	refreshClientSkillsMock.mockReturnValue({
		results: [],
		outputLines: [],
		summary: { clients: [], installed: 0, changed: 0, warnings: [] },
	});
	writeHookScriptMock.mockReset();
	installAllHooksMock.mockReset();
	resetDistState();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
	process.exitCode = 0;
});

function logLines(spy: ReturnType<typeof vi.spyOn>): string[] {
	return spy.mock.calls.map((args: unknown[]) => String(args[0]));
}

// Same shape as logLines — named separately so call sites read as "what
// channel am I asserting on" (console.error vs console.log).
const errLines = logLines;

function parseJson(spy: ReturnType<typeof vi.spyOn>): {
	cli_root: string;
	build: { before: string; after: string; changed: boolean; ms: number; skipped: boolean };
	hook_script: { before: string; after: string; changed: boolean };
	clients: string[];
	skills: unknown;
	daemon: { restarted: boolean };
} {
	const calls = logLines(spy);
	expect(calls).toHaveLength(1);
	const [blob] = calls;
	if (blob === undefined) throw new Error("expected exactly one console.log call");
	return JSON.parse(blob);
}

// ===========================================================================
// findCliRoot / packageNameAt (packageNameAt is unexported — exercised only
// through findCliRoot's package.json-content branches)
// ===========================================================================

describe("findCliRoot", () => {
	it("walks up from a nested dir to the interlinked-cli package root", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "interlinked-cli" }));
		const nested = join(dir, "dist", "commands");
		mkdirSync(nested, { recursive: true });
		expect(findCliRoot(nested)).toBe(dir);
	});

	it("returns null when a DIFFERENT package.json is above the start dir", () => {
		const nested = join(dir, "some", "other", "project");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mcp-chat" }));
		expect(findCliRoot(nested)).toBeNull();
	});

	it("ignores a malformed package.json instead of throwing", () => {
		writeFileSync(join(dir, "package.json"), "this is not json");
		const nested = join(dir, "x");
		mkdirSync(nested);
		expect(findCliRoot(nested)).toBeNull();
	});

	it("does not treat a package.json with no name field as the CLI root", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({}));
		const nested = join(dir, "y");
		mkdirSync(nested);
		expect(findCliRoot(nested)).toBeNull();
	});

	it("N1: ignores a package.json that parses to a non-object (an array)", () => {
		// packageNameAt narrows with isJsonObject before reading `.name` — an
		// array is `typeof "object"` but must not be treated as the manifest.
		writeFileSync(join(dir, "package.json"), JSON.stringify(["not", "an", "object"]));
		const nested = join(dir, "arr");
		mkdirSync(nested);
		expect(findCliRoot(nested)).toBeNull();
	});

	it("N2: ignores a package.json that parses to `null`", () => {
		writeFileSync(join(dir, "package.json"), "null");
		const nested = join(dir, "nul");
		mkdirSync(nested);
		expect(findCliRoot(nested)).toBeNull();
	});

	it("N3: ignores a package.json whose name field is a non-string (a number)", () => {
		// packageNameAt's `typeof parsed.name === "string" ? parsed.name : null`
		// branch — a numeric name must not satisfy the "interlinked-cli" match.
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: 12345 }));
		const nested = join(dir, "num");
		mkdirSync(nested);
		expect(findCliRoot(nested)).toBeNull();
	});

	it("P1: reads the name field from a well-formed package.json (positive control)", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "interlinked-cli" }));
		const nested = join(dir, "ok");
		mkdirSync(nested);
		expect(findCliRoot(nested)).toBe(dir);
	});

	it("gives up after the hop budget when no match exists anywhere in a deep chain", () => {
		const deep = buildNestedPath(dir, 15);
		mkdirSync(deep, { recursive: true });
		expect(findCliRoot(deep)).toBeNull();
	});

	it("boundary: a match exactly 12 levels above the start dir is NOT reached (hop cap is 12, not 13)", () => {
		// The loop body runs for hops = 0..11 (12 iterations): hop k checks the
		// directory k levels above startDir. A match placed 12 levels up is
		// checked only on a would-be 13th iteration, which `hops < 12` never
		// reaches. This single fixture distinguishes the cap from an off-by-one
		// (`<=12`) AND from a reversed loop counter (`hops--`, which — since
		// climbing itself is unconditional each iteration — would still reach
		// and return this same match after enough iterations).
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "interlinked-cli" }));
		const deep = buildNestedPath(dir, 12);
		mkdirSync(deep, { recursive: true });
		expect(findCliRoot(deep)).toBeNull();
	});
});

// ===========================================================================
// distBuildHash (exported, pure — called directly with a placeholder
// cliRoot string; the two artifact paths are always answered synthetically)
// ===========================================================================

describe("distBuildHash", () => {
	const cliRoot = "/synthetic/cli-root";

	it("reports 'absent' when neither artifact exists (never built)", () => {
		distState.server.exists = false;
		distState.hook.exists = false;
		expect(distBuildHash(cliRoot)).toBe("absent");
	});

	it("hashes a single present artifact exactly when the other is absent", () => {
		distState.server.exists = true;
		distState.server.content = "only-server-bytes";
		distState.hook.exists = false;
		expect(distBuildHash(cliRoot)).toBe(sha256Prefix("only-server-bytes"));
	});

	it("hashes both present artifacts as the server-then-hook concatenation", () => {
		distState.server.content = "content-A";
		distState.hook.content = "content-B";
		expect(distBuildHash(cliRoot)).toBe(sha256Prefix("content-A", "content-B"));
		// order matters: swapping the update() sequence must NOT match
		expect(distBuildHash(cliRoot)).not.toBe(sha256Prefix("content-B", "content-A"));
	});

	it("is stable across repeated calls for unchanged content", () => {
		expect(distBuildHash(cliRoot)).toBe(distBuildHash(cliRoot));
		expect(distBuildHash(cliRoot)).toMatch(/^[0-9a-f]{8}$/);
	});
});

// ===========================================================================
// shouldRestartDaemon (exported, pure)
// ===========================================================================

describe("shouldRestartDaemon", () => {
	const base = { buildChanged: false, hookChanged: false, force: false, daemonStale: false };

	it("does not restart when nothing changed, daemon fresh, and no --force", () => {
		expect(shouldRestartDaemon(base)).toBe(false);
	});
	it("restarts when the build changed", () => {
		expect(shouldRestartDaemon({ ...base, buildChanged: true })).toBe(true);
	});
	it("restarts when the hook script changed even with an unchanged build", () => {
		expect(shouldRestartDaemon({ ...base, hookChanged: true })).toBe(true);
	});
	it("--force restarts even when nothing changed", () => {
		expect(shouldRestartDaemon({ ...base, force: true })).toBe(true);
	});
	it("restarts when the RUNNING daemon predates the current build (out-of-band builds)", () => {
		expect(shouldRestartDaemon({ ...base, daemonStale: true })).toBe(true);
	});
});

// ===========================================================================
// daemonIsStale (exported, pure)
// ===========================================================================

describe("daemonIsStale", () => {
	it("stale when the daemon started before the current server artifact was built", () => {
		expect(daemonIsStale({ serverMtimeMs: 2000, daemonStartMs: 1000 })).toBe(true);
	});
	it("fresh when the daemon started after the current build landed", () => {
		expect(daemonIsStale({ serverMtimeMs: 1000, daemonStartMs: 2000 })).toBe(false);
	});
	it("NOT stale when the daemon start time exactly equals the build time (boundary, strict <)", () => {
		expect(daemonIsStale({ serverMtimeMs: 5000, daemonStartMs: 5000 })).toBe(false);
	});
	it("treats an unknown server build time as stale (fail toward restarting)", () => {
		expect(daemonIsStale({ serverMtimeMs: null, daemonStartMs: 1000 })).toBe(true);
	});
	it("treats an unknown daemon start time as stale (fail toward restarting)", () => {
		expect(daemonIsStale({ serverMtimeMs: 1000, daemonStartMs: null })).toBe(true);
	});
	it("treats an unknown daemon start time as stale even at a zero server mtime boundary", () => {
		// serverMtimeMs=0 specifically distinguishes the daemonStartMs===null
		// operand from the OTHER null-check operand: `null < 0` is false (0
		// coerced), so only the explicit null-check (not the arithmetic
		// fallthrough) can be producing this `true`.
		expect(daemonIsStale({ serverMtimeMs: 0, daemonStartMs: null })).toBe(true);
	});
});

// ===========================================================================
// reloadCommand — orchestration (also exercises the unexported daemonStep,
// runningDaemonStartMs, serverArtifactMtimeMs, hashFileSafe, buildErrorText,
// withStdoutSuppressed, which have no independent export surface)
// ===========================================================================

describe("reloadCommand — stdout/JSON integrity", () => {
	it("emits a single parseable JSON blob in --json mode with nothing else on stdout", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, force: true, cwd: dir, build: false });

		const parsed = parseJson(logSpy);
		expect(parsed.daemon.restarted).toBe(true);
		expect(harnessRestartMock).toHaveBeenCalledTimes(1);
		expect(harnessRestartMock).toHaveBeenCalledWith({ json: false });
	});

	it("keeps the restart's human stdout visible in non-json mode (suppression is json-only)", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ force: true, cwd: dir, build: false });

		expect(logLines(logSpy)).toContain("Harness started (PID 99999)");
		expect(harnessRestartMock).toHaveBeenCalledTimes(1);
		// Non-json mode must never emit the machine-readable JSON blob.
		expect(logLines(logSpy).some((l) => l.startsWith("{"))).toBe(false);
	});

	it("restores console.log after a suppressed json+restart run (finally-block must run)", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, force: true, cwd: dir, build: false });
		console.log("canary-after-reload");

		expect(logLines(logSpy)).toContain("canary-after-reload");
	});
});

describe("reloadCommand — build lane", () => {
	it("skips the build with --no-build and reports the exact skipped line", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ build: false, cwd: dir });

		expect(logLines(logSpy)).toContain(`  CLI build:   skipped (--no-build) — dist ${DEFAULT_DIST_HASH}`);
		expect(execFileSyncMock).not.toHaveBeenCalledWith("npm", expect.anything(), expect.anything());
	});

	it("reports skipped:true in the JSON blob for --no-build (the human-line skip test only checks non-json)", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, build: false, cwd: dir, force: true });

		expect(parseJson(logSpy).build.skipped).toBe(true);
	});

	it("runs the build with the exact npm/run/build/cwd/stdio args and reports UNCHANGED", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, cwd: dir });

		expect(execFileSyncMock).toHaveBeenCalledWith("npm", ["run", "build"], {
			cwd: REAL_CLI_ROOT,
			stdio: "pipe",
		});
		const parsed = parseJson(logSpy);
		expect(parsed.build).toEqual({
			before: DEFAULT_DIST_HASH,
			after: DEFAULT_DIST_HASH,
			changed: false,
			ms: parsed.build.ms,
			skipped: false,
		});
		expect(parsed.build.ms).toBeGreaterThanOrEqual(0);
		expect(parsed.build.ms).toBeLessThan(60_000);
	});

	it("reports the exact UNCHANGED human line (non-json mode, build actually ran)", async () => {
		// Distinct from the --no-build "skipped" line and from the JSON-mode
		// UNCHANGED assertion above: this is the only case that reads the
		// `unchanged (${after})` template through the say() channel.
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ cwd: dir, force: true });

		const expected = new RegExp(`^  CLI build:   unchanged \\(${DEFAULT_DIST_HASH}\\) in \\d+\\.\\d+s$`);
		expect(logLines(logSpy).some((l) => expected.test(l))).toBe(true);
	});

	it("reports CHANGED with exact before/after hashes when the rebuild changes dist content", async () => {
		buildSideEffect = () => {
			distState.server.content = "server-v2";
		};
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, cwd: dir });

		const parsed = parseJson(logSpy);
		expect(parsed.build.before).toBe(DEFAULT_DIST_HASH);
		expect(parsed.build.after).toBe(sha256Prefix("server-v2", "hook-v1"));
		expect(parsed.build.changed).toBe(true);
	});

	it("reports the exact CHANGED human line (non-json mode)", async () => {
		buildSideEffect = () => {
			distState.server.content = "server-v3";
		};
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const after = sha256Prefix("server-v3", "hook-v1");

		await reloadCommand({ cwd: dir, force: true });

		const expected = new RegExp(`^  CLI build:   CHANGED ${DEFAULT_DIST_HASH} → ${after} in \\d+\\.\\d+s$`);
		expect(logLines(logSpy).some((l) => expected.test(l))).toBe(true);
	});

	it("BE1: surfaces BOTH captured streams, trimmed and newline-joined, and exits non-zero", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		execFileSyncMock.mockImplementation((cmd: string) => {
			if (cmd === "npm") {
				throw Object.assign(new Error("Command failed"), {
					stdout: Buffer.from("  first-line  "),
					stderr: Buffer.from("  second-line  "),
				});
			}
			return "";
		});

		await expect(reloadCommand({ json: true, cwd: dir })).resolves.toBeUndefined();

		expect(process.exitCode).toBe(1);
		expect(errLines(errSpy)).toEqual([
			`reload: CLI build failed in ${REAL_CLI_ROOT}. Fix the errors below, then re-run.\nfirst-line\nsecond-line`,
		]);
		expect(harnessRestartMock).not.toHaveBeenCalled();
		expect(logLines(logSpy)).toHaveLength(0);
	});

	it("BE2: keeps only the non-empty captured stream when the other is empty", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		execFileSyncMock.mockImplementation((cmd: string) => {
			if (cmd === "npm") {
				throw Object.assign(new Error("Command failed"), {
					stdout: Buffer.from(""),
					stderr: Buffer.from("only-stderr"),
				});
			}
			return "";
		});

		await reloadCommand({ json: true, cwd: dir });

		expect(errLines(errSpy)).toEqual([
			`reload: CLI build failed in ${REAL_CLI_ROOT}. Fix the errors below, then re-run.\nonly-stderr`,
		]);
	});

	it("BE3: falls back to the thrown Error's own .message when neither stream carries text", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		execFileSyncMock.mockImplementation((cmd: string) => {
			if (cmd === "npm") throw new Error("spawn npm ENOENT");
			return "";
		});

		await reloadCommand({ json: true, cwd: dir });

		expect(errLines(errSpy)).toEqual([
			`reload: CLI build failed in ${REAL_CLI_ROOT}. Fix the errors below, then re-run.\nspawn npm ENOENT`,
		]);
	});

	it("BE4: falls back to String(err) for a non-Error throw", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		execFileSyncMock.mockImplementation((cmd: string) => {
			if (cmd === "npm") throw "raw-non-error-throw";
			return "";
		});

		await reloadCommand({ json: true, cwd: dir });

		expect(errLines(errSpy)).toEqual([
			`reload: CLI build failed in ${REAL_CLI_ROOT}. Fix the errors below, then re-run.\nraw-non-error-throw`,
		]);
	});
});

describe("reloadCommand — hook-script lane", () => {
	it("reports UNCHANGED with exact 'absent' before/after when nothing writes new content", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, cwd: dir, build: false });

		const parsed = parseJson(logSpy);
		expect(parsed.hook_script).toEqual({ before: "absent", after: "absent", changed: false });
	});

	it("shows the exact unchanged human line with no wiring-refreshed suffix when zero clients", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ cwd: dir, build: false, force: true });

		expect(logLines(logSpy)).toContain("  Hook script: unchanged (absent)");
	});

	it("reports CHANGED with exact hashes, exact filtered/mapped client list, and installs wiring", async () => {
		writeHookScriptMock.mockImplementation((cwd: string) => {
			mkdirSync(join(cwd, ".interlinked", "hooks"), { recursive: true });
			writeFileSync(join(cwd, ".interlinked", "hooks", "interlinked-activity.mjs"), "hook-content-v1");
		});
		detectClientsMock.mockReturnValue([
			{ name: "codex", exists: true },
			{ name: "gemini", exists: false },
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, cwd: dir, build: false });

		const parsed = parseJson(logSpy);
		expect(parsed.hook_script).toEqual({
			before: "absent",
			after: sha256Prefix("hook-content-v1"),
			changed: true,
		});
		expect(parsed.clients).toEqual(["codex"]);
		expect(installAllHooksMock).toHaveBeenCalledWith(dir, ["codex"]);
		// The mkdtemp cwd was actually used (kills the `opts.cwd ?? ... : &&`
		// LogicalOperator mutant, which would silently swap in process.cwd()).
		expect(writeHookScriptMock).toHaveBeenCalledWith(dir);
	});

	it("shows the exact CHANGED human line with the wiring-refreshed suffix for TWO clients (exact join separator)", async () => {
		writeHookScriptMock.mockImplementation((cwd: string) => {
			mkdirSync(join(cwd, ".interlinked", "hooks"), { recursive: true });
			writeFileSync(join(cwd, ".interlinked", "hooks", "interlinked-activity.mjs"), "hook-content-v2");
		});
		// Two EXISTING clients — the only fixture in this file where the
		// `clients.join(", ")` separator is actually observable (a single
		// client can't distinguish a StringLiteral mutant on ", ").
		detectClientsMock.mockReturnValue([
			{ name: "codex", exists: true },
			{ name: "cursor", exists: true },
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const after = sha256Prefix("hook-content-v2");

		await reloadCommand({ cwd: dir, build: false, force: true });

		expect(logLines(logSpy)).toContain(
			`  Hook script: CHANGED absent → ${after} — wiring refreshed for codex, cursor`,
		);
	});

	it("does not install client wiring when zero clients are detected", async () => {
		await reloadCommand({ cwd: dir, build: false, force: true });
		expect(installAllHooksMock).not.toHaveBeenCalled();
	});

	it("surfaces the skill-refresh command's own output lines verbatim", async () => {
		refreshClientSkillsMock.mockReturnValue({
			results: [],
			outputLines: ["  Skills: 2 installed for codex"],
			summary: { clients: ["codex"], installed: 2, changed: 2, warnings: [] },
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ cwd: dir, build: false, force: true });

		expect(logLines(logSpy)).toContain("  Skills: 2 installed for codex");
	});
});

describe("reloadCommand — daemon lane", () => {
	it("D1: fresh daemon + nothing else changed -> NOT restarted, exact line, mock never called", async () => {
		pidfile("4242");
		psResult = () => utcDateOffsetFromServerMtime(3_600_000); // 1h after build
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ cwd: dir, build: false });

		expect(logLines(logSpy)).toContain(
			"  Daemon:      already current (running daemon postdates the build) — not restarted",
		);
		expect(harnessRestartMock).not.toHaveBeenCalled();
		expect(execFileSyncMock).toHaveBeenCalledWith(
			"ps",
			["-p", "4242", "-o", "lstart="],
			{ encoding: "utf-8" },
		);
	});

	it("D1b: fresh daemon reports daemon.restarted:false in the JSON blob (not just the human line)", async () => {
		// D1 only inspects the human say-line and the mock call count; a mutant
		// that flips daemonStep's own `return false` -> `return true` (the
		// early-exit boolean, distinct from whether the restart mock fires)
		// would slip past those two checks. The JSON field pins the RETURN
		// VALUE itself.
		pidfile("4242");
		psResult = () => utcDateOffsetFromServerMtime(3_600_000);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, cwd: dir, build: false });

		expect(parseJson(logSpy).daemon.restarted).toBe(false);
	});

	it("D2: stale daemon (real past timestamp) -> restarts with the exact STALE-prefixed line", async () => {
		pidfile("4242");
		psResult = () => utcDateOffsetFromServerMtime(-3_600_000); // 1h before build
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ cwd: dir, build: false });

		expect(logLines(logSpy)).toContain(
			`  Daemon:      was STALE (started before the current build) — restarted on build ${DEFAULT_DIST_HASH}`,
		);
		expect(harnessRestartMock).toHaveBeenCalledTimes(1);
		expect(harnessRestartMock).toHaveBeenCalledWith({ json: false });
	});

	it("D3: unreadable server artifact (stat throws) is treated as unknowable -> stale, even with a fresh-looking ps date", async () => {
		distState.server.statThrows = true;
		pidfile("4242");
		psResult = () => utcDateOffsetFromServerMtime(3_600_000); // would read "fresh" if stat worked
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ cwd: dir, build: false });

		expect(logLines(logSpy)).toContain(
			`  Daemon:      was STALE (started before the current build) — restarted on build ${DEFAULT_DIST_HASH}`,
		);
	});

	it("D4: buildChanged alone triggers a restart WITHOUT the pure-staleness prefix", async () => {
		buildSideEffect = () => {
			distState.server.content = "server-v4";
		};
		pidfile("4242");
		psResult = () => utcDateOffsetFromServerMtime(3_600_000); // fresh daemon
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const after = sha256Prefix("server-v4", "hook-v1");

		await reloadCommand({ cwd: dir });

		expect(logLines(logSpy)).toContain(`  Daemon:      restarted on build ${after}`);
	});

	it("D5: hookChanged alone triggers a restart WITHOUT the pure-staleness prefix", async () => {
		writeHookScriptMock.mockImplementation((cwd: string) => {
			mkdirSync(join(cwd, ".interlinked", "hooks"), { recursive: true });
			writeFileSync(join(cwd, ".interlinked", "hooks", "interlinked-activity.mjs"), "hook-v5");
		});
		pidfile("4242");
		psResult = () => utcDateOffsetFromServerMtime(3_600_000); // fresh daemon
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ cwd: dir, build: false });

		expect(logLines(logSpy)).toContain(`  Daemon:      restarted on build ${DEFAULT_DIST_HASH}`);
	});

	it("D6: a genuinely stale daemon AND a changed build together -> restart, but NOT claimed as pure staleness", async () => {
		buildSideEffect = () => {
			distState.server.content = "server-v6";
		};
		pidfile("4242");
		psResult = () => utcDateOffsetFromServerMtime(-3_600_000); // stale daemon
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const after = sha256Prefix("server-v6", "hook-v1");

		await reloadCommand({ cwd: dir });

		expect(logLines(logSpy)).toContain(`  Daemon:      restarted on build ${after}`);
	});

	it("D6b: a genuinely stale daemon AND a changed hook script together -> restart, but NOT claimed as pure staleness", async () => {
		// Mirrors D6 but through the hookChanged term of the `why` AND-chain
		// instead of buildChanged — D5 alone (hookChanged, but daemon FRESH)
		// can't reach this term's stale-combined branch, since a fresh daemon
		// already short-circuits the chain to "" for an unrelated reason.
		writeHookScriptMock.mockImplementation((cwd: string) => {
			mkdirSync(join(cwd, ".interlinked", "hooks"), { recursive: true });
			writeFileSync(join(cwd, ".interlinked", "hooks", "interlinked-activity.mjs"), "hook-v6b");
		});
		pidfile("4242");
		psResult = () => utcDateOffsetFromServerMtime(-3_600_000); // stale daemon
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ cwd: dir, build: false });

		expect(logLines(logSpy)).toContain(`  Daemon:      restarted on build ${DEFAULT_DIST_HASH}`);
	});

	it("D7: --force on a stale daemon -> restart, but NOT claimed as pure staleness", async () => {
		pidfile("4242");
		psResult = () => utcDateOffsetFromServerMtime(-3_600_000); // stale daemon
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ cwd: dir, build: false, force: true });

		expect(logLines(logSpy)).toContain(`  Daemon:      restarted on build ${DEFAULT_DIST_HASH}`);
	});

	it("D8: missing pidfile -> unknowable daemon start -> stale -> restarts with the STALE prefix", async () => {
		// No pidfile written at all.
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ cwd: dir, build: false });

		expect(logLines(logSpy)).toContain(
			`  Daemon:      was STALE (started before the current build) — restarted on build ${DEFAULT_DIST_HASH}`,
		);
	});

	it.each([
		["pid=0", "0"],
		["pid=-7 (negative)", "-7"],
		["pid=not-a-number (NaN)", "not-a-pid"],
	])("%s in the pidfile is treated as no running daemon (restarts)", async (_label, pidValue) => {
		pidfile(pidValue);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, cwd: dir, build: false });

		expect(parseJson(logSpy).daemon.restarted).toBe(true);
	});

	it("D9: pid<=0 short-circuits BEFORE ps is consulted, even when ps would report a fresh daemon", async () => {
		// Distinguishes the pid<=0 guard from the it.each rows above: those use
		// the default empty ps mock, under which a mutant that wrongly PROCEEDS
		// past the pid<=0 check would still land on null via the separate
		// !lstart/NaN-date fallback — no observable divergence. Here ps is
		// configured to return a genuinely FRESH, parseable date; if a mutant
		// lets pid=0 fall through to the ps call, the daemon would wrongly read
		// as fresh and NOT restart.
		pidfile("0");
		psResult = () => utcDateOffsetFromServerMtime(3_600_000);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ cwd: dir, build: false });

		expect(logLines(logSpy)).toContain(
			`  Daemon:      was STALE (started before the current build) — restarted on build ${DEFAULT_DIST_HASH}`,
		);
	});

	it.each([
		["empty ps output", ""],
		["unparseable ps date", "not-a-real-date"],
	])("%s is treated as no running daemon (restarts)", async (_label, output) => {
		pidfile("4242");
		psResult = output;
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, cwd: dir, build: false });

		expect(parseJson(logSpy).daemon.restarted).toBe(true);
	});

	it("ps throwing (process gone) is treated as no running daemon (restarts)", async () => {
		pidfile("4242");
		execFileSyncMock.mockImplementation((cmd: string) => {
			if (cmd === "ps") throw new Error("ps: no such process");
			return "";
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, cwd: dir, build: false });

		expect(parseJson(logSpy).daemon.restarted).toBe(true);
	});
});

describe("reloadCommand — missing checkout", () => {
	it("reports the exact error, exits 1, and does nothing else when resolveCliRoot finds no checkout", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const result = await reloadCommand({ json: true, cwd: dir, force: true }, () => null);

		expect(result).toBeUndefined();
		expect(errLines(errSpy)).toEqual([
			"reload: could not locate the interlinked-cli source checkout from the running binary — rebuild manually in the checkout, then run `interlinked enable && interlinked harness restart`.",
		]);
		expect(process.exitCode).toBe(1);
		// Proves the early return actually short-circuited (an inverted guard
		// would fall through to the build/hook/daemon lanes below it).
		expect(execFileSyncMock).not.toHaveBeenCalledWith("npm", expect.anything(), expect.anything());
		expect(harnessRestartMock).not.toHaveBeenCalled();
		expect(logLines(logSpy)).toHaveLength(0);
	});
});
