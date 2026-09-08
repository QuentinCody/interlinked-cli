import { describe, expect, it } from "vitest";
import type { CoverageObligation } from "./coverage-obligation-ledger.js";
import {
	formatBisectNotResetWarning,
	formatDeferredCoverageWarning,
	formatStubsIntroducedWarning,
	formatTddRegressionWarning,
	formatUiNotInteractedWarning,
	formatUnresolvedRedWarning,
	formatUnverifiedCodeWarning,
	formatVerifyNotRunWarning,
} from "./verification-stop-checks.js";

function makeObligation(file: string): CoverageObligation {
	return {
		kind: "coverage",
		file,
		reason: "budget_exceeded",
		estimated_suite_ms: 1000,
		budget_ms: 500,
		session_id: "s1",
		timestamp: "2026-01-01T00:00:00Z",
	};
}

// -- formatUnverifiedCodeWarning (symbol 903115e46af92275) -----------------

describe("formatUnverifiedCodeWarning — positive (must fire)", () => {
	// test-contract: boundary — the documented `>=` floor comparison must
	// treat exact equality as satisfied (JSDoc: "fires when ... ratio is
	// under UNVERIFIED_VERIFY_RATIO_FLOOR").
	it("P1: ratio exactly at the floor (0.1) is satisfied — no warning", () => {
		// codeFilesEdited=50, verifyCommandCount=5 => ratio === 0.1 exactly.
		// `ratio >= FLOOR` must treat equality as satisfied.
		const result = formatUnverifiedCodeWarning({
			codeFilesEdited: 50,
			verifyCommandCount: 5,
			verificationObserved: new Set(),
		});
		expect(result).toBeNull();
	});

	// test-contract: public-api — the returned warning string is the
	// function's entire observable contract; its wording is user-facing
	// guidance and must not silently drop a segment.
	it("P2: message includes the tsc/test guidance sentence fragment", () => {
		const result = formatUnverifiedCodeWarning({
			codeFilesEdited: 10,
			verifyCommandCount: 0,
			verificationObserved: new Set(),
		});
		expect(result).not.toBeNull();
		expect(result).toContain(
			"project's typecheck or tests (e.g., `npx tsc --noEmit`, `bun run test`, or the project's",
		);
	});
});

// -- formatVerifyNotRunWarning (symbol 75bf6e38273bb7f0) --------------------

describe("formatVerifyNotRunWarning — positive (must fire)", () => {
	// test-contract: invariant — JSDoc: "Returns null when ... verify-suite
	// is already in verificationObserved (satisfied)"; this must short-circuit
	// even when an individual signal is also present.
	it("P1: verify-suite signal present short-circuits to null even with other signals", () => {
		const result = formatVerifyNotRunWarning({
			codeFilesEdited: 5,
			verificationObserved: new Set(["verify-suite", "typecheck"]),
		});
		expect(result).toBeNull();
	});

	// test-contract: public-api — the returned warning string's wording is
	// the entire user-facing contract of this function.
	it("P2: partial verification message contains each text segment", () => {
		const result = formatVerifyNotRunWarning({
			codeFilesEdited: 3,
			verificationObserved: new Set(["typecheck"]),
		});
		expect(result).not.toBeNull();
		expect(result).toContain(
			"and partial verification — individual checks ran but `interlinked verify` did not. ",
		);
		expect(result).toContain(
			"The verify suite is the canonical local mirror of CI (tsc + biome + lint + secrets + ",
		);
		expect(result).toContain("the lint/SAST findings verify aggregates.");
		expect(result).toContain(
			"confirm the full pipeline is clean — a green tsc doesn't catch docs drift, secrets, or ",
		);
	});
});

// -- formatUiNotInteractedWarning (symbol 464155d6fd0c9338) -----------------

describe("formatUiNotInteractedWarning — positive (must fire)", () => {
	// test-contract: public-api — the returned warning string is the
	// function's entire observable contract.
	it("P1: message contains each text segment when firing", () => {
		const result = formatUiNotInteractedWarning({
			uiFilesEdited: 2,
			verificationObserved: new Set(),
		});
		expect(result).not.toBeNull();
		expect(result).toContain(
			"(.tsx / .jsx / .html / .css / .vue / .svelte / .astro) and no browser interaction this session ",
		);
		expect(result).toContain(
			"— neither a dev server (wrangler dev / vite / npm run dev) nor a chrome-devtools / playwright MCP ",
		);
		expect(result).toContain("before claiming done.");
	});
});

// -- formatStubsIntroducedWarning (symbol 214f1bb339e3870c) -----------------

describe("formatStubsIntroducedWarning", () => {
	// test-contract: invariant — JSDoc: "Shows the first maxShown (default 5)
	// ... followed by an '...and N more' suffix when applicable."
	it("P1: default maxShown is 5 — 7 stubs truncate with '...and 2 more'", () => {
		const stubs = Array.from({ length: 7 }, (_, i) => ({
			file: `f${i}.ts`,
			kind: "todo",
			snippet: `s${i}`,
		}));
		const result = formatStubsIntroducedWarning({ stubs });
		expect(result).not.toBeNull();
		expect(result).toContain("...and 2 more");
		// exactly 5 bullet lines shown
		expect(result?.match(/^ {2}- /gm)?.length).toBe(5);
	});

	// test-contract: boundary — the truncation condition (`length > max`)
	// must be strict; equal length is not truncation.
	it("P2: length exactly equal to maxShown produces no '...and' suffix", () => {
		const stubs = Array.from({ length: 5 }, (_, i) => ({
			file: `f${i}.ts`,
			kind: "todo",
			snippet: `s${i}`,
		}));
		const result = formatStubsIntroducedWarning({ stubs, maxShown: 5 });
		expect(result).not.toBeNull();
		expect(result).not.toContain("...and");
	});

	// test-contract: public-api — the untruncated-case suffix, line join
	// separator, and closing sentence are all part of the returned string's
	// observable contract.
	it("P3: no truncation (small case) does not inject stray text and joins lines with newlines", () => {
		const stubs = [
			{ file: "alpha.ts", kind: "todo", snippet: "one" },
			{ file: "beta.ts", kind: "fixme", snippet: "two" },
		];
		const result = formatStubsIntroducedWarning({ stubs });
		expect(result).not.toBeNull();
		// each bullet is on its own line
		expect(result).toContain("  - alpha.ts [todo]: one\n  - beta.ts [fixme]: two");
		expect(result).toContain(
			"If these are deliberate scaffolding, document the follow-up in a TODO list or issue. ",
		);
		expect(result).toContain("If they're forgotten work, finish them before stopping.");
	});
});

// -- formatTddRegressionWarning (symbol ab46c513b5be6835) -------------------

describe("formatTddRegressionWarning", () => {
	// test-contract: invariant — the default maxShown (5) and the
	// "...and N more" truncation suffix are the function's documented
	// listing contract, mirroring formatStubsIntroducedWarning.
	it("P1: default maxShown is 5 — 7 regressions truncate with '...and 2 more'", () => {
		const regressions = Array.from({ length: 7 }, (_, i) => ({ sourceFile: `f${i}.ts` }));
		const result = formatTddRegressionWarning({ regressions });
		expect(result).not.toBeNull();
		expect(result).toContain("...and 2 more");
		expect(result?.match(/^ {2}- /gm)?.length).toBe(5);
	});

	// test-contract: boundary — the truncation condition (`length > max`)
	// must be strict; equal length is not truncation.
	it("P2: length exactly equal to maxShown produces no '...and' suffix", () => {
		const regressions = Array.from({ length: 5 }, (_, i) => ({ sourceFile: `f${i}.ts` }));
		const result = formatTddRegressionWarning({ regressions, maxShown: 5 });
		expect(result).not.toBeNull();
		expect(result).not.toContain("...and");
	});

	// test-contract: public-api — untruncated line join and closing
	// sentence are part of the returned string's observable contract.
	it("P3: no truncation does not inject stray text, joins with newlines, has closing sentence", () => {
		const regressions = [{ sourceFile: "one.ts" }, { sourceFile: "two.ts" }];
		const result = formatTddRegressionWarning({ regressions });
		expect(result).not.toBeNull();
		expect(result).toContain("  - one.ts\n  - two.ts");
		expect(result).toContain(
			"behavior. Re-run the test(s) and fix the regression before stopping.",
		);
	});
});

// -- formatUnresolvedRedWarning (symbol 00cfe06372ccd347) -------------------

describe("formatUnresolvedRedWarning", () => {
	// test-contract: invariant — JSDoc: "Lists up to maxShown (default 5)
	// entries combined, with an '...and N more' suffix"; the `.slice(0,max)`
	// truncation must actually cap the shown lines at 5.
	it("P1: default maxShown is 5 — 7 combined items truncate to exactly 5 shown lines", () => {
		const redChecks = Array.from({ length: 7 }, (_, i) => ({ kind: `check${i}` }));
		const result = formatUnresolvedRedWarning({ redChecks, redTests: [] });
		expect(result).not.toBeNull();
		expect(result).toContain("...and 2 more");
		expect(result?.match(/^ {2}- /gm)?.length).toBe(5);
	});

	// test-contract: boundary — the truncation condition (`length > max`)
	// must be strict; equal length is not truncation.
	it("P2: length exactly equal to maxShown produces no '...and' suffix", () => {
		const redChecks = Array.from({ length: 5 }, (_, i) => ({ kind: `check${i}` }));
		const result = formatUnresolvedRedWarning({ redChecks, redTests: [], maxShown: 5 });
		expect(result).not.toBeNull();
		expect(result).not.toContain("...and");
	});

	// test-contract: public-api — untruncated line join and full message
	// wording are part of the returned string's observable contract.
	it("P3: no truncation does not inject stray text, joins with newlines, has full message text", () => {
		const result = formatUnresolvedRedWarning({
			redChecks: [{ kind: "typecheck" }],
			redTests: [{ sourceFile: "thing.ts" }],
		});
		expect(result).not.toBeNull();
		expect(result).toContain("  - typecheck\n  - test: thing.ts");
		expect(result).toContain("this session and never went green again:\n");
		expect(result).toContain(
			"deliberately-pending check — that's fine; this is just a reminder to confirm the red ",
		);
	});
});

// -- formatDeferredCoverageWarning (symbol 87dbf643bfb99a6b) ----------------

describe("formatDeferredCoverageWarning", () => {
	// test-contract: boundary — the truncation condition (`length > max`)
	// must be strict; equal length is not truncation.
	it("P1: length exactly equal to maxShown produces no '...and' suffix", () => {
		const obligations = Array.from({ length: 5 }, (_, i) => makeObligation(`f${i}.ts`));
		const result = formatDeferredCoverageWarning({ obligations, maxShown: 5 });
		expect(result).not.toBeNull();
		expect(result).not.toContain("...and");
	});

	// test-contract: public-api — untruncated line join and full message
	// wording are part of the returned string's observable contract.
	it("P2: no truncation avoids stray text, joins with newlines, contains all message segments", () => {
		const obligations = [makeObligation("one.ts"), makeObligation("two.ts")];
		const result = formatDeferredCoverageWarning({ obligations });
		expect(result).not.toBeNull();
		expect(result).toContain("  - one.ts\n  - two.ts");
		expect(result).toContain(
			"deferred them (suite runtime over budget) and only the commit gate enforces them:\n",
		);
		expect(result).toContain(
			"measures. (Committing also discharges them, via the commit gate, but that is the ",
		);
		expect(result).toContain(
			"user's call to make, not something to do in order to clear this notice.) This is a ",
		);
		expect(result).toContain(
			"If you are waiting on the user, say so and stop; this notice will not repeat.",
		);
	});
});

// -- formatBisectNotResetWarning (symbol c27f19ec9a858b30, 632d1242a3a9dd8c) --

describe("formatBisectNotResetWarning", () => {
	// test-contract: invariant — JSDoc: "Returns null when there is no
	// bisect activity". The `lastOp === -1` initial-state sentinel must
	// stay -1 (not be flipped) when the loop never matches BISECT_OP_RE.
	it("P1: no bisect commands at all — satisfied (null)", () => {
		const result = formatBisectNotResetWarning({ commandsRun: ["npm test", "git status"] });
		expect(result).toBeNull();
	});

	// test-contract: invariant — an unfinished bisect (op seen, reset
	// never seen) must still warn; the `lastReset` sentinel default must
	// not spuriously read as "after" the op.
	it("P2: bisect start with no reset at all — warns", () => {
		const result = formatBisectNotResetWarning({ commandsRun: ["git bisect start"] });
		expect(result).not.toBeNull();
	});

	// test-contract: invariant — BISECT_RESET_RE.test(c) must only match a
	// genuine reset command, not every command; a non-reset command after
	// the op must not be misread as clearing the bisect state.
	it("P3: bisect start followed by an unrelated command (not a reset) still warns", () => {
		const result = formatBisectNotResetWarning({
			commandsRun: ["git bisect start", "echo hi"],
		});
		expect(result).not.toBeNull();
	});

	// test-contract: boundary — `lastReset > lastOp` must be strict: a
	// reset recorded at the SAME index as the op (same command string
	// matching both regexes) is a tie, not strictly after, and must still
	// warn per the documented "reset followed the last bisect step" gate.
	it("P4: reset in the same command as start (tie, not strictly after) still warns", () => {
		const result = formatBisectNotResetWarning({
			commandsRun: ["git bisect start; git bisect reset"],
		});
		expect(result).not.toBeNull();
	});

	// test-contract: invariant — JSDoc: "or a reset followed the last
	// bisect step" — the documented satisfied case.
	it("P5: reset strictly after start clears the warning (satisfied)", () => {
		const result = formatBisectNotResetWarning({
			commandsRun: ["git bisect start", "git bisect reset"],
		});
		expect(result).toBeNull();
	});

	// test-contract: public-api — the returned warning string is the
	// function's entire observable contract.
	it("P6: message contains each text segment when firing", () => {
		const result = formatBisectNotResetWarning({ commandsRun: ["git bisect start"] });
		expect(result).not.toBeNull();
		expect(result).toContain(
			"`git bisect start/good/bad/run` ran this session with no `git bisect reset` ",
		);
		expect(result).toContain(
			"after it. The working tree is likely still on an old commit in detached-HEAD ",
		);
		expect(result).toContain("bisect state. Run `git bisect reset` to restore HEAD before stopping.");
	});

	// Regex whitespace-quantifier variants (BISECT_OP_RE / BISECT_RESET_RE):
	// distinguish \s+ (one-or-more) from \s (exactly one) by using doubled
	// whitespace at each gap the regex spans.
	// test-contract: invariant — BISECT_OP_RE's first `\s+` gap (between
	// "git" and "bisect") must accept one-or-more whitespace, not exactly one.
	it("P7: double space between 'git' and 'bisect' in a bisect-op command still matches", () => {
		const result = formatBisectNotResetWarning({ commandsRun: ["git  bisect start"] });
		expect(result).not.toBeNull();
	});

	// test-contract: invariant — BISECT_OP_RE's second `\s+` gap (between
	// "bisect" and the verb) must accept one-or-more whitespace.
	it("P8: double space between 'bisect' and 'start' in a bisect-op command still matches", () => {
		const result = formatBisectNotResetWarning({ commandsRun: ["git bisect  start"] });
		expect(result).not.toBeNull();
	});

	// test-contract: invariant — BISECT_RESET_RE's first `\s+` gap must
	// accept one-or-more whitespace, so a reset with doubled spacing still
	// discharges the unfinished-bisect state.
	it("P9: double space between 'git' and 'bisect' in the reset command still discharges", () => {
		const result = formatBisectNotResetWarning({
			commandsRun: ["git bisect start", "git  bisect reset"],
		});
		expect(result).toBeNull();
	});

	// test-contract: invariant — BISECT_RESET_RE's second `\s+` gap must
	// accept one-or-more whitespace.
	it("P10: double space between 'bisect' and 'reset' in the reset command still discharges", () => {
		const result = formatBisectNotResetWarning({
			commandsRun: ["git bisect start", "git bisect  reset"],
		});
		expect(result).toBeNull();
	});
});

// -- symbol 632d1242a3a9dd8c: INDIVIDUAL_CORRECTNESS_SIGNALS array literal ---
// ("lint" / "build" entries) exercised via formatVerifyNotRunWarning's
// some()-over-signals check.

describe("INDIVIDUAL_CORRECTNESS_SIGNALS membership — positive (must fire)", () => {
	// test-contract: invariant — the array literal's "lint" entry must be
	// the exact string tested against verificationObserved.
	it("P1: 'lint' alone counts as an individual correctness signal", () => {
		const result = formatVerifyNotRunWarning({
			codeFilesEdited: 1,
			verificationObserved: new Set(["lint"]),
		});
		expect(result).not.toBeNull();
	});

	// test-contract: invariant — the array literal's "build" entry must be
	// the exact string tested against verificationObserved.
	it("P2: 'build' alone counts as an individual correctness signal", () => {
		const result = formatVerifyNotRunWarning({
			codeFilesEdited: 1,
			verificationObserved: new Set(["build"]),
		});
		expect(result).not.toBeNull();
	});
});
