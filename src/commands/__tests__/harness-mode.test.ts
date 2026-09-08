import { wireAbsentOptional, parseWire, wireBoolean, wireObject, wireOptional, wireRecord, wireString, wireUnknown } from "../../lib/value-validation.js";
// End-to-end tests for `interlinked harness mode [name]` — exercise the
// filesystem side effects (config.json write + .mjs hook regeneration) by
// pointing INTERLINKED_HOME at a fresh tmp dir per test. The command module
// reads / writes config through getConfigDir(), which honors that env var.
//
// We stub `process.stdout.write` / `process.stderr.write` directly instead
// of using `vi.spyOn` because vitest's spy machinery does not reliably
// intercept the multi-overload write signature on Node's WriteStream.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "../../harness/adapters/index.js";
import { nonNull } from "../../lib/non-null.js";
import { harnessModeCommand } from "../harness-mode.js";

let workDir: string;
let previousInterlinkedHome: string | undefined;
// SPY, not process.chdir(): chdir THROWS in a worker thread ("process.chdir()
// is not supported in workers"), and Stryker's vitest runner pins its own
// pool, so a real chdir here fails the mutation dry run for any file whose
// graph-selected test scope includes this one. harnessModeCommand reads
// `process.cwd()` explicitly, so the spy exercises the same path.
let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
	workDir = join(
		tmpdir(),
		`harness-mode-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(workDir, { recursive: true });
	mkdirSync(join(workDir, ".interlinked"), { recursive: true });
	previousInterlinkedHome = process.env.INTERLINKED_HOME;
	process.env.INTERLINKED_HOME = join(workDir, ".interlinked");
	cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(workDir);
});

afterEach(() => {
	cwdSpy?.mockRestore();
	if (previousInterlinkedHome === undefined) {
		delete process.env.INTERLINKED_HOME;
	} else {
		process.env.INTERLINKED_HOME = previousInterlinkedHome;
	}
	rmSync(workDir, { recursive: true, force: true });
});

function readSharedConfig(): Record<string, unknown> {
	const path = join(workDir, ".interlinked", "config.json");
	if (!existsSync(path)) return {};
	return parseWire(JSON.parse(readFileSync(path, "utf-8")), wireRecord(wireUnknown), "test JSON value");
}

function writeSharedConfigFile(data: Record<string, unknown>): void {
	const path = join(workDir, ".interlinked", "config.json");
	writeFileSync(path, JSON.stringify(data, null, 4));
}

function readGeneratedHook(): string | null {
	const path = join(workDir, ".interlinked", "hooks", "interlinked-activity.mjs");
	if (!existsSync(path)) return null;
	return readFileSync(path, "utf-8");
}

/** Write an installer manifest so `detectActiveRunner` resolves a runner.
 *  The manifest lives at `{cwd}/.interlinked/installer-manifest.json` (the
 *  command reads it via `manifestPath(process.cwd())`, NOT via
 *  INTERLINKED_HOME, so it must sit under the cwd's `.interlinked`). */
function writeInstallerManifest(runners: string[]): void {
	const path = join(workDir, ".interlinked", "installer-manifest.json");
	writeFileSync(
		path,
		JSON.stringify({
			schema_version: "1",
			// STRICT binding (2026-08-30): settings_path must equal the adapter's
			// own derivation for the scope, or the whole manifest reads corrupt.
			entries: runners.map((runner) => ({
				runner,
				scope: "project",
				settings_path: join(
					workDir,
					// SAFETY: these fixtures only name real runner ids.
					nonNull(getAdapter(runner as never)).renderSettingsFragment("/bin/interlinked-hook", "project").path,
				),
				added_paths: ["hooks.PreToolUse[0]"],
				binary_path: "/bin/interlinked-hook",
				installed_at: "2026-01-01T00:00:00Z",
			})),
		}),
	);
}

/** Write an installer manifest whose only entry has no usable runner field,
 *  so `coerceManifestEntry` drops it and `readManifest` returns []. Exercises
 *  the `entries.length > 0 ? ... : undefined` falsy arm in detectActiveRunner. */
function writeEmptyInstallerManifest(): void {
	const path = join(workDir, ".interlinked", "installer-manifest.json");
	writeFileSync(
		path,
		JSON.stringify({ schema_version: "1", entries: [{ not_a_runner: true }] }),
	);
}

interface CapturedStdio {
	stdout: string;
	stderr: string;
}

/** Direct stub replacement for process.stdout.write / process.stderr.write
 *  so the test runner reliably sees what the command emits. vi.spyOn does
 *  not consistently intercept the (chunk: string|Uint8Array) overload on
 *  Node's WriteStream — we observed empty `mock.calls` arrays during
 *  initial development, hence this manual installer. */
async function captureStdio(fn: () => Promise<void>): Promise<CapturedStdio> {
	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];
	const realStdoutWrite = process.stdout.write.bind(process.stdout);
	const realStderrWrite = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		stdoutChunks.push(
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"),
		);
		return true;
	});
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderrChunks.push(
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"),
		);
		return true;
	});
	try {
		await fn();
	} finally {
		process.stdout.write = realStdoutWrite;
		process.stderr.write = realStderrWrite;
	}
	return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

describe("harness mode — show current", () => {
	it("prints the default mode (`quality`) when nothing is configured", async () => {
		const captured = await captureStdio(() =>
			harnessModeCommand(undefined, { json: true }),
		);
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "mode": wireString }), "test JSON value");
		expect(parsed.mode).toBe("quality");
	});

	it("prints the persisted mode when set", async () => {
		writeSharedConfigFile({
			version: 1,
			server_url: "http://localhost:8787",
			mode: "ci",
		});
		const captured = await captureStdio(() =>
			harnessModeCommand(undefined, { json: true }),
		);
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "mode": wireString }), "test JSON value");
		expect(parsed.mode).toBe("ci");
	});

	it("auto-migrates a legacy `balanced` value to `quality` on read", async () => {
		writeSharedConfigFile({
			version: 1,
			server_url: "http://localhost:8787",
			mode: "balanced",
		});
		const captured = await captureStdio(() =>
			harnessModeCommand(undefined, { json: true }),
		);
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "mode": wireString }), "test JSON value");
		expect(parsed.mode).toBe("quality");
	});
});

describe("harness mode — switch", () => {
	it("persists the new mode to .interlinked/config.json", async () => {
		writeSharedConfigFile({
			version: 1,
			server_url: "http://localhost:8787",
		});
		await captureStdio(() => harnessModeCommand("budget", { json: true }));
		const config = readSharedConfig();
		expect(config.mode).toBe("budget");
	});

	it("creates config.json when missing, preserving the new mode", async () => {
		// No prior config.json; the command should create one.
		await captureStdio(() => harnessModeCommand("ci", { json: true }));
		const config = readSharedConfig();
		expect(config.mode).toBe("ci");
		expect(config.version).toBe(1);
	});

	it("regenerates the hook .mjs with the new HARNESS_POST_TIMEOUT_MS literal", async () => {
		writeSharedConfigFile({
			version: 1,
			server_url: "http://localhost:8787",
		});
		await captureStdio(() => harnessModeCommand("budget", { json: true }));
		const hook = readGeneratedHook();
		expect(hook).not.toBeNull();
		expect(hook).toContain("const HARNESS_POST_TIMEOUT_MS = 30000");
	});

	it("regenerates the hook with 50_000 ms for `quality`", async () => {
		writeSharedConfigFile({
			version: 1,
			server_url: "http://localhost:8787",
		});
		await captureStdio(() => harnessModeCommand("quality", { json: true }));
		const hook = readGeneratedHook();
		expect(hook).toContain("const HARNESS_POST_TIMEOUT_MS = 50000");
	});

	it("regenerates the hook with 60_000 ms for `ci`", async () => {
		writeSharedConfigFile({
			version: 1,
			server_url: "http://localhost:8787",
		});
		await captureStdio(() => harnessModeCommand("ci", { json: true }));
		const hook = readGeneratedHook();
		expect(hook).toContain("const HARNESS_POST_TIMEOUT_MS = 60000");
	});

	it("rejects unknown mode names with a useful error message", async () => {
		const previousExitCode = process.exitCode;
		const captured = await captureStdio(() =>
			harnessModeCommand("unknown_name", { json: false }),
		);
		const exitCode = process.exitCode;
		process.exitCode = previousExitCode;
		expect(captured.stderr).toMatch(/unknown harness mode/i);
		expect(captured.stderr).toContain("unknown_name");
		expect(exitCode).toBe(1);
	});

	it("rejects unknown mode names without writing the config", async () => {
		writeSharedConfigFile({
			version: 1,
			server_url: "http://localhost:8787",
			mode: "quality",
		});
		const previousExitCode = process.exitCode;
		await captureStdio(() => harnessModeCommand("super_secret", { json: false }));
		process.exitCode = previousExitCode;
		const config = readSharedConfig();
		// Mode unchanged — stays at quality
		expect(config.mode).toBe("quality");
	});

	it("emits a JSON rejection object (ok:false) when --json is set on a bad mode", async () => {
		const previousExitCode = process.exitCode;
		const captured = await captureStdio(() =>
			harnessModeCommand("totally_bogus", { json: true }),
		);
		const exitCode = process.exitCode;
		process.exitCode = previousExitCode;
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "ok": wireBoolean, "reason": wireString }), "test JSON value");
		expect(parsed.ok).toBe(false);
		expect(parsed.reason).toMatch(/unknown harness mode/i);
		expect(parsed.reason).toContain("totally_bogus");
		// JSON form prints to stdout, not stderr
		expect(captured.stderr).toBe("");
		expect(exitCode).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Human-readable (non-JSON) output paths — these are the lines that the
// JSON-only tests above never reach.
// ---------------------------------------------------------------------------
describe("harness mode — show current (human-readable)", () => {
	it("prints the current mode, its description, and the full mode menu", async () => {
		writeSharedConfigFile({
			version: 1,
			server_url: "http://localhost:8787",
			mode: "ci",
		});
		const captured = await captureStdio(() =>
			harnessModeCommand(undefined, { json: false }),
		);
		// Header line names the active mode.
		expect(captured.stdout).toContain("Current harness mode: ci");
		// Menu lists all three operational tiers with their second budgets.
		expect(captured.stdout).toContain("budget");
		expect(captured.stdout).toContain("quality");
		expect(captured.stdout).toContain("ci");
		expect(captured.stdout).toContain("30 s");
		expect(captured.stdout).toContain("50 s");
		expect(captured.stdout).toContain("60 s");
		// Footer tells the user how to switch.
		expect(captured.stdout).toContain("Switch: interlinked harness mode <name>");
		// Human-readable path never writes to stderr.
		expect(captured.stderr).toBe("");
	});
});

describe("harness mode — switch (human-readable)", () => {
	it("prints the runner-hint confirmation line on a successful switch", async () => {
		writeSharedConfigFile({
			version: 1,
			server_url: "http://localhost:8787",
		});
		const captured = await captureStdio(() =>
			harnessModeCommand("quality", { json: false }),
		);
		// tierHintForMode for quality mentions the 50 s budget.
		expect(captured.stdout).toContain("[interlinked] quality mode (50 s)");
		// And the restart reminder always follows on the human path.
		expect(captured.stdout).toContain(
			"Restart the harness to pick up the new timeout: interlinked harness restart",
		);
		const config = readSharedConfig();
		expect(config.mode).toBe("quality");
	});

	it("prints budget tier-hint wording when switching to budget", async () => {
		const captured = await captureStdio(() =>
			harnessModeCommand("budget", { json: false }),
		);
		expect(captured.stdout).toContain("[interlinked] budget mode (30 s)");
	});

	it("prints ci tier-hint wording when switching to ci", async () => {
		const captured = await captureStdio(() =>
			harnessModeCommand("ci", { json: false }),
		);
		expect(captured.stdout).toContain("[interlinked] ci mode (60 s)");
	});
});

// ---------------------------------------------------------------------------
// Runner-mismatch warning — exercised only when an installer manifest names a
// runner whose timeout floor is tighter than the chosen tier.
// ---------------------------------------------------------------------------
describe("harness mode — runner-mismatch warning (Copilot CLI floor)", () => {
	it("warns to stderr when a Copilot-CLI install switches to quality (human form)", async () => {
		writeInstallerManifest(["copilot-cli"]);
		const captured = await captureStdio(() =>
			harnessModeCommand("quality", { json: false }),
		);
		// The warning is routed to stderr (it's a soft nudge, not the result).
		expect(captured.stderr).toContain("Copilot CLI's hook timeout floor is 30 s");
		expect(captured.stderr).toContain("interlinked harness mode budget");
		// stdout still carries the normal confirmation.
		expect(captured.stdout).toContain("[interlinked] quality mode (50 s)");
	});

	it("surfaces the warning inside the JSON payload (warning key) for Copilot + ci", async () => {
		writeInstallerManifest(["copilot-cli"]);
		const captured = await captureStdio(() =>
			harnessModeCommand("ci", { json: true }),
		);
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "ok": wireBoolean, "mode": wireString, "warning": wireAbsentOptional(wireOptional(wireString)) }), "test JSON value");
		expect(parsed.ok).toBe(true);
		expect(parsed.mode).toBe("ci");
		expect(parsed.warning).toBeDefined();
		expect(parsed.warning).toContain("Copilot CLI's hook timeout floor");
		// JSON path emits nothing to stderr.
		expect(captured.stderr).toBe("");
	});

	it("emits NO warning when a Copilot-CLI install switches to budget", async () => {
		writeInstallerManifest(["copilot-cli"]);
		const captured = await captureStdio(() =>
			harnessModeCommand("budget", { json: true }),
		);
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "warning": wireAbsentOptional(wireOptional(wireString)) }), "test JSON value");
		// budget fits the 30 s floor — no mismatch, no warning key.
		expect(parsed.warning).toBeUndefined();
		expect(captured.stderr).toBe("");
	});

	it("emits NO warning for a non-Copilot runner on a non-budget tier", async () => {
		// claude-code has a 60 s budget, so quality (50 s) is fine.
		writeInstallerManifest(["claude-code"]);
		const captured = await captureStdio(() =>
			harnessModeCommand("quality", { json: true }),
		);
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "warning": wireAbsentOptional(wireOptional(wireString)) }), "test JSON value");
		expect(parsed.warning).toBeUndefined();
		expect(captured.stderr).toBe("");
	});
});

// ---------------------------------------------------------------------------
// Active-runner detection via the installer manifest. detectActiveRunner is
// reached on both the show path (legacy-migration input) and the switch path
// (mismatch input); these tests pin both arms of its entries.length ternary.
// ---------------------------------------------------------------------------
describe("harness mode — active-runner detection", () => {
	it("migrates legacy `balanced` to `budget` when the manifest names copilot-cli", async () => {
		// detectActiveRunner returns copilot-cli, so balanced → budget (not quality).
		writeInstallerManifest(["copilot-cli"]);
		writeSharedConfigFile({
			version: 1,
			server_url: "http://localhost:8787",
			mode: "balanced",
		});
		const captured = await captureStdio(() =>
			harnessModeCommand(undefined, { json: true }),
		);
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "mode": wireString }), "test JSON value");
		expect(parsed.mode).toBe("budget");
	});

	it("falls back to quality when the manifest has no usable runner entries", async () => {
		// readManifest drops the malformed entry → entries.length === 0 →
		// detectActiveRunner returns undefined → balanced migrates to quality.
		writeEmptyInstallerManifest();
		writeSharedConfigFile({
			version: 1,
			server_url: "http://localhost:8787",
			mode: "balanced",
		});
		const captured = await captureStdio(() =>
			harnessModeCommand(undefined, { json: true }),
		);
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "mode": wireString }), "test JSON value");
		expect(parsed.mode).toBe("quality");
	});

	it("uses the FIRST manifest entry's runner when several are present", async () => {
		// entries[0] is copilot-cli → mismatch fires on a quality switch even
		// though a later claude-code entry would not.
		writeInstallerManifest(["copilot-cli", "claude-code"]);
		const captured = await captureStdio(() =>
			harnessModeCommand("quality", { json: true }),
		);
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "warning": wireAbsentOptional(wireOptional(wireString)) }), "test JSON value");
		expect(parsed.warning).toBeDefined();
		expect(parsed.warning).toContain("Copilot CLI");
	});
});

// ---------------------------------------------------------------------------
// readSharedConfigSafe resilience — the switch path must not throw on a
// corrupt or server_url-less config; it falls back to safe defaults and the
// switch still persists.
// ---------------------------------------------------------------------------
describe("harness mode — config resilience on switch", () => {
	it("recovers from a malformed (non-JSON) config.json and still writes the mode", async () => {
		// readSharedConfigSafe's JSON.parse throws → catch returns defaults.
		writeFileSync(
			join(workDir, ".interlinked", "config.json"),
			"{ this is not valid json ",
		);
		const captured = await captureStdio(() =>
			harnessModeCommand("ci", { json: true }),
		);
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "ok": wireBoolean, "mode": wireString }), "test JSON value");
		expect(parsed.ok).toBe(true);
		expect(parsed.mode).toBe("ci");
		const config = readSharedConfig();
		// The rewrite repaired the file: valid JSON with the new mode + defaults.
		expect(config.mode).toBe("ci");
		expect(config.version).toBe(1);
		expect(config.server_url).toBe("http://localhost:8787");
	});

	it("supplies the default server_url when the existing config omits it", async () => {
		// Valid JSON but no server_url → readSharedConfigSafe fills the default.
		writeSharedConfigFile({ version: 1, mode: "budget" });
		const captured = await captureStdio(() =>
			harnessModeCommand("ci", { json: true }),
		);
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "ok": wireBoolean }), "test JSON value");
		expect(parsed.ok).toBe(true);
		const config = readSharedConfig();
		expect(config.server_url).toBe("http://localhost:8787");
		expect(config.mode).toBe("ci");
	});

	it("preserves unrelated pre-existing config fields across a switch", async () => {
		writeSharedConfigFile({
			version: 1,
			server_url: "https://example.invalid:9999",
			default_project: "synthetic-project",
			mode: "quality",
		});
		await captureStdio(() => harnessModeCommand("budget", { json: true }));
		const config = readSharedConfig();
		expect(config.mode).toBe("budget");
		// Custom server_url is retained (truthy, so the || fallback is skipped).
		expect(config.server_url).toBe("https://example.invalid:9999");
		// Other keys survive the spread.
		expect(config.default_project).toBe("synthetic-project");
	});

	it("P1: preserves an existing string mode across an unrelated read (still current behavior)", async () => {
		writeSharedConfigFile({ version: 1, server_url: "http://localhost:8787", mode: "quality" });
		await captureStdio(() => harnessModeCommand("budget", { json: true }));
		const config = readSharedConfig();
		expect(config.mode).toBe("budget"); // the switch overwrites mode, as designed
		expect(config.server_url).toBe("http://localhost:8787");
	});

	it("N1: a top-level JSON array config.json falls back to defaults instead of spreading numeric-string keys", async () => {
		// Before the isJsonObject gate, `{...parsed}` on an array spread its
		// indices ("0","1","2") into the returned SharedConfig, and THAT got
		// persisted back to the committed config.json on this write.
		writeFileSync(join(workDir, ".interlinked", "config.json"), JSON.stringify(["a", "b", "c"]));
		const captured = await captureStdio(() => harnessModeCommand("ci", { json: true }));
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "ok": wireBoolean, "mode": wireString }), "test JSON value");
		expect(parsed.ok).toBe(true);
		expect(parsed.mode).toBe("ci");
		const config = readSharedConfig();
		expect(config.mode).toBe("ci");
		expect(config.server_url).toBe("http://localhost:8787");
		expect(config["0"]).toBeUndefined();
		expect(config["1"]).toBeUndefined();
		expect(config["2"]).toBeUndefined();
	});

	it("N2: a bare JSON null config.json falls back to defaults without throwing", async () => {
		writeFileSync(join(workDir, ".interlinked", "config.json"), "null");
		const captured = await captureStdio(() => harnessModeCommand("ci", { json: true }));
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "ok": wireBoolean, "mode": wireString }), "test JSON value");
		expect(parsed.ok).toBe(true);
		expect(parsed.mode).toBe("ci");
		const config = readSharedConfig();
		expect(config.mode).toBe("ci");
		expect(config.server_url).toBe("http://localhost:8787");
		// A `null` payload passes `typeof value === "object"`, so without the
		// explicit `value !== null` guard in isJsonObject, `{...parsed}` would
		// spread nothing (harmless) but `parsed.server_url` would throw on
		// null — pin the repaired file's version too, not just server_url.
		expect(config.version).toBe(1);
		const rewritten = readFileSync(join(workDir, ".interlinked", "config.json"), "utf-8");
		expect(() => JSON.parse(rewritten)).not.toThrow();
		expect(JSON.parse(rewritten)).not.toBeNull();
	});
});
