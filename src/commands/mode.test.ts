import { wireAbsentOptional, parseWire, wireArray, wireBoolean, wireNullable, wireNumber, wireObject, wireOptional, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `confirm()` in mode.ts reads a yes/no answer via fs.readSync(0, ...). The rest
// of this suite exercises real on-disk config files in a mkdtemp dir, so we mock
// node:fs as a *passthrough* (every real fn intact) and override only readSync
// with a per-test-controllable stub. The holder is hoisted so vi.mock — which is
// itself hoisted above the imports — can close over it.
const fsStub = vi.hoisted(() => ({
	// Returns 0 bytes by default (== EOF / empty answer == "no").
	readSyncImpl: (..._args: unknown[]): number => 0,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readSync: (...args: unknown[]) => fsStub.readSyncImpl(...args),
	};
});

// `getPreset()` in ../harness/modes.js is a hardcoded lookup table (three
// names) that `isKnownMode()` — a separate hardcoded literal check (four
// names, "custom" included) — is expected to stay in lockstep with. Real
// callers can never observe the two disagreeing, so the "no preset defined"
// branch in mode.ts is unreachable through any live ModeName; it is a
// defensive guard against exactly that drift. We mock modes.js as the same
// kind of passthrough as node:fs above, with a per-test override so one test
// can simulate the drift without touching the real registry for anyone else.
const modesStub = vi.hoisted((): {
	getPresetOverride: typeof import("../harness/modes.js").getPreset | null;
} => ({
	getPresetOverride: null,
}));

vi.mock("../harness/modes.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../harness/modes.js")>();
	return {
		...actual,
		getPreset: (name: Parameters<typeof actual.getPreset>[0]) =>
			modesStub.getPresetOverride
				? modesStub.getPresetOverride(name)
				: actual.getPreset(name),
	};
});

const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import(
	"node:fs"
);
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { modeCommand, writeMode } = await import("./mode.js");

/** Sentinel: make the next readSync throw (exercises readLineSync's catch). */
const THROW = Symbol("readSync-throws");
/** Make confirm() answer with `answer` bytes (or throw on read). */
function primeConfirm(answer: string | typeof THROW): void {
	if (answer === THROW) {
		fsStub.readSyncImpl = () => {
			throw new Error("simulated read failure");
		};
		return;
	}
	fsStub.readSyncImpl = (_fd: unknown, buf: unknown) => {
		if (!Buffer.isBuffer(buf)) throw new Error("expected the confirmation read buffer");
		return buf.write(answer, 0, "utf-8");
	};
}

let tmp = "";
// SPY, not process.chdir(): chdir THROWS in a worker thread ("process.chdir()
// is not supported in workers"), and Stryker's vitest runner pins its own
// pool, so a real chdir here fails the mutation dry run for any file whose
// graph-selected test scope includes this one. modeCommand/writeMode read
// `process.cwd()` explicitly, so the spy exercises the same path.
let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;
let originalIsTTY: boolean | undefined;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-mode-"));
	cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
	mkdirSync(join(tmp, ".interlinked"));
	process.exitCode = 0;
	originalIsTTY = process.stdin.isTTY;
	// readSync stub resets to EOF/"no" before each test; opt-in per test.
	fsStub.readSyncImpl = () => 0;
});
afterEach(() => {
	cwdSpy?.mockRestore();
	process.exitCode = 0;
	rmSync(tmp, { recursive: true, force: true });
	(parseWire(process.stdin, wireObject({ "isTTY": wireAbsentOptional(wireOptional(wireBoolean)) }), "test JSON value")).isTTY = originalIsTTY;
});

function captureStdout(): { text: () => string; restore: () => void } {
	let captured = "";
	const spy = vi.spyOn(process.stdout, "write").mockImplementation((
		buf: string | Uint8Array,
	) => {
		captured += typeof buf === "string" ? buf : Buffer.from(buf).toString("utf-8");
		return true;
	});
	return { text: () => captured, restore: () => spy.mockRestore() };
}

describe("writeMode", () => {
	it("creates the shared config when absent", () => {
		writeMode(tmp, "strict", false);
		const path = join(tmp, ".interlinked", "check-policy.json");
		expect(existsSync(path)).toBe(true);
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed.mode).toBe("strict");
		expect(parsed.version).toBe(1);
	});

	it("preserves existing fields when updating mode", () => {
		const path = join(tmp, ".interlinked", "check-policy.json");
		writeFileSync(
			path,
			JSON.stringify({ version: 1, checks: { focused_tests: { action: "block_preview" } } }),
		);
		writeMode(tmp, "strict", false);
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed.mode).toBe("strict");
		expect(parsed.checks.focused_tests.action).toBe("block_preview");
	});

	it("writes to the local file when local=true", () => {
		writeMode(tmp, "lenient", true);
		expect(existsSync(join(tmp, ".interlinked", "check-policy.local.json"))).toBe(true);
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
	});
});

describe("writeMode — enforcement-gate posture (guard-rules.json ladder)", () => {
	function readGuardRules(): Record<string, unknown> {
		return JSON.parse(readFileSync(join(tmp, ".interlinked", "guard-rules.json"), "utf-8"));
	}

	// test-contract: behavior — a mode is a posture: strict/balanced/lenient must
	// ladder the TDD gate, per-edit coverage, and session-end nudges (2026-08-17).
	it("P: strict sets TDD enforce, characterize block, and strict per-edit coverage (no debt)", () => {
		writeMode(tmp, "strict", false);
		expect(readGuardRules()).toMatchObject({
			structural_checks: {
				test_first: true,
				test_first_mode: "enforce",
				characterize_mode: "block",
			},
			per_edit_coverage: { enabled: true, debt_mode: false },
			verification_stop_checks: { enabled: true },
			commit_cadence: { enabled: true },
		});
	});

	it("P: balanced sets TDD warn and debt-mode coverage", () => {
		writeMode(tmp, "balanced", false);
		expect(readGuardRules()).toMatchObject({
			structural_checks: { test_first: true, test_first_mode: "warn" },
			per_edit_coverage: { enabled: true, debt_mode: true },
		});
	});

	it("P: lenient turns the gates and nudges off", () => {
		writeMode(tmp, "lenient", false);
		expect(readGuardRules()).toMatchObject({
			structural_checks: { test_first: false, characterize_mode: "off" },
			per_edit_coverage: { enabled: false },
			verification_stop_checks: { enabled: false },
			commit_cadence: { enabled: false },
		});
	});

	it("P: the merge preserves unrelated guard-rules sections", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "guard-rules.json"),
			JSON.stringify({ diff_aware: { enabled: true }, per_edit_coverage: { debt_wip_limit: 2 } }),
		);
		writeMode(tmp, "strict", false);
		const rules = readGuardRules();
		expect(rules).toMatchObject({
			diff_aware: { enabled: true },
			per_edit_coverage: { enabled: true, debt_mode: false, debt_wip_limit: 2 },
		});
	});

	it("N: custom applies no gate overrides at all", () => {
		writeMode(tmp, "custom", false);
		expect(existsSync(join(tmp, ".interlinked", "guard-rules.json"))).toBe(false);
	});
});

describe("modeCommand — show current", () => {
	it("reports built-in default when no config exists", async () => {
		const cap = captureStdout();
		await modeCommand(undefined, {});
		cap.restore();
		expect(cap.text()).toContain("Current: balanced");
		expect(cap.text()).toContain("built-in default");
	});

	it("reports mode from a written shared config", async () => {
		writeMode(tmp, "strict", false);
		const cap = captureStdout();
		await modeCommand(undefined, {});
		cap.restore();
		expect(cap.text()).toContain("Current: strict");
	});

	it("JSON output enumerates available modes", async () => {
		const cap = captureStdout();
		await modeCommand(undefined, { json: true });
		cap.restore();
		const payload = parseWire(JSON.parse(cap.text()), wireObject({ "mode": wireString, "available_modes": wireArray(wireObject({ "name": wireString })) }), "test JSON value");
		expect(payload.mode).toBe("balanced");
		expect(payload.available_modes.length).toBe(3);
	});
});

describe("modeCommand — diff preview", () => {
	it("prints changes that strict would introduce", async () => {
		const cap = captureStdout();
		await modeCommand("strict", { diff: true });
		cap.restore();
		expect(cap.text()).toContain("Switching to strict would change");
		expect(cap.text()).toContain("focused_tests");
	});

	it("reports no changes when switching balanced → balanced", async () => {
		const cap = captureStdout();
		await modeCommand("balanced", { diff: true });
		cap.restore();
		expect(cap.text()).toContain("would not change");
	});

	it("JSON diff output is a structured list", async () => {
		const cap = captureStdout();
		await modeCommand("strict", { diff: true, json: true });
		cap.restore();
		const payload = parseWire(JSON.parse(cap.text()), wireObject({ "mode": wireString, "changes": wireArray(wireUnknown) }), "test JSON value");
		expect(payload.mode).toBe("strict");
		expect(payload.changes.length).toBeGreaterThan(0);
	});
});

describe("modeCommand — apply with --force", () => {
	it("writes the shared file and reports success", async () => {
		const cap = captureStdout();
		await modeCommand("strict", { force: true });
		cap.restore();
		expect(cap.text()).toContain("Mode set to strict");
		const parsed = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "check-policy.json"), "utf-8"),
		);
		expect(parsed.mode).toBe("strict");
	});

	it("writes the local override with --local", async () => {
		const cap = captureStdout();
		await modeCommand("lenient", { force: true, local: true });
		cap.restore();
		expect(existsSync(join(tmp, ".interlinked", "check-policy.local.json"))).toBe(true);
	});

	it("JSON output reports the written path", async () => {
		const cap = captureStdout();
		await modeCommand("strict", { force: true, json: true });
		cap.restore();
		const payload = parseWire(JSON.parse(cap.text()), wireObject({ "ok": wireBoolean, "path": wireString, "scope": wireString }), "test JSON value");
		expect(payload.ok).toBe(true);
		expect(payload.path.endsWith("check-policy.json")).toBe(true);
		expect(payload.scope).toBe("shared");
	});

	it("JSON output reports the local scope and path with --local", async () => {
		const cap = captureStdout();
		await modeCommand("lenient", { force: true, json: true, local: true });
		cap.restore();
		const payload = parseWire(JSON.parse(cap.text()), wireObject({ "ok": wireBoolean, "mode": wireString, "scope": wireString, "path": wireString }), "test JSON value");
		expect(payload.ok).toBe(true);
		expect(payload.mode).toBe("lenient");
		expect(payload.scope).toBe("local");
		expect(payload.path.endsWith("check-policy.local.json")).toBe(true);
		expect(existsSync(join(tmp, ".interlinked", "check-policy.local.json"))).toBe(true);
	});

	it("non-JSON --local apply reports the personal-override scope", async () => {
		const cap = captureStdout();
		await modeCommand("strict", { force: true, local: true });
		cap.restore();
		expect(cap.text()).toContain("Mode set to strict (personal override)");
	});
});

describe("modeCommand — error paths", () => {
	it("rejects unknown mode names", async () => {
		const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await modeCommand("super-strict", { force: true });
		expect(process.exitCode).toBe(1);
		spy.mockRestore();
	});

	it("unknown mode in JSON mode emits a structured failure to stdout", async () => {
		const cap = captureStdout();
		await modeCommand("super-strict", { json: true });
		cap.restore();
		const payload = parseWire(JSON.parse(cap.text()), wireObject({ "ok": wireBoolean, "reason": wireString }), "test JSON value");
		expect(payload.ok).toBe(false);
		expect(payload.reason).toContain("unknown mode: super-strict");
		// Known modes are listed so the caller can recover.
		expect(payload.reason).toContain("balanced");
		expect(process.exitCode).toBe(1);
	});

	it("reports 'no preset defined' when a mode passes isKnownMode but the preset registry has drifted", async () => {
		// isKnownMode() and getPreset() are two separately-hardcoded lookups that
		// must stay in lockstep; through the real registry every known non-custom
		// mode has a preset, so this branch is otherwise unreachable. Simulate the
		// drift via the modes.js mock so the branch is still exercised through the
		// real modeCommand entry point.
		modesStub.getPresetOverride = () => null;
		try {
			const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			await modeCommand("strict", { force: true });
			const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
			stderrSpy.mockRestore();
			expect(stderrText).toContain("[interlinked] no preset defined for strict");
			expect(process.exitCode).toBe(1);
			expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
		} finally {
			modesStub.getPresetOverride = null;
		}
	});
});

describe("modeCommand — writeMode failure surfaces via the command-level fail() wrapper", () => {
	// test-contract: behavior — when writeMode() returns false (here: a
	// malformed guard-rules.json refuses the merge), modeCommand's own fail()
	// call must fire too, distinct from writeMode's internal stderr line —
	// pins the caller-side message and that no partial write survives.
	it("reports 'not applied' to stderr and sets exitCode 1 when writeMode fails", async () => {
		writeFileSync(join(tmp, ".interlinked", "guard-rules.json"), "{ not valid json");
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await modeCommand("strict", { force: true });
		const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		stderrSpy.mockRestore();
		expect(stderrText).toContain(
			"mode strict not applied — see the error above; neither file was changed",
		);
		expect(process.exitCode).toBe(1);
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
	});
});

describe("modeCommand — interactive confirmation (no --force, no --json)", () => {
	it("applies the mode when the user answers yes", async () => {
		(parseWire(process.stdin, wireObject({ "isTTY": wireAbsentOptional(wireOptional(wireBoolean)) }), "test JSON value")).isTTY = true;
		primeConfirm("y\n");
		const cap = captureStdout();
		await modeCommand("strict", {});
		cap.restore();
		// Diff preview rendered first, then the confirm prompt, then success.
		expect(cap.text()).toContain("Switching to strict would change");
		expect(cap.text()).toContain("Apply strict mode?");
		expect(cap.text()).toContain("Mode set to strict");
		const parsed = parseWire(JSON.parse(
			readFileSync(join(tmp, ".interlinked", "check-policy.json"), "utf-8"),
		), wireObject({ "mode": wireString }), "test JSON value");
		expect(parsed.mode).toBe("strict");
	});

	it("accepts a full 'yes' (case-insensitive) as confirmation", async () => {
		(parseWire(process.stdin, wireObject({ "isTTY": wireAbsentOptional(wireOptional(wireBoolean)) }), "test JSON value")).isTTY = true;
		primeConfirm("YES\n");
		const cap = captureStdout();
		await modeCommand("lenient", {});
		cap.restore();
		expect(cap.text()).toContain("Mode set to lenient");
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(true);
	});

	it("aborts (no write) when the user answers no", async () => {
		(parseWire(process.stdin, wireObject({ "isTTY": wireAbsentOptional(wireOptional(wireBoolean)) }), "test JSON value")).isTTY = true;
		primeConfirm("n\n");
		const cap = captureStdout();
		await modeCommand("strict", {});
		cap.restore();
		expect(cap.text()).toContain("Aborted.");
		expect(cap.text()).not.toContain("Mode set to");
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
	});

	it("aborts when stdin is not a TTY (non-interactive shells never confirm)", async () => {
		(parseWire(process.stdin, wireObject({ "isTTY": wireAbsentOptional(wireOptional(wireBoolean)) }), "test JSON value")).isTTY = false;
		// readSync must NOT be consulted in this path; make it explode if it is.
		primeConfirm(THROW);
		const cap = captureStdout();
		await modeCommand("strict", {});
		cap.restore();
		expect(cap.text()).toContain("Aborted.");
		// The prompt is never written when there's no TTY.
		expect(cap.text()).not.toContain("Apply strict mode?");
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
	});

	it("treats a readSync failure as a declined prompt (catch → empty answer)", async () => {
		(parseWire(process.stdin, wireObject({ "isTTY": wireAbsentOptional(wireOptional(wireBoolean)) }), "test JSON value")).isTTY = true;
		primeConfirm(THROW);
		const cap = captureStdout();
		await modeCommand("strict", {});
		cap.restore();
		// Prompt is shown (TTY), read throws → "" → not a yes → abort.
		expect(cap.text()).toContain("Apply strict mode?");
		expect(cap.text()).toContain("Aborted.");
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
	});

	it("treats whitespace-only / empty input as a declined prompt", async () => {
		(parseWire(process.stdin, wireObject({ "isTTY": wireAbsentOptional(wireOptional(wireBoolean)) }), "test JSON value")).isTTY = true;
		primeConfirm("   \n");
		const cap = captureStdout();
		await modeCommand("lenient", {});
		cap.restore();
		expect(cap.text()).toContain("Aborted.");
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
	});
});

describe("modeCommand — custom mode (no preset)", () => {
	it("diff against custom uses the current default action (null preset)", async () => {
		// custom has no preset; computeDiff falls back to the current default
		// action for every check, so a diff from the built-in balanced policy
		// (also warn_after default) yields no action changes.
		const cap = captureStdout();
		await modeCommand("custom", { diff: true });
		cap.restore();
		expect(cap.text()).toContain("Switching to custom would not change");
	});

	it("custom diff reflects changes when the current policy default differs", async () => {
		// Put the repo into lenient (default_action: info) so switching to custom
		// (which reverts to the current default — still 'info' here, since the
		// loaded policy already applied lenient) shows no spurious churn, while a
		// per-check override that differs from the default DOES surface.
		writeFileSync(
			join(tmp, ".interlinked", "check-policy.json"),
			JSON.stringify({
				version: 1,
				mode: "custom",
				defaults: { action: "warn_after" },
				checks: { focused_tests: { action: "block_preview" } },
			}),
		);
		const cap = captureStdout();
		await modeCommand("custom", { diff: true });
		cap.restore();
		// focused_tests is pinned to block_preview but custom reverts it to the
		// default warn_after → one change row.
		expect(cap.text()).toContain("Switching to custom would change");
		expect(cap.text()).toContain("focused_tests");
		expect(cap.text()).toContain("block_preview");
		expect(cap.text()).toContain("warn_after");
	});

	it("applies custom via --force without requiring a preset", async () => {
		const cap = captureStdout();
		await modeCommand("custom", { force: true });
		cap.restore();
		expect(cap.text()).toContain("Mode set to custom");
		const parsed = parseWire(JSON.parse(
			readFileSync(join(tmp, ".interlinked", "check-policy.json"), "utf-8"),
		), wireObject({ "mode": wireString }), "test JSON value");
		expect(parsed.mode).toBe("custom");
	});
});

describe("modeCommand — show current with a local override present", () => {
	it("text output reports the personal-override source", async () => {
		writeMode(tmp, "lenient", true); // .local.json
		const cap = captureStdout();
		await modeCommand(undefined, {});
		cap.restore();
		expect(cap.text()).toContain("Current: lenient");
		expect(cap.text()).toContain("personal override");
		expect(cap.text()).toContain("check-policy.local.json");
		// Effective per-check action counts are rendered (lenient => info default).
		expect(cap.text()).toContain("Effective per-check action counts:");
		expect(cap.text()).toMatch(/info\s+\d+/);
	});

	it("text output falls back to the shared-config source when only it exists", async () => {
		writeMode(tmp, "strict", false); // .json only
		const cap = captureStdout();
		await modeCommand(undefined, {});
		cap.restore();
		expect(cap.text()).toContain("shared config");
		expect(cap.text()).toContain("check-policy.json");
		expect(cap.text()).not.toContain("personal override");
	});

	it("JSON output reports both shared and local paths when both exist", async () => {
		writeMode(tmp, "strict", false); // shared
		writeMode(tmp, "lenient", true); // local override wins
		const cap = captureStdout();
		await modeCommand(undefined, { json: true });
		cap.restore();
		const payload = parseWire(JSON.parse(cap.text()), wireObject({ "mode": wireString, "shared_path": wireNullable(wireString), "local_path": wireNullable(wireString) }), "test JSON value");
		// Local override wins for the effective mode.
		expect(payload.mode).toBe("lenient");
		expect(payload.shared_path).not.toBeNull();
		expect(payload.local_path).not.toBeNull();
		expect((payload.shared_path ?? "").endsWith("check-policy.json")).toBe(true);
		expect((payload.local_path ?? "").endsWith("check-policy.local.json")).toBe(true);
	});

	it("JSON output reports null paths when no config files exist", async () => {
		const cap = captureStdout();
		await modeCommand(undefined, { json: true });
		cap.restore();
		const payload = parseWire(JSON.parse(cap.text()), wireObject({ "shared_path": wireNullable(wireString), "local_path": wireNullable(wireString) }), "test JSON value");
		expect(payload.shared_path).toBeNull();
		expect(payload.local_path).toBeNull();
	});
});

describe("modeCommand — unknown mode message lists known modes comma-separated", () => {
	// test-contract: behavior — the join(", ") must keep both the comma AND the
	// space, or the listed names run together illegibly.
	it("P: joins known mode names with ', '", async () => {
		const cap = captureStdout();
		await modeCommand("super-strict", { json: true });
		cap.restore();
		const payload = parseWire(JSON.parse(cap.text()), wireObject({ "reason": wireString }), "test JSON value");
		expect(payload.reason).toContain("strict, lenient, balanced");
	});
});

describe("modeCommand — force-only apply skips the diff preview", () => {
	// test-contract: behavior — `--force` alone (no --diff, no --json) must take
	// the direct-write path; the AND in the guard condition is load-bearing.
	it("P: --force without --json does not render a diff preview first", async () => {
		const cap = captureStdout();
		await modeCommand("strict", { force: true });
		cap.restore();
		expect(cap.text()).not.toContain("Switching to strict would change");
		expect(cap.text()).not.toContain("would not change");
		expect(cap.text()).toContain("Mode set to strict");
	});
});

describe("modeCommand — non-JSON apply scope wording", () => {
	// test-contract: behavior — the shared-config wording is a distinct literal
	// from "personal override"; either could silently go missing.
	it("P: apply without --local reports '(shared config)'", async () => {
		const cap = captureStdout();
		await modeCommand("strict", { force: true });
		cap.restore();
		expect(cap.text()).toContain("Mode set to strict (shared config).");
	});
});

describe("modeCommand — show current, literal text fixtures", () => {
	// test-contract: behavior — each of these literals is independently
	// deletable by a StringLiteral mutator; pin them all explicitly.
	it("P: prints the 'Source : ' label before the source line", async () => {
		const cap = captureStdout();
		await modeCommand(undefined, {});
		cap.restore();
		expect(cap.text()).toContain("Source : built-in default");
	});

	it("P: prints the 'Available modes:' heading", async () => {
		const cap = captureStdout();
		await modeCommand(undefined, {});
		cap.restore();
		expect(cap.text()).toContain("\nAvailable modes:\n");
	});

	it("P: lists every preset name + description under 'Available modes'", async () => {
		const cap = captureStdout();
		await modeCommand(undefined, {});
		cap.restore();
		const text = cap.text();
		// Each preset row is "  <name padded to 10> <description>\n" — assert the
		// loop body actually ran (not silenced to a no-op) for a known preset.
		expect(text).toMatch(/strict {4,}.+\n/);
		expect(text).toMatch(/lenient {3,}.+\n/);
		expect(text).toMatch(/balanced {2,}.+\n/);
	});

	it("P: prints the 'Switch:' usage hint line", async () => {
		const cap = captureStdout();
		await modeCommand(undefined, {});
		cap.restore();
		expect(cap.text()).toContain("\nSwitch: interlinked mode <name> [--diff] [--local]\n");
	});

	it("P: JSON available_modes entries carry real name/description fields", async () => {
		const cap = captureStdout();
		await modeCommand(undefined, { json: true });
		cap.restore();
		const payload = parseWire(JSON.parse(cap.text()), wireObject({ "available_modes": wireArray(wireObject({ "name": wireString, "description": wireString })) }), "test JSON value");
		for (const m of payload.available_modes) {
			expect(typeof m.name).toBe("string");
			expect(m.name.length).toBeGreaterThan(0);
			expect(typeof m.description).toBe("string");
			expect(m.description.length).toBeGreaterThan(0);
		}
		const names = payload.available_modes.map((m) => m.name).sort();
		expect(names).toEqual(["balanced", "lenient", "strict"]);
	});
});

describe("modeCommand — renderEffectiveActions omits zero-count buckets", () => {
	// test-contract: behavior — only actions with count > 0 print; a policy that
	// funnels every check into a single action must show exactly that one line.
	it("P: a policy with every check mapped to 'ask' prints only the 'ask' row", async () => {
		writeFileSync(
			join(tmp, ".interlinked", "check-policy.json"),
			JSON.stringify({ version: 1, mode: "custom", defaults: { action: "ask" }, checks: {} }),
		);
		const cap = captureStdout();
		await modeCommand(undefined, {});
		cap.restore();
		const text = cap.text();
		expect(text).toMatch(/ {2}ask {12}\d+\n/);
		expect(text).not.toMatch(/ {2}silent {10}\d+\n/);
		expect(text).not.toMatch(/ {2}info {13}\d+\n/);
		expect(text).not.toMatch(/ {2}ratchet {8}\d+\n/);
	});
});

describe("modeCommand — describeCheck label resolution (diff output)", () => {
	// test-contract: behavior — the label column must be the REGISTRY entry's
	// human name for the exact check_id on that row, not empty/undefined/wrong.
	it("P: the focused_tests diff row carries its real registered label", async () => {
		const cap = captureStdout();
		await modeCommand("strict", { diff: true });
		cap.restore();
		const text = cap.text();
		expect(text).not.toContain("undefined");
		const row = text.split("\n").find((line) => line.includes("focused_tests"));
		expect(row).toBeDefined();
		expect(row).toMatch(/Focused Tests\s*$/);
	});
});

describe("writeMode — recursive directory creation", () => {
	// test-contract: behavior — mkdirSync must be called with { recursive: true }
	// so multiple missing ancestor directories are created in one call.
	it("P: creates every missing ancestor directory under a deeply nested cwd", () => {
		const fresh = mkdtempSync(join(tmpdir(), "interlinked-mode-deep-"));
		try {
			const deepCwd = join(fresh, "a", "b");
			expect(existsSync(deepCwd)).toBe(false);
			writeMode(deepCwd, "strict", false);
			const path = join(deepCwd, ".interlinked", "check-policy.json");
			expect(existsSync(path)).toBe(true);
			expect(JSON.parse(readFileSync(path, "utf-8")).mode).toBe("strict");
		} finally {
			rmSync(fresh, { recursive: true, force: true });
		}
	});
});

describe("writeMode — mkdirSync is skipped when the directory already exists", () => {
	// test-contract: behavior — the `!existsSync(dir)` guard in writeMode must
	// actually gate ITS mkdirSync call. `mergeIntoGuardRules` (called later in
	// the same writeMode) always calls mkdirSync unconditionally for the same
	// directory, so the baseline is 1 call, not 0 — a mutant that drops the
	// guard adds a SECOND call for the identical already-existing directory.
	it("P: writeMode's own guard contributes no extra mkdirSync call when the dir exists", async () => {
		const fsMod = await import("node:fs");
		const spy = vi.spyOn(fsMod, "mkdirSync");
		try {
			// beforeEach already created `${tmp}/.interlinked`.
			writeMode(tmp, "strict", false);
			const dirCalls = spy.mock.calls.filter(
				(c) => c[0] === join(tmp, ".interlinked"),
			);
			expect(dirCalls.length).toBe(1);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("writeMode — applyModeGuardOverrides stderr reporting", () => {
	// test-contract: bug — review 2026-08-30: the old order wrote
	// check-policy.json FIRST, so a refused guard merge left a SPLIT posture
	// while the command reported success. The write is now transactional:
	// a refused merge reports to stderr, returns false, and leaves the
	// check-policy file unwritten (both-or-neither).
	it("P: a failed guard-rules merge refuses transactionally — no check-policy write", () => {
		writeFileSync(join(tmp, ".interlinked", "guard-rules.json"), "{ not valid json");
		const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const ok = writeMode(tmp, "strict", false);
			expect(ok).toBe(false);
			expect(spy).toHaveBeenCalled();
			const text = spy.mock.calls.map((c) => String(c[0])).join("");
			expect(text).toContain("[interlinked] mode strict: NOT applied");
			expect(text).toContain("Neither file was changed");
			expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
		} finally {
			spy.mockRestore();
			process.exitCode = 0;
		}
	});

	it("N: does not warn to stderr when the guard-rules merge succeeds", () => {
		const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			writeMode(tmp, "strict", false);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	// test-contract: behavior — the rollback restores the guard file to its
	// PRE-CALL state. When guard-rules.json did not exist before writeMode was
	// invoked (the null-snapshot case), the file applyModeGuardOverrides just
	// created must be UNLINKED, not left behind, once the check-policy write
	// that follows it fails.
	it("P: unlinks a newly-created guard-rules.json when the check-policy write fails afterward", async () => {
		const fsMod = await import("node:fs");
		const realWriteFileSync = fsMod.writeFileSync;
		const writeSpy = vi.spyOn(fsMod, "writeFileSync").mockImplementation((path, data, options) => {
			if (typeof path === "string" && path.endsWith("check-policy.json")) {
				throw new Error("simulated disk failure");
			}
			return realWriteFileSync(path, data, options);
		});
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const guardPath = join(tmp, ".interlinked", "guard-rules.json");
		const policyPath = join(tmp, ".interlinked", "check-policy.json");
		try {
			expect(existsSync(guardPath)).toBe(false);
			const ok = writeMode(tmp, "strict", false);
			expect(ok).toBe(false);
			// Rolled all the way back to the pre-call state: the file that
			// applyModeGuardOverrides created is gone again, and check-policy.json
			// (which threw) never landed.
			expect(existsSync(guardPath)).toBe(false);
			expect(existsSync(policyPath)).toBe(false);
			const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
			expect(text).toContain("check-policy write failed (simulated disk failure)");
			expect(text).toContain("guard changes rolled back; neither file was changed");
		} finally {
			writeSpy.mockRestore();
			stderrSpy.mockRestore();
			process.exitCode = 0;
		}
	});
});

describe("modeCommand — fail() writes exactly to stderr in non-JSON mode", () => {
	// test-contract: behavior — pins the branch, the message content, AND that
	// nothing leaks to stdout for a non-JSON failure.
	it("P: non-JSON failure writes the '[interlinked] <message>' line to stderr only", async () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const cap = captureStdout();
		await modeCommand("super-strict", { force: true });
		cap.restore();
		const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		stderrSpy.mockRestore();
		expect(stderrText).toContain("[interlinked] unknown mode: super-strict");
		expect(cap.text()).toBe("");
	});
});

describe("modeCommand — confirm() regex anchoring", () => {
	// test-contract: behavior — the yes/no regex must require a FULL match
	// (both ^ and $), not merely "contains yes somewhere".
	it("N: does not confirm when trailing garbage follows 'yes' (end anchor)", async () => {
		(parseWire(process.stdin, wireObject({ "isTTY": wireAbsentOptional(wireOptional(wireBoolean)) }), "test JSON value")).isTTY = true;
		primeConfirm("yesplease\n");
		const cap = captureStdout();
		await modeCommand("strict", {});
		cap.restore();
		expect(cap.text()).toContain("Aborted.");
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
	});

	it("N: does not confirm when 'yes' only appears as a suffix (start anchor)", async () => {
		(parseWire(process.stdin, wireObject({ "isTTY": wireAbsentOptional(wireOptional(wireBoolean)) }), "test JSON value")).isTTY = true;
		primeConfirm("xyz-yes\n");
		const cap = captureStdout();
		await modeCommand("strict", {});
		cap.restore();
		expect(cap.text()).toContain("Aborted.");
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
	});
});

describe("writeMode — edge cases", () => {
	it("creates the .interlinked directory when it is absent", () => {
		// Fresh sub-dir with NO .interlinked yet — exercises the mkdirSync branch.
		const fresh = mkdtempSync(join(tmpdir(), "interlinked-mode-fresh-"));
		try {
			expect(existsSync(join(fresh, ".interlinked"))).toBe(false);
			writeMode(fresh, "strict", false);
			expect(existsSync(join(fresh, ".interlinked"))).toBe(true);
			const parsed = parseWire(JSON.parse(
				readFileSync(join(fresh, ".interlinked", "check-policy.json"), "utf-8"),
			), wireObject({ "mode": wireString }), "test JSON value");
			expect(parsed.mode).toBe("strict");
		} finally {
			rmSync(fresh, { recursive: true, force: true });
		}
	});

	it("recovers from a malformed existing policy file (resets to version 1)", () => {
		const path = join(tmp, ".interlinked", "check-policy.json");
		writeFileSync(path, "{ this is not valid json ");
		writeMode(tmp, "lenient", false);
		const parsed = parseWire(JSON.parse(readFileSync(path, "utf-8")), wireObject({ "version": wireNumber, "mode": wireString }), "test JSON value");
		expect(parsed.mode).toBe("lenient");
		expect(parsed.version).toBe(1);
	});

	it("defaults version to 1 when the existing file omits it", () => {
		const path = join(tmp, ".interlinked", "check-policy.json");
		// Valid JSON but no `version` key — exercises the `?? 1` fallback.
		writeFileSync(path, JSON.stringify({ mode: "balanced", checks: {} }));
		writeMode(tmp, "strict", false);
		const parsed = parseWire(JSON.parse(readFileSync(path, "utf-8")), wireObject({ "version": wireNumber, "mode": wireString, "checks": wireRecord(wireUnknown) }), "test JSON value");
		expect(parsed.version).toBe(1);
		expect(parsed.mode).toBe("strict");
		// Pre-existing (non-version) fields are preserved.
		expect(parsed.checks).toEqual({});
	});

	it("preserves a non-default version number already on disk", () => {
		const path = join(tmp, ".interlinked", "check-policy.json");
		writeFileSync(path, JSON.stringify({ version: 1, mode: "balanced" }));
		writeMode(tmp, "lenient", false);
		const parsed = parseWire(JSON.parse(readFileSync(path, "utf-8")), wireObject({ "version": wireNumber }), "test JSON value");
		expect(parsed.version).toBe(1);
	});
});
