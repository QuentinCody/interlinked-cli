import { expect, it } from "vitest";
import type { CoverageObligation } from "./coverage-obligation-ledger.js";
import {
	classifyVerificationCommand,
	formatBisectNotResetWarning,
	formatDeferredCoverageWarning,
	formatStubsIntroducedWarning,
	formatTddRegressionWarning,
	formatUiNotInteractedWarning,
	formatUnresolvedRedWarning,
	formatUnverifiedCodeWarning,
	formatVerifyNotRunWarning,
} from "./verification-stop-checks.js";

function obligation(file: string): CoverageObligation {
	return {
		kind: "coverage",
		file,
		reason: "budget_exceeded",
		estimated_suite_ms: 30_000,
		budget_ms: 25_000,
		session_id: "wave2",
		timestamp: "2026-08-20T00:00:00.000Z",
	};
}

// test-contract: public-api — lint and build are distinct correctness signals used by stop-time verification.
it("classifies lint and build commands", () => {
	expect(classifyVerificationCommand("npm run lint")).toBe("lint");
	expect(classifyVerificationCommand("pnpm run build")).toBe("build");
});

// test-contract: invariant — bisect command recognition tolerates shell whitespace between every token.
it("recognizes bisect operations with repeated whitespace", () => {
	expect(formatBisectNotResetWarning({ commandsRun: ["git  bisect   start HEAD HEAD~1"] })).not.toBeNull();
	expect(formatBisectNotResetWarning({ commandsRun: ["git  bisect   reset"] })).toBeNull();
});

// test-contract: boundary — a reset at the same command position as the operation is not a later reset.
it("does not warn when a reset follows the operation, but does warn for operation-only history", () => {
	expect(
		formatBisectNotResetWarning({ commandsRun: ["git bisect start", "git bisect reset"] }),
	).toBeNull();
	const warning = formatBisectNotResetWarning({ commandsRun: ["git bisect start"] });
	expect(warning).toBe(
		"[interlinked:verify-before-stop] Stopping with an unfinished git bisect — a " +
			"`git bisect start/good/bad/run` ran this session with no `git bisect reset` " +
			"after it. The working tree is likely still on an old commit in detached-HEAD " +
			"bisect state. Run `git bisect reset` to restore HEAD before stopping.",
	);
});

// test-contract: boundary — exactly maxShown obligations are all listed and do not produce a truncation suffix.
it("keeps deferred coverage output exact at its display limit", () => {
	const warning = formatDeferredCoverageWarning({
		obligations: [obligation("src/a.ts"), obligation("src/b.ts")],
		maxShown: 2,
	});
	expect(warning).not.toContain("...and");
	expect(warning).toContain("deferred them (suite runtime over budget) and only the commit gate enforces them:");
	expect(warning).toContain("measures. (Committing also discharges them, via the commit gate, but that is the user's call");
	expect(warning).toContain("If you are waiting on the user, say so and stop; this notice will not repeat.");
});

// test-contract: public-api — default display policy shows five stubs and preserves the trailing guidance clauses.
it("uses the default stub limit and complete guidance", () => {
	const stubs = Array.from({ length: 6 }, (_, i) => ({
		file: `/repo/file-${i}.ts`,
		kind: "TODO",
		snippet: `TODO ${i}`,
	}));
	const warning = formatStubsIntroducedWarning({ stubs });
	expect(warning).toContain("file-4.ts");
	expect(warning).not.toContain("file-5.ts");
	expect(warning).toContain("\n  ...and 1 more");
	expect(warning).toContain("If these are deliberate scaffolding, document the follow-up in a TODO list or issue.");
	expect(warning).toContain("If they're forgotten work, finish them before stopping.");
});

// test-contract: boundary — maxShown equal to the regression count must not be treated as overflow.
it("does not suffix TDD regressions at the exact limit", () => {
	const warning = formatTddRegressionWarning({
		regressions: [{ sourceFile: "/repo/a.ts" }, { sourceFile: "/repo/b.ts" }],
		maxShown: 2,
	});
	expect(warning).not.toContain("...and");
	expect(warning).toContain("behavior. Re-run the test(s) and fix the regression before stopping.");
});

// test-contract: boundary — maxShown omitted means five entries, while a sixth is counted but hidden.
it("uses the default TDD regression display limit", () => {
	const warning = formatTddRegressionWarning({
		regressions: Array.from({ length: 6 }, (_, i) => ({ sourceFile: `/repo/r${i}.ts` })),
	});
	expect(warning).toContain("r4.ts");
	expect(warning).not.toContain("r5.ts");
	expect(warning).toContain("...and 1 more");
});

// test-contract: invariant — unresolved red entries are ordered checks first, then tests, and capped by slice.
it("preserves unresolved-red ordering and hides entries past maxShown", () => {
	const warning = formatUnresolvedRedWarning({
		redChecks: [{ kind: "lint", detail: "biome check" }, { kind: "build" }],
		redTests: [{ sourceFile: "/repo/hidden.ts" }],
		maxShown: 2,
	});
	expect(warning).toContain("- lint (biome check)\n  - build");
	expect(warning).not.toContain("hidden.ts");
	expect(warning).toContain("...and 1 more");
	expect(warning).toContain("deliberately-pending check — that's fine; this is just a reminder to confirm the red");
});

// test-contract: boundary — the verify-to-edit floor is inclusive, so an exact 0.10 ratio is satisfied.
it("accepts the exact unverified-code ratio floor", () => {
	expect(
		formatUnverifiedCodeWarning({
			codeFilesEdited: 10,
			verifyCommandCount: 1,
			verificationObserved: new Set(),
		}),
	).toBeNull();
	const warning = formatUnverifiedCodeWarning({
		codeFilesEdited: 11,
		verifyCommandCount: 1,
		verificationObserved: new Set(),
	});
	expect(warning).toContain("project's typecheck or tests (e.g., `npx tsc --noEmit`, `bun run test`, or the project's");
});

// test-contract: public-api — verify-suite is categorical evidence and suppresses the partial-verification nudge.
it("suppresses verify-not-run when the canonical suite ran", () => {
	expect(
		formatVerifyNotRunWarning({
			codeFilesEdited: 3,
			verificationObserved: new Set(["verify-suite", "typecheck"]),
		}),
	).toBeNull();
});

// test-contract: public-api — partial verification remains distinct from no verification and names the suite gaps.
it("describes partial verification with all load-bearing guidance", () => {
	const warning = formatVerifyNotRunWarning({
		codeFilesEdited: 3,
		verificationObserved: new Set(["lint"]),
	});
	expect(warning).toContain("and partial verification — individual checks ran but `interlinked verify` did not.");
	expect(warning).toContain("The verify suite is the canonical local mirror of CI (tsc + biome + lint + secrets +");
	expect(warning).toContain("confirm the full pipeline is clean — a green tsc doesn't catch docs drift, secrets, or");
	expect(warning).toContain("the lint/SAST findings verify aggregates.");
});

// test-contract: public-api — UI verification requires either browser or dev-server evidence, and the warning names both paths.
it("retains the complete UI interaction guidance", () => {
	const warning = formatUiNotInteractedWarning({ uiFilesEdited: 1, verificationObserved: new Set() });
	expect(warning).toContain("(.tsx / .jsx / .html / .css / .vue / .svelte / .astro) and no browser interaction this session");
	expect(warning).toContain("— neither a dev server (wrangler dev / vite / npm run dev) nor a chrome-devtools / playwright MCP");
	expect(warning).toContain("before claiming done.");
});
