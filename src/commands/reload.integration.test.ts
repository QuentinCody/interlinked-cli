import { parseWire, wireArray, wireBoolean, wireObject, wireString } from "../lib/value-validation.js";
// interlinked reload — one-command dogfood loop (build → hook refresh → daemon).
// Pins the pure helpers (root discovery, build-identity hashing, restart
// decision) and the orchestration's delta-only behavior via module mocks.

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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

// Mocks for the reloadCommand orchestration tests. The pure-helper describes
// above don't touch these modules, so the mocks are inert for them.
const {
	execFileSyncMock,
	harnessRestartMock,
	detectClientsMock,
	refreshClientSkillsMock,
	writeHookScriptMock,
	fsControl,
} = vi.hoisted(() => ({
	execFileSyncMock: vi.fn(),
	harnessRestartMock: vi.fn(),
	detectClientsMock: vi.fn(),
	refreshClientSkillsMock: vi.fn(),
	writeHookScriptMock: vi.fn(),
	// Shared mutable flags read by the node:fs mock factory below — a real
	// `dist/` build artifact can't be safely mutated by a test (other agents
	// may be reading/building it concurrently), so "the build changed content"
	// and "the server artifact is unreadable" are simulated by intercepting
	// reads/stats for those two exact suffixes instead of touching real files.
	fsControl: { buildRan: false, forceStatThrow: false, serverStatPath: "" },
}));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFileSync: execFileSyncMock };
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		statSync: (...args: Parameters<typeof actual.statSync>) => {
			const p = String(args[0]);
			if (fsControl.forceStatThrow && p.endsWith("dist/harness/server.js")) {
				throw new Error("ENOENT: simulated missing server artifact");
			}
			if (fsControl.serverStatPath && p.endsWith("dist/harness/server.js")) {
				return actual.statSync(fsControl.serverStatPath);
			}
			return actual.statSync(...args);
		},
		readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
			const p = String(args[0]);
			if (fsControl.buildRan && p.endsWith("dist/harness/server.js")) {
				return Buffer.from("server-v2-simulated");
			}
			if (fsControl.buildRan && p.endsWith("dist/hook-entry.js")) {
				return Buffer.from("hook-v2-simulated");
			}
			return actual.readFileSync(...args);
		},
	};
});
vi.mock("./harness.js", () => ({ harnessRestartCommand: harnessRestartMock }));
vi.mock("../lib/hooks.js", () => ({ writeHookScript: writeHookScriptMock, installAllHooks: vi.fn() }));
vi.mock("../lib/settings.js", () => ({ detectClients: detectClientsMock }));
vi.mock("./skill-refresh.js", () => ({ refreshClientSkills: refreshClientSkillsMock }));

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "interlinked-reload-"));
	process.exitCode = 0;
	// Build is a no-op by default (return value is ignored); the restart mock
	// simulates the daemon's human "Harness started (PID …)" stdout line — the
	// exact line that must NOT leak into a --json run's stdout.
	execFileSyncMock.mockReset();
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
	fsControl.buildRan = false;
	fsControl.forceStatThrow = false;
	fsControl.serverStatPath = "";
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
	process.exitCode = 0;
	fsControl.buildRan = false;
	fsControl.forceStatThrow = false;
	fsControl.serverStatPath = "";
});

describe("findCliRoot", () => {
	it("walks up from a nested dir to the interlinked-cli package root", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "interlinked-cli" }));
		const nested = join(dir, "dist", "commands");
		mkdirSync(nested, { recursive: true });
		expect(findCliRoot(nested)).toBe(dir);
	});

	it("returns null when no interlinked-cli package.json is above the start dir", () => {
		const nested = join(dir, "some", "other", "project");
		mkdirSync(nested, { recursive: true });
		// A DIFFERENT package above must not be claimed as the CLI root.
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

	it("N1: ignores a package.json that parses to a non-object (an array) instead of throwing", () => {
		// packageNameAt narrows with isJsonObject before reading `.name` — an
		// array is `typeof "object"` but must not be treated as the manifest.
		writeFileSync(join(dir, "package.json"), JSON.stringify(["not", "an", "object"]));
		const nested = join(dir, "arr");
		mkdirSync(nested);
		expect(findCliRoot(nested)).toBeNull();
	});

	it("N2: ignores a package.json that parses to `null` instead of throwing", () => {
		// Regression for the pre-fix shape: `(JSON.parse(raw) as {name?:string}).name`
		// on `null` throws a TypeError that only the outer try/catch caught;
		// isJsonObject now rejects it explicitly, before any property read.
		writeFileSync(join(dir, "package.json"), "null");
		const nested = join(dir, "nul");
		mkdirSync(nested);
		expect(findCliRoot(nested)).toBeNull();
	});

	it("P1: reads the name field from a well-formed package.json (positive control)", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "interlinked-cli" }));
		const nested = join(dir, "ok");
		mkdirSync(nested);
		expect(findCliRoot(nested)).toBe(dir);
	});

	it("returns null after exhausting the walk-up hop budget without a match", () => {
		let deep = dir;
		for (let i = 0; i < 13; i++) {
			deep = join(deep, `lvl${i}`);
		}
		mkdirSync(deep, { recursive: true });
		expect(findCliRoot(deep)).toBeNull();
	});
});

describe("distBuildHash", () => {
	function seedDist(): void {
		mkdirSync(join(dir, "dist", "harness"), { recursive: true });
		writeFileSync(join(dir, "dist", "harness", "server.js"), "server-v1");
		writeFileSync(join(dir, "dist", "hook-entry.js"), "hook-v1");
	}

	it("is stable across calls for unchanged dist content", () => {
		seedDist();
		expect(distBuildHash(dir)).toBe(distBuildHash(dir));
		expect(distBuildHash(dir)).toMatch(/^[0-9a-f]{8}$/);
	});

	it("changes when either built artifact changes", () => {
		seedDist();
		const before = distBuildHash(dir);
		writeFileSync(join(dir, "dist", "harness", "server.js"), "server-v2");
		const afterServer = distBuildHash(dir);
		expect(afterServer).not.toBe(before);
		writeFileSync(join(dir, "dist", "hook-entry.js"), "hook-v2");
		expect(distBuildHash(dir)).not.toBe(afterServer);
	});

	it("reports 'absent' when the dist artifacts are missing (never built)", () => {
		expect(distBuildHash(dir)).toBe("absent");
	});
});

describe("shouldRestartDaemon", () => {
	const base = { buildChanged: false, hookChanged: false, force: false, daemonStale: false };
	it("restarts when the build changed", () => {
		expect(shouldRestartDaemon({ ...base, buildChanged: true })).toBe(true);
	});
	it("restarts when the hook script changed even with an unchanged build", () => {
		expect(shouldRestartDaemon({ ...base, hookChanged: true })).toBe(true);
	});
	it("skips the restart when nothing changed, daemon fresh, and no --force", () => {
		expect(shouldRestartDaemon(base)).toBe(false);
	});
	it("--force restarts even when nothing changed", () => {
		expect(shouldRestartDaemon({ ...base, force: true })).toBe(true);
	});
	it("restarts when the RUNNING daemon predates the current build (v2: out-of-band builds)", () => {
		expect(shouldRestartDaemon({ ...base, daemonStale: true })).toBe(true);
	});
});

describe("daemonIsStale", () => {
	it("stale when the daemon started before the current server artifact was built", () => {
		expect(daemonIsStale({ serverMtimeMs: 2_000, daemonStartMs: 1_000 })).toBe(true);
	});
	it("fresh when the daemon started after the current build landed", () => {
		expect(daemonIsStale({ serverMtimeMs: 1_000, daemonStartMs: 2_000 })).toBe(false);
	});
	it("treats unknowable state (no pid / no artifact) as stale — fail toward restarting", () => {
		expect(daemonIsStale({ serverMtimeMs: null, daemonStartMs: 1_000 })).toBe(true);
		expect(daemonIsStale({ serverMtimeMs: 1_000, daemonStartMs: null })).toBe(true);
	});
});

describe("reloadCommand — stdout integrity", () => {
	// Collect everything written to a console channel across the whole run.
	function joinCalls(spy: ReturnType<typeof vi.spyOn>): string {
		return spy.mock.calls.map((args: unknown[]) => args.map(String).join(" ")).join("\n");
	}

	it("emits a SINGLE parseable JSON object in --json mode WHEN a restart occurs", async () => {
		// Regression: daemonStep restarted the daemon in human mode, so the
		// restart's 'Harness started (PID …)' printed to stdout BEFORE reload's
		// JSON blob — yielding unparseable output. --force guarantees the restart.
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, force: true, cwd: dir });

		const stdout = joinCalls(logSpy);
		// The restart ran (its stdout was suppressed, not skipped)…
		expect(harnessRestartMock).toHaveBeenCalledTimes(1);
		// …and its human line never reached stdout.
		expect(stdout).not.toContain("Harness started");
		// stdout is the JSON blob and NOTHING else → parseable, restart reported.
		const parsed = parseWire(JSON.parse(stdout), wireObject({ "daemon": wireObject({ "restarted": wireBoolean }) }), "test JSON value");
		expect(parsed.daemon.restarted).toBe(true);
	});

	it("still shows the restart's human stdout in normal mode (suppression is json-only)", async () => {
		// Guard against over-suppression: a normal reload must keep the restart's
		// 'Harness started (PID …)' visible; only --json swallows it.
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ force: true, cwd: dir });

		const stdout = joinCalls(logSpy);
		expect(harnessRestartMock).toHaveBeenCalledTimes(1);
		expect(stdout).toContain("Harness started (PID 99999)");
	});

	it("refreshes deployed skills for every detected client", async () => {
		detectClientsMock.mockReturnValue([
			{ name: "codex", exists: true },
			{ name: "gemini", exists: false },
		]);
		vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ force: true, cwd: dir });

		expect(refreshClientSkillsMock).toHaveBeenCalledWith(dir, ["codex"]);
	});

	it("surfaces the compiler error and exits non-zero when the CLI build fails (no opaque crash)", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		// A failed `npm run build` throws with the tool's captured stdout/stderr.
		execFileSyncMock.mockImplementation(() => {
			throw Object.assign(new Error("Command failed: npm run build"), {
				stdout: Buffer.from(""),
				stderr: Buffer.from("src/x.ts(1,5): error TS1005: ';' expected."),
				status: 1,
			});
		});

		// Resolves rather than rejecting with an opaque stack.
		await expect(reloadCommand({ json: true, cwd: dir })).resolves.toBeUndefined();

		expect(process.exitCode).toBe(1);
		// The real compiler diagnostic is surfaced on stderr…
		const stderr = joinCalls(errSpy);
		expect(stderr).toContain("TS1005");
		expect(stderr).toContain("CLI build failed");
		// …the build never reached the restart…
		expect(harnessRestartMock).not.toHaveBeenCalled();
		// …and nothing (no half-built JSON) went to stdout.
		expect(logSpy.mock.calls).toHaveLength(0);
	});

	it("falls back to the error's message when the build failure carries no stdout/stderr", () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		execFileSyncMock.mockImplementation(() => {
			throw new Error("spawn npm ENOENT");
		});

		return reloadCommand({ json: true, cwd: dir }).then(() => {
			expect(process.exitCode).toBe(1);
			const stderr = joinCalls(errSpy);
			expect(stderr).toContain("spawn npm ENOENT");
		});
	});

	it("falls back to String(err) when the build failure has neither captured output nor a message", () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		execFileSyncMock.mockImplementation(() => {
			// Deliberately a non-Error throw to exercise the String(err) fallback.
			throw "raw-non-error-throw";
		});

		return reloadCommand({ json: true, cwd: dir }).then(() => {
			expect(process.exitCode).toBe(1);
			const stderr = joinCalls(errSpy);
			expect(stderr).toContain("raw-non-error-throw");
		});
	});
});

describe("reloadCommand — running-daemon detection (pidfile + ps parsing)", () => {
	function jsonFrom(spy: ReturnType<typeof vi.spyOn>): { daemon: { restarted: boolean } } {
		const stdout = spy.mock.calls.map((args: unknown[]) => args.map(String).join(" ")).join("\n");
		return parseWire(JSON.parse(stdout), wireObject({ "daemon": wireObject({ "restarted": wireBoolean }) }), "test JSON value");
	}

	it("treats a non-positive pid in the pidfile as no running daemon (restarts)", async () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "harness.pid"), "0");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, build: false, cwd: dir });

		expect(jsonFrom(logSpy).daemon.restarted).toBe(true);
	});

	it("treats an empty `ps -o lstart=` result as no running daemon (restarts)", async () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "harness.pid"), "4242");
		execFileSyncMock.mockImplementation(() => "");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, build: false, cwd: dir });

		expect(jsonFrom(logSpy).daemon.restarted).toBe(true);
	});

	it("treats an unparseable `ps -o lstart=` date as no running daemon (restarts)", async () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "harness.pid"), "4242");
		execFileSyncMock.mockImplementation(() => "not-a-real-date");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, build: false, cwd: dir });

		expect(jsonFrom(logSpy).daemon.restarted).toBe(true);
	});

	it("skips the restart when the running daemon postdates the build, and no --force", async () => {
		const cliRoot = findCliRoot();
		if (cliRoot === null) throw new Error("expected to find the interlinked-cli root");
		// Model an existing server artifact with stable repository input. Requiring
		// live dist here made a clean checkout fail before reloadCommand ran.
		fsControl.serverStatPath = join(cliRoot, "src", "harness", "server.ts");
		const serverMtimeMs = statSync(join(cliRoot, "dist", "harness", "server.js")).mtimeMs;
		const future = new Date(serverMtimeMs + 60_000).toISOString();
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "harness.pid"), "4242");
		execFileSyncMock.mockImplementation(() => future);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, build: false, cwd: dir });

		expect(jsonFrom(logSpy).daemon.restarted).toBe(false);
		expect(harnessRestartMock).not.toHaveBeenCalled();
	});

	it("restarts due to a STALE daemon even without --force, and says so", async () => {
		// No pidfile at all ⇒ unknowable daemon start time ⇒ treated as stale.
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ build: false, cwd: dir });

		const stdout = logSpy.mock.calls.map((args: unknown[]) => args.map(String).join(" ")).join("\n");
		expect(stdout).toContain("was STALE (started before the current build)");
		expect(harnessRestartMock).toHaveBeenCalledTimes(1);
	});

	it("treats an unreadable server build artifact as an unknown build time (still restarts, no crash)", async () => {
		fsControl.forceStatThrow = true;
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, build: false, force: true, cwd: dir });

		expect(jsonFrom(logSpy).daemon.restarted).toBe(true);
	});
});

describe("reloadCommand — build + hook-script delta branches", () => {
	it("reports the build as CHANGED when the rebuilt artifacts' content differs", async () => {
		execFileSyncMock.mockImplementation((cmd: string) => {
			if (cmd === "npm") {
				fsControl.buildRan = true;
				return "";
			}
			return "";
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, force: true, cwd: dir });

		const stdout = logSpy.mock.calls.map((args: unknown[]) => args.map(String).join(" ")).join("\n");
		const parsed = parseWire(JSON.parse(stdout), wireObject({ "build": wireObject({ "changed": wireBoolean }) }), "test JSON value");
		expect(parsed.build.changed).toBe(true);
	});

	it("reports the hook script as CHANGED and lists wiring-refreshed clients", async () => {
		writeHookScriptMock.mockImplementation((cwd: string) => {
			mkdirSync(join(cwd, ".interlinked", "hooks"), { recursive: true });
			writeFileSync(join(cwd, ".interlinked", "hooks", "interlinked-activity.mjs"), "content-v1");
		});
		detectClientsMock.mockReturnValue([{ name: "codex", exists: true }]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, force: true, cwd: dir });

		const stdout = logSpy.mock.calls.map((args: unknown[]) => args.map(String).join(" ")).join("\n");
		const parsed = parseWire(JSON.parse(stdout), wireObject({ "hook_script": wireObject({ "changed": wireBoolean }), "clients": wireArray(wireString) }), "test JSON value");
		expect(parsed.hook_script.changed).toBe(true);
		expect(parsed.clients).toEqual(["codex"]);
	});
});

describe("reloadCommand — defaults", () => {
	it("defaults to the current working directory when no cwd is given", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(
			reloadCommand({ json: true, build: false, force: true }),
		).resolves.toBeUndefined();

		const stdout = logSpy.mock.calls.map((args: unknown[]) => args.map(String).join(" ")).join("\n");
		const parsed = parseWire(JSON.parse(stdout), wireObject({ "cli_root": wireString }), "test JSON value");
		expect(typeof parsed.cli_root).toBe("string");
	});
});
