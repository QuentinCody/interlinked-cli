import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetRepoProfileCache } from "../repo-profile.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import {
	type RunnerUnavailableSite,
	loudRunnerUnavailable,
	profileRunnerFastPath,
	resetDegradeMemo,
} from "./coverage-write-guard-degrade.js";

const TAIL = " (further edits will not repeat this notice this session)";

function mkEvent(filePath: string): HarnessEvent {
	return ({
		hook_event: "PreToolUse",
		session_id: "s1",
		agent_source: "claude",
		timestamp: "2026-01-01T00:00:00.000Z",
		tool_input: { file_path: filePath },
		// SAFETY: profileRunnerFastPath only reads tool_input off this event;
		// the rest of HarnessEvent's fields are irrelevant to the code under test.
	} satisfies HarnessEvent);
}

function cfg(languages: string[]): NonNullable<GuardRulesConfig["per_edit_coverage"]> {
	return { enabled: true, mode: "block", budget_ms: 25000, languages };
}

let dirs: string[] = [];

function freshRoot(): string {
	const d = mkdtempSync(join(tmpdir(), "cwgd-"));
	dirs.push(d);
	return d;
}

beforeEach(() => {
	resetDegradeMemo();
	resetRepoProfileCache();
	dirs = [];
});

afterEach(() => {
	for (const d of dirs) {
		rmSync(d, { recursive: true, force: true });
	}
});

describe("loudRunnerUnavailable — runner-absence classification (kills 8a4a83c, 067cdc0, 6299c8c, d3f7e68, 4ac10a6, ed3998, e53b0e0)", () => {
	// test-contract: public-api — loudRunnerUnavailable's RUNNER_ABSENCE_REASONS
	// classification decides the tail-path vs immediate-path branch.
	it("P1: a why exactly matching '^no coverage runner for ' takes the once-per-daemon tail path, not the immediate path", () => {
		const site: RunnerUnavailableSite = { projectRoot: freshRoot(), relPath: "a.ts", language: "ts" };
		const result = loudRunnerUnavailable(site, "no coverage runner for ts");
		expect(result.warnings?.[0]).toContain(TAIL);
	});

	// test-contract: invariant — the `^` anchor in RUNNER_ABSENCE_REASONS[0]
	// must be honored; a match only when the pattern occurs elsewhere in why
	// is NOT runner-absence.
	it("P2: a why matching the pattern only WITHOUT the anchor (leading text before it) does NOT count as runner-absence — immediate warning, no tail, and repeats every call", () => {
		const site: RunnerUnavailableSite = { projectRoot: freshRoot(), relPath: "a.ts", language: "ts" };
		const first = loudRunnerUnavailable(site, "xxx no coverage runner for ts");
		const second = loudRunnerUnavailable(site, "xxx no coverage runner for ts");
		expect(first.warnings?.[0]).not.toContain(TAIL);
		// Not memoized: unanchored/non-absence reasons warn on EVERY call.
		expect(second.warnings?.[0]).toBeDefined();
		expect(second.warnings?.[0]).not.toContain(TAIL);
	});

	// test-contract: invariant — a transient why (spawn failure etc.) must
	// stay per-edit loud and never be memoized like a runner-absence reason.
	it("N1: a why that never matches either absence pattern warns every call, never silences, never tags tail", () => {
		const site: RunnerUnavailableSite = { projectRoot: freshRoot(), relPath: "a.ts", language: "ts" };
		const first = loudRunnerUnavailable(site, "spawn ENOENT");
		const second = loudRunnerUnavailable(site, "spawn ENOENT");
		expect(first.warnings?.[0]).not.toContain(TAIL);
		expect(second.decision).toBe("allow");
		expect(second.warnings?.[0]).toBeDefined();
		expect(second.warnings?.[0]).not.toContain(TAIL);
	});
});

describe("loudRunnerUnavailable — once-per-daemon memo (kills a5347138, a6a8e01c, 97c652b)", () => {
	// test-contract: invariant — firstOccurrence's once-per-daemon memo makes
	// the second identical runner-absence call bare-silent (docblock above
	// loudRunnerUnavailable).
	it("P3: second call with the SAME absence why + site is silent (bare allow, no warnings)", () => {
		const site: RunnerUnavailableSite = { projectRoot: freshRoot(), relPath: "a.ts", language: "ts" };
		const first = loudRunnerUnavailable(site, "no coverage runner for ts");
		const second = loudRunnerUnavailable(site, "no coverage runner for ts");
		expect(first.warnings?.[0]).toContain(TAIL);
		expect(second).toEqual({ decision: "allow" });
	});

	// test-contract: invariant — profileRunnerFastPath and loudRunnerUnavailable
	// share the same (projectRoot, language, "runner-absent") memo key
	// (docblock: "same memo + reason-class as loudRunnerUnavailable").
	it("P4: the reason-class key used by the runner-absence memo interoperates with profileRunnerFastPath's own memo (same 'runner-absent' class)", () => {
		const root = freshRoot();
		// No js/python runner markers in this empty dir.
		const event = mkEvent("b.ts");
		const first = profileRunnerFastPath(event, cfg(["ts"]), root);
		expect(first?.warnings?.[0]).toContain(TAIL);

		const site: RunnerUnavailableSite = { projectRoot: root, relPath: "b.ts", language: "ts" };
		const second = loudRunnerUnavailable(site, "no coverage runner for ts");
		// Same (root, language, "runner-absent") key already marked by the
		// fast-path call above, so this must be silent.
		expect(second).toEqual({ decision: "allow" });
	});

	// test-contract: invariant — same memo key shared in the reverse call
	// order, proving the reason-class literal is the same string on both sides.
	it("P5: symmetric interoperation the other way (loudRunnerUnavailable marks first, fast-path sees it)", () => {
		const root = freshRoot();
		const site: RunnerUnavailableSite = { projectRoot: root, relPath: "c.js", language: "js" };
		const first = loudRunnerUnavailable(site, "no coverage runner for js");
		expect(first.warnings?.[0]).toContain(TAIL);

		const event = mkEvent("c.js");
		const second = profileRunnerFastPath(event, cfg(["js"]), root);
		// Already marked by loudRunnerUnavailable above -> silent path (null).
		expect(second).toBeNull();
	});
});

describe("runnerUnavailableWarning provider text by language (kills 4e8af87, 45647d4, 34f84fc)", () => {
	it("does not diagnose a missing runner when the event has no tool input", () => {
		const event = mkEvent("a.ts");
		delete event.tool_input;
		expect(profileRunnerFastPath(event, cfg(["ts"]), freshRoot())).toBeUndefined();
	});

	// test-contract: public-api — runnerUnavailableWarning's language-based
	// provider selection, exercised via loudRunnerUnavailable's warning text.
	it("P6: python language names pytest-cov as the provider", () => {
		const site: RunnerUnavailableSite = { projectRoot: freshRoot(), relPath: "a.py", language: "python" };
		const result = loudRunnerUnavailable(site, "spawn failed");
		expect(result.warnings?.[0]).toContain("pytest-cov");
	});

	// test-contract: public-api — the non-python arm of the same provider ternary.
	it("N2: non-python language names @vitest/coverage-v8 as the provider, not pytest-cov", () => {
		const site: RunnerUnavailableSite = { projectRoot: freshRoot(), relPath: "a.ts", language: "ts" };
		const result = loudRunnerUnavailable(site, "spawn failed");
		expect(result.warnings?.[0]).toContain("install the coverage provider (@vitest/coverage-v8");
	});
});

describe("profileRunnerKey mapping via profileRunnerFastPath (kills 15e4f0c, 565ad40, 4cf0056, 4f59d85)", () => {
	// test-contract: public-api — profileRunnerKey's language->runner-flag
	// mapping, exercised through profileRunnerFastPath's public undefined/allow
	// return-value contract.
	it("P7: a ts file with a detected JS runner but no python runner skips the fast path (undefined)", () => {
		const root = freshRoot();
		writeFileSync(join(root, "vitest.config.js"), "export default {}\n");
		const event = mkEvent("x.ts");
		const result = profileRunnerFastPath(event, cfg(["ts", "python"]), root);
		expect(result).toBeUndefined();
	});

	// test-contract: public-api — the python arm of profileRunnerKey, the
	// complementary case to P7.
	it("P8: a python file with a detected JS runner but no python runner DOES take the fast path", () => {
		const root = freshRoot();
		writeFileSync(join(root, "vitest.config.js"), "export default {}\n");
		const event = mkEvent("x.py");
		const result = profileRunnerFastPath(event, cfg(["ts", "python"]), root);
		expect(result).not.toBeUndefined();
		expect(result?.warnings?.[0]).toContain("pytest");
	});
});

describe("profileRunnerFastPath gating condition (kills 044d335, dfb798e)", () => {
	// test-contract: public-api — the `!language || !cfg.languages.includes(language)`
	// early-return gate in profileRunnerFastPath's docblock.
	it("P9: a language NOT in cfg.languages is skipped even with no runner detected in the repo", () => {
		const root = freshRoot();
		const event = mkEvent("x.py");
		// python not in the gated language list -> must be undefined regardless
		// of what the (empty) repo profile says.
		const result = profileRunnerFastPath(event, cfg(["ts"]), root);
		expect(result).toBeUndefined();
	});
});

describe("profileRunnerFastPath runner-name text + memo re-entry (kills 83e954e, 727eb01, df9bb1c, 760ac5a, e716b08, ea54b57, fcc11b3)", () => {
	// test-contract: public-api — profileRunnerFastPath's python-branch
	// runner-name text in its returned warning.
	it("P10: python file names 'pytest (+pytest-cov)' as the missing runner", () => {
		const root = freshRoot();
		const event = mkEvent("x.py");
		const result = profileRunnerFastPath(event, cfg(["python"]), root);
		expect(result?.warnings?.[0]).toContain("pytest (+pytest-cov)");
	});

	// test-contract: public-api — the ts-branch runner-name text, the
	// complementary case to P10.
	it("N3: ts file names 'vitest or jest' as the missing runner, not the python phrasing", () => {
		const root = freshRoot();
		const event = mkEvent("x.ts");
		const result = profileRunnerFastPath(event, cfg(["ts"]), root);
		expect(result?.warnings?.[0]).toContain("vitest or jest");
		expect(result?.warnings?.[0]).not.toContain("pytest (+pytest-cov)");
	});

	// test-contract: public-api — profileRunnerFastPath's final warning-string
	// template (rawPath, "NOT coverage-checked", NO_REPEAT_TAIL).
	it("P11: warning names the file path, says NOT coverage-checked, and carries the no-repeat tail", () => {
		const root = freshRoot();
		const event = mkEvent("x.ts");
		const result = profileRunnerFastPath(event, cfg(["ts"]), root);
		expect(result?.warnings?.[0]).toContain("x.ts");
		expect(result?.warnings?.[0]).toContain("NOT coverage-checked");
		expect(result?.warnings?.[0]).toContain(TAIL);
	});

	// test-contract: invariant — the second-call `null` (silent) return value
	// documented in profileRunnerFastPath's returns section.
	it("P12: a second fast-path call for the same (root, language) is silent (null), not a repeated warning", () => {
		const root = freshRoot();
		const event = mkEvent("x.ts");
		const first = profileRunnerFastPath(event, cfg(["ts"]), root);
		const second = profileRunnerFastPath(event, cfg(["ts"]), root);
		expect(first).not.toBeNull();
		expect(second).toBeNull();
	});
});
