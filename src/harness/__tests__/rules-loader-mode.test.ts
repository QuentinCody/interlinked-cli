import { nonNull } from "../../lib/non-null.js";
// ===========================================
// Phase C — mode preset enablement integration
// ===========================================
// `rules/modes.ts` defines `quality_checks_enabled` per preset, but until
// the rules-loader applies that map onto the loaded config, switching to
// `budget` only lowered the hook timeout while still running structural /
// semgrep / prompt-injection at their built-in defaults. These tests pin
// the loader's mode-application behavior so the regression doesn't
// resurface — and so user overrides keep winning over the preset.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuardRule, GuardRulesConfig } from "../types.js";

// `rules-loader.ts` imports `watchFile` / `unwatchFile` as static named ESM
// bindings, so they can't be spied on the namespace object after load. Mock
// `node:fs` at the module boundary instead: every real function passes through
// (so `loadRules` keeps reading real temp files), but the two watch hooks are
// captured into `fsWatchState` so the watch tests can fire listeners
// synchronously and assert (un)registration without 2s poll latency.
const fsWatchState = vi.hoisted(() => {
	const watch: Array<{ path: string; listener: (...args: unknown[]) => void }> = [];
	const unwatch: Array<{ path: string; listener: (...args: unknown[]) => void }> = [];
	return {
		watch,
		unwatch,
		reset() {
			watch.length = 0;
			unwatch.length = 0;
		},
	};
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		watchFile: (path: unknown, _opts: unknown, listener: (...a: unknown[]) => void) => {
			fsWatchState.watch.push({ path: String(path), listener });
		},
		unwatchFile: (path: unknown, listener: (...a: unknown[]) => void) => {
			fsWatchState.unwatch.push({ path: String(path), listener });
		},
	};
});

import {
	getBuiltinRules,
	getDefaultConfig,
	loadRules,
	readLocalGuardRules,
	readTeamGuardRules,
	watchRulesFiles,
	writeLocalGuardRules,
	writeTeamGuardRules,
} from "../rules-loader.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "rules-loader-mode-"));
	mkdirSync(join(tmp, ".interlinked"), { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function writeSharedConfig(mode: string | null): void {
	const path = join(tmp, ".interlinked", "config.json");
	const body = mode === null ? {} : { mode };
	writeFileSync(path, JSON.stringify(body));
}

function writeLocal(content: object): void {
	writeFileSync(
		join(tmp, ".interlinked", "guard-rules.local.json"),
		JSON.stringify(content),
	);
}

describe("loadRules — Phase C mode preset enablement", () => {
	it("budget mode disables structural_checks + heavy quality checks", () => {
		writeSharedConfig("budget");
		const config = loadRules(tmp);
		expect(config.structural_checks?.enabled).toBe(false);
		expect(config.quality_checks.semgrep?.enabled).toBe(false);
		expect(config.quality_checks.prompt_injection?.enabled).toBe(false);
		expect(config.quality_checks.affected_tests?.enabled).toBe(false);
	});

	it("quality mode enables structural_checks, semgrep, affected_tests", () => {
		writeSharedConfig("quality");
		const config = loadRules(tmp);
		expect(config.structural_checks?.enabled).toBe(true);
		expect(config.quality_checks.semgrep?.enabled).toBe(true);
		expect(config.quality_checks.affected_tests?.enabled).toBe(true);
		// quality leaves prompt_injection off (CI-only)
		expect(config.quality_checks.prompt_injection?.enabled).toBe(false);
	});

	it("ci mode enables prompt_injection + every other heavy check", () => {
		writeSharedConfig("ci");
		const config = loadRules(tmp);
		expect(config.structural_checks?.enabled).toBe(true);
		expect(config.quality_checks.semgrep?.enabled).toBe(true);
		expect(config.quality_checks.affected_tests?.enabled).toBe(true);
		expect(config.quality_checks.prompt_injection?.enabled).toBe(true);
	});

	it("local override beats the mode preset (user remains authoritative)", () => {
		// budget normally disables semgrep; the user explicitly turning it
		// back on in local config must win.
		writeSharedConfig("budget");
		writeLocal({ quality_checks: { semgrep: { enabled: true } } });
		const config = loadRules(tmp);
		expect(config.quality_checks.semgrep?.enabled).toBe(true);
		// other budget gates still apply
		expect(config.structural_checks?.enabled).toBe(false);
	});

	it("absent mode field falls through to defaults (no mode override applied)", () => {
		writeSharedConfig(null);
		const config = loadRules(tmp);
		// We don't assert specific defaults here — only that the loader
		// produced a workable config without crashing.
		expect(config.quality_checks).toBeDefined();
		expect(config.rules.length).toBeGreaterThan(0);
	});

	it("malformed config.json is treated as no-mode, not a crash", () => {
		writeFileSync(join(tmp, ".interlinked", "config.json"), "{not-json");
		expect(() => loadRules(tmp)).not.toThrow();
	});

	// `readActiveModePreset` narrows the parsed JSON with `isJsonObject`
	// before reading `.mode` instead of an `as { mode?: unknown }` cast. Both
	// of these are cases the OLD cast already converged to "no override" for
	// (a top-level array/primitive has no `.mode` property; `null` threw and
	// was caught by the same try/catch) — pinned here so the narrowing stays
	// behavior-preserving rather than merely "doesn't crash".
	it("N1: a top-level JSON array in config.json is treated as no-mode, not a crash", () => {
		writeFileSync(join(tmp, ".interlinked", "config.json"), "[1,2,3]");
		expect(() => loadRules(tmp)).not.toThrow();
		const config = loadRules(tmp);
		expect(config.rules.length).toBeGreaterThan(0);
	});

	it("N2: a top-level JSON null in config.json is treated as no-mode, not a crash", () => {
		writeFileSync(join(tmp, ".interlinked", "config.json"), "null");
		expect(() => loadRules(tmp)).not.toThrow();
		const config = loadRules(tmp);
		expect(config.rules.length).toBeGreaterThan(0);
	});

	it("unknown mode strings migrate to quality (safe default)", () => {
		writeSharedConfig("strict-banana");
		const config = loadRules(tmp);
		// strict-banana migrates → quality, so structural_checks should be on.
		expect(config.structural_checks?.enabled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// getBuiltinRules — shallow-clone contract
// ---------------------------------------------------------------------------

describe("getBuiltinRules", () => {
	it("returns a non-empty list of rules with stable shape", () => {
		const rules = getBuiltinRules();
		expect(Array.isArray(rules)).toBe(true);
		expect(rules.length).toBeGreaterThan(0);
		// Every rule carries the GuardRule core fields.
		for (const r of rules.slice(0, 5)) {
			expect(typeof r.id).toBe("string");
			expect(typeof r.action).toBe("string");
			expect(Array.isArray(r.tool_match)).toBe(true);
		}
	});

	it("returns a fresh array each call (callers cannot poison the shared table)", () => {
		const a = getBuiltinRules();
		const b = getBuiltinRules();
		expect(a).not.toBe(b); // distinct array identity
		const originalLength = b.length;
		// Mutating the returned array must not shrink subsequent reads.
		a.length = 0;
		expect(getBuiltinRules().length).toBe(originalLength);
	});
});

// ---------------------------------------------------------------------------
// getDefaultConfig — deep-clone contract
// ---------------------------------------------------------------------------

describe("getDefaultConfig", () => {
	it("returns a workable config with rules + quality_checks", () => {
		const cfg = getDefaultConfig();
		expect(cfg.quality_checks).toBeDefined();
		expect(Array.isArray(cfg.rules)).toBe(true);
	});

	it("returns an independent deep clone (mutation does not leak across calls)", () => {
		const a = getDefaultConfig();
		const b = getDefaultConfig();
		expect(a).not.toBe(b);
		expect(a.quality_checks).not.toBe(b.quality_checks);
		// Mutate a nested field on the first clone…
		const firstKey = Object.keys(a.quality_checks)[0];
		expect(firstKey).toBeTruthy();
		const probe = a.quality_checks[nonNull(firstKey)];
		if (probe) probe.enabled = !probe.enabled;
		a.rules.push({
			id: "probe-mutation",
			enabled: true,
			trigger: "PreToolUse",
			tool_match: ["*"],
			action: "warn",
			patterns: [],
			reason: "probe",
			severity: "low",
		});
		// …a fresh read must be untouched.
		const c = getDefaultConfig();
		expect(c.rules.some((r) => r.id === "probe-mutation")).toBe(false);
		const cProbe = c.quality_checks[nonNull(firstKey)];
		const bProbe = b.quality_checks[nonNull(firstKey)];
		expect(cProbe?.enabled).toBe(bProbe?.enabled);
	});
});

// ---------------------------------------------------------------------------
// loadRules — config.json absent + team-rules merge paths
// ---------------------------------------------------------------------------

describe("loadRules — file-presence branches", () => {
	let tmp2: string;

	beforeEach(() => {
		tmp2 = mkdtempSync(join(tmpdir(), "rules-loader-files-"));
		mkdirSync(join(tmp2, ".interlinked"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tmp2, { recursive: true, force: true });
	});

	it("no config.json at all → loader still produces a default config", () => {
		// .interlinked exists but config.json is absent: exercises the
		// `!existsSync(sharedConfigPath) return null` short-circuit in
		// readActiveModePreset (no mode override path).
		const cfg = loadRules(tmp2);
		expect(cfg.rules.length).toBeGreaterThan(0);
		expect(cfg.quality_checks).toBeDefined();
	});

	it("team guard-rules.json is merged (custom rule reaches the rule list)", () => {
		const teamRule: GuardRule = {
			id: "team-custom-vendor-rule",
			enabled: true,
			trigger: "PreToolUse",
			tool_match: ["Bash"],
			action: "block",
			patterns: [{ field: "command", regex: "vendor-forbidden-token" }],
			reason: "team policy",
			severity: "high",
		};
		writeFileSync(
			join(tmp2, ".interlinked", "guard-rules.json"),
			JSON.stringify({ rules: [teamRule] }),
		);
		const cfg = loadRules(tmp2);
		expect(cfg.rules.some((r) => r.id === "team-custom-vendor-rule")).toBe(true);
	});

	it("team config merges a safe field onto an EXISTING quality check", () => {
		// `typescript` is present in the default config; `timeout_ms` is a
		// QUALITY_CHECK_SAFE_FIELD, so the team merge must apply it. (Using a
		// distinctive sentinel value avoids ambiguity with auto-tune, which
		// only ever flips `enabled` based on detected languages.)
		writeFileSync(
			join(tmp2, ".interlinked", "guard-rules.json"),
			JSON.stringify({ quality_checks: { typescript: { timeout_ms: 12345 } } }),
		);
		const cfg = loadRules(tmp2);
		expect(cfg.quality_checks.typescript?.timeout_ms).toBe(12345);
	});

	it("team config CANNOT inject a command on an unknown quality check", () => {
		// Security contract: team config (committed) must not be able to add a
		// new check entry with an arbitrary command.
		writeFileSync(
			join(tmp2, ".interlinked", "guard-rules.json"),
			JSON.stringify({
				quality_checks: {
					vendor_evil_check_v6: { enabled: true, command: "curl evil.example" },
				},
			}),
		);
		const cfg = loadRules(tmp2);
		expect(cfg.quality_checks.vendor_evil_check_v6).toBeUndefined();
	});

	it("malformed team guard-rules.json is swallowed (best-effort defaults)", () => {
		writeFileSync(join(tmp2, ".interlinked", "guard-rules.json"), "{ broken json");
		expect(() => loadRules(tmp2)).not.toThrow();
		const cfg = loadRules(tmp2);
		expect(cfg.rules.length).toBeGreaterThan(0);
	});

	it("malformed local guard-rules.local.json is swallowed (overrides skipped)", () => {
		writeFileSync(join(tmp2, ".interlinked", "guard-rules.local.json"), "not-json{");
		expect(() => loadRules(tmp2)).not.toThrow();
	});

	it("disabled_rules from local config removes a builtin rule from the output", () => {
		const builtin = getBuiltinRules()[0];
		expect(builtin).toBeDefined();
		const targetId = (nonNull(builtin)).id;
		// Sanity: present by default.
		expect(loadRules(tmp2).rules.some((r) => r.id === targetId)).toBe(true);
		writeFileSync(
			join(tmp2, ".interlinked", "guard-rules.local.json"),
			JSON.stringify({ disabled_rules: [targetId] }),
		);
		const cfg = loadRules(tmp2);
		expect(cfg.rules.some((r) => r.id === targetId)).toBe(false);
	});

	it("custom team rule with enabled:false is filtered out of the final list", () => {
		const disabledRule: GuardRule = {
			id: "team-disabled-rule",
			enabled: false,
			trigger: "PreToolUse",
			tool_match: ["Bash"],
			action: "warn",
			patterns: [],
			reason: "off",
			severity: "low",
		};
		const enabledRule: GuardRule = {
			...disabledRule,
			id: "team-enabled-rule",
			enabled: true,
		};
		writeFileSync(
			join(tmp2, ".interlinked", "guard-rules.json"),
			JSON.stringify({ rules: [disabledRule, enabledRule] }),
		);
		const cfg = loadRules(tmp2);
		expect(cfg.rules.some((r) => r.id === "team-enabled-rule")).toBe(true);
		expect(cfg.rules.some((r) => r.id === "team-disabled-rule")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// loadRules — distilled-rules layer (env-var gate + filter callbacks)
// ---------------------------------------------------------------------------

describe("loadRules — distilled-rules layer", () => {
	let tmp3: string;
	// The vitest config sets INTERLINKED_SKIP_DISTILLED_RULES=1 globally so
	// per-developer /enforce output can't leak into fixtures. These tests
	// deliberately toggle it to exercise both the skip branch and the
	// load+filter branches in loadRules.
	const savedSkip = process.env.INTERLINKED_SKIP_DISTILLED_RULES;
	const savedSkipLegacy = process.env.INTERLINKED_SKIP_COMPILED_RULES;

	function distilledRule(over: Partial<GuardRule> & { id: string }): GuardRule {
		return {
			enabled: true,
			trigger: "PreToolUse",
			tool_match: ["Bash"],
			action: "warn",
			patterns: [],
			reason: "distilled",
			severity: "low",
			...over,
		};
	}

	function writeDistilled(rules: GuardRule[]): void {
		writeFileSync(
			join(tmp3, ".interlinked", "distilled-rules.json"),
			JSON.stringify({ version: 1, rules }),
		);
	}

	beforeEach(() => {
		tmp3 = mkdtempSync(join(tmpdir(), "rules-loader-distilled-"));
		mkdirSync(join(tmp3, ".interlinked"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tmp3, { recursive: true, force: true });
		// Restore the global env gate after every case.
		if (savedSkip === undefined) delete process.env.INTERLINKED_SKIP_DISTILLED_RULES;
		else process.env.INTERLINKED_SKIP_DISTILLED_RULES = savedSkip;
		if (savedSkipLegacy === undefined) delete process.env.INTERLINKED_SKIP_COMPILED_RULES;
		else process.env.INTERLINKED_SKIP_COMPILED_RULES = savedSkipLegacy;
	});

	it("INTERLINKED_SKIP_DISTILLED_RULES=1 skips the distilled layer entirely", () => {
		process.env.INTERLINKED_SKIP_DISTILLED_RULES = "1";
		delete process.env.INTERLINKED_SKIP_COMPILED_RULES;
		writeDistilled([distilledRule({ id: "distilled-should-be-skipped" })]);
		const cfg = loadRules(tmp3);
		expect(cfg.rules.some((r) => r.id === "distilled-should-be-skipped")).toBe(false);
	});

	it("legacy INTERLINKED_SKIP_COMPILED_RULES=1 alias also skips the layer", () => {
		delete process.env.INTERLINKED_SKIP_DISTILLED_RULES;
		process.env.INTERLINKED_SKIP_COMPILED_RULES = "1";
		writeDistilled([distilledRule({ id: "distilled-legacy-skip" })]);
		const cfg = loadRules(tmp3);
		expect(cfg.rules.some((r) => r.id === "distilled-legacy-skip")).toBe(false);
	});

	it("with the gate OFF, an enabled distilled rule reaches the rule list", () => {
		delete process.env.INTERLINKED_SKIP_DISTILLED_RULES;
		delete process.env.INTERLINKED_SKIP_COMPILED_RULES;
		writeDistilled([
			distilledRule({ id: "distilled-enabled-rule", reason: "vendor-policy-v6" }),
		]);
		const cfg = loadRules(tmp3);
		const found = cfg.rules.find((r) => r.id === "distilled-enabled-rule");
		expect(found).toBeDefined();
		expect(found?.reason).toBe("vendor-policy-v6");
	});

	it("a distilled rule with enabled:false is filtered out (filter callback)", () => {
		delete process.env.INTERLINKED_SKIP_DISTILLED_RULES;
		delete process.env.INTERLINKED_SKIP_COMPILED_RULES;
		writeDistilled([
			distilledRule({ id: "distilled-on" }),
			distilledRule({ id: "distilled-off", enabled: false }),
		]);
		const cfg = loadRules(tmp3);
		expect(cfg.rules.some((r) => r.id === "distilled-on")).toBe(true);
		expect(cfg.rules.some((r) => r.id === "distilled-off")).toBe(false);
	});

	it("a distilled rule whose id is in disabled_rules is filtered out", () => {
		delete process.env.INTERLINKED_SKIP_DISTILLED_RULES;
		delete process.env.INTERLINKED_SKIP_COMPILED_RULES;
		writeDistilled([distilledRule({ id: "distilled-disabled-by-local" })]);
		writeFileSync(
			join(tmp3, ".interlinked", "guard-rules.local.json"),
			JSON.stringify({ disabled_rules: ["distilled-disabled-by-local"] }),
		);
		const cfg = loadRules(tmp3);
		expect(cfg.rules.some((r) => r.id === "distilled-disabled-by-local")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// watchRulesFiles — watcher registration, reload-on-change, cleanup
// ---------------------------------------------------------------------------

describe("watchRulesFiles", () => {
	let tmp4: string;

	beforeEach(() => {
		tmp4 = mkdtempSync(join(tmpdir(), "rules-loader-watch-"));
		mkdirSync(join(tmp4, ".interlinked"), { recursive: true });
		fsWatchState.reset();
	});

	afterEach(() => {
		rmSync(tmp4, { recursive: true, force: true });
		fsWatchState.reset();
	});

	it("registers a watcher on every rules file and returns a cleanup fn", () => {
		const cleanup = watchRulesFiles(tmp4, () => {});
		expect(typeof cleanup).toBe("function");
		// team + local + 2 distilled paths + 2 findings paths = 6 watched files.
		expect(fsWatchState.watch.length).toBe(6);
		const watchedPaths = fsWatchState.watch.map((w) => w.path);
		expect(watchedPaths.some((p) => p.endsWith("guard-rules.json"))).toBe(true);
		expect(watchedPaths.some((p) => p.endsWith("guard-rules.local.json"))).toBe(true);
		expect(watchedPaths.some((p) => p.endsWith("distilled-rules.json"))).toBe(true);
		expect(watchedPaths.some((p) => p.endsWith("distilled-rules.overrides.json"))).toBe(true);
		expect(watchedPaths.some((p) => p.endsWith("findings-rules.json"))).toBe(true);
		expect(watchedPaths.some((p) => p.endsWith("findings-rules.overrides.json"))).toBe(true);

		cleanup();
		// Cleanup unwatches exactly the same six paths.
		expect(fsWatchState.unwatch.length).toBe(6);
		const unwatchedPaths = fsWatchState.unwatch.map((w) => w.path).sort();
		expect(unwatchedPaths).toEqual(watchedPaths.slice().sort());
	});

	it("invokes onReload with a freshly-loaded config when a watcher fires", () => {
		const seen: GuardRulesConfig[] = [];
		const cleanup = watchRulesFiles(tmp4, (cfg) => seen.push(cfg));
		const listener = fsWatchState.watch[0]?.listener;
		expect(listener).toBeDefined();
		// Simulate a file-change event (real watchFile polls on a 2s
		// interval — firing the captured listener keeps the test fast/stable).
		listener?.({}, {});
		expect(seen.length).toBe(1);
		expect(seen[0]?.rules.length).toBeGreaterThan(0);
		cleanup();
	});

	it("reload swallows errors thrown by onReload (best-effort hot-reload)", () => {
		const cleanup = watchRulesFiles(tmp4, () => {
			throw new Error("consumer blew up");
		});
		const listener = fsWatchState.watch[0]?.listener;
		expect(listener).toBeDefined();
		// The internal try/catch must absorb the throw — firing the listener
		// must not propagate.
		expect(() => listener?.({}, {})).not.toThrow();
		cleanup();
	});
});

// ---------------------------------------------------------------------------
// Re-exported file-io helpers — round-trip through the public surface
// ---------------------------------------------------------------------------

describe("re-exported file-io helpers", () => {
	let tmp5: string;

	beforeEach(() => {
		tmp5 = mkdtempSync(join(tmpdir(), "rules-loader-io-"));
		mkdirSync(join(tmp5, ".interlinked"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tmp5, { recursive: true, force: true });
	});

	it("writeTeamGuardRules → readTeamGuardRules round-trips", () => {
		writeTeamGuardRules({ disabled_rules: ["x-team"] }, tmp5);
		const back = readTeamGuardRules(tmp5);
		expect(back?.disabled_rules).toEqual(["x-team"]);
	});

	it("writeLocalGuardRules → readLocalGuardRules round-trips", () => {
		writeLocalGuardRules({ disabled_rules: ["x-local"] }, tmp5);
		const back = readLocalGuardRules(tmp5);
		expect(back?.disabled_rules).toEqual(["x-local"]);
	});
});
