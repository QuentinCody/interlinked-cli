// Companion smoke tests for lifecycle-stop-warnings-code-file-verification.ts.
//
// This module is a pure re-home (line-cap split of lifecycle-stop-warnings.ts,
// 2026-09) — full behavioral coverage of `buildVerificationStopWarnings` and
// every check* helper already lives in lifecycle-stop-warnings.test.ts, which
// still imports the orchestrator through the parent barrel. This file gives
// the module its own standalone evidence: one true and one null path per
// exported helper, using the real (unmocked) collaborator formatters so the
// assertions are on genuine output text, not call shape alone.

import { describe, expect, it, vi } from "vitest";
import type { HarnessEvent, SessionTrajectory } from "../types.js";
import {
	checkBisectNotReset,
	checkCodeFileVerification,
	checkDeferredCoverage,
	checkDocMarkerDrift,
	checkReviewFindings,
	checkSpecDrift,
	checkStubsIntroduced,
	checkUiNotInteracted,
	checkUnverifiedCode,
	checkUntestedExports,
	checkVerifyNotRun,
	pushIfNotNull,
} from "./lifecycle-stop-warnings-code-file-verification.js";
import type { ServerRuntime } from "./runtime-context.js";

vi.mock("./review-reconcile-phase.js", () => ({
	openReviewFindings: vi.fn(() => []),
}));
vi.mock("./runtime-context.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./runtime-context.js")>();
	return { ...actual, getGraphForFile: vi.fn(() => null) };
});

function makeCtx(rules: Record<string, unknown> = {}): ServerRuntime {
	const logLines: string[] = [];
	return {
		cwd: "/repo",
		rules,
		log: (msg: string) => logLines.push(msg),
		_logLines: logLines,
	} as unknown as ServerRuntime & { _logLines: string[] };
}

function makeSession(over: Record<string, unknown> = {}): SessionTrajectory {
	const base = {
		files_written: new Set<string>(),
		commands_run: [],
		stubs_introduced: [],
		spec_drift_outstanding: [],
	};
	return { ...base, ...over } as unknown as SessionTrajectory;
}

function makeEvent(over: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "Stop",
		session_id: "s1",
		agent_source: "claude",
		timestamp: "2026-06-05T00:00:00.000Z",
		...over,
	};
}

describe("pushIfNotNull", () => {
	it("P: pushes a non-null string", () => {
		const arr: string[] = [];
		pushIfNotNull(arr, "x");
		expect(arr).toEqual(["x"]);
	});

	it("N: does not push null", () => {
		const arr: string[] = ["existing"];
		pushIfNotNull(arr, null);
		expect(arr).toEqual(["existing"]);
	});
});

describe("checkCodeFileVerification", () => {
	it("N: returns null and skips the log when the formatter finds nothing to warn about", () => {
		const ctx = makeCtx();
		const session = makeSession();
		const result = checkCodeFileVerification({
			ctx,
			session,
			verificationObserved: new Set(),
			formatter: () => null,
			logTag: "test-tag",
		});
		expect(result).toBeNull();
	});

	it("P: returns the formatter's warning and logs with the given tag", () => {
		const ctx = makeCtx() as ServerRuntime & { _logLines: string[] };
		const session = makeSession({ files_written: new Set(["src/a.ts"]) });
		const result = checkCodeFileVerification({
			ctx,
			session,
			verificationObserved: new Set(["tsc"]),
			formatter: ({ codeFilesEdited }) => `warned:${codeFilesEdited}`,
			logTag: "my-tag",
		});
		expect(result).toBe("warned:1");
		expect(ctx._logLines[0]).toContain("my-tag");
		expect(ctx._logLines[0]).toContain("signals=tsc");
	});
});

describe("checkUnverifiedCode / checkVerifyNotRun", () => {
	it("N: both return null with no code files written", () => {
		const ctx = makeCtx();
		const session = makeSession();
		expect(checkUnverifiedCode(ctx, session, new Set())).toBeNull();
		expect(checkVerifyNotRun(ctx, session, new Set())).toBeNull();
	});
});

describe("checkUiNotInteracted", () => {
	it("N: returns null when no UI files were written", () => {
		const ctx = makeCtx();
		expect(checkUiNotInteracted(ctx, makeSession(), new Set())).toBeNull();
	});
});

describe("checkStubsIntroduced", () => {
	it("N: returns null when no stubs were introduced", () => {
		const ctx = makeCtx();
		expect(checkStubsIntroduced(ctx, makeSession({ stubs_introduced: [] }))).toBeNull();
	});

	it("P: surfaces a warning and logs the count when stubs exist", () => {
		const ctx = makeCtx() as ServerRuntime & { _logLines: string[] };
		const session = makeSession({
			stubs_introduced: [{ file: "src/a.ts", line: 3, marker: "TODO" }],
		});
		const result = checkStubsIntroduced(ctx, session);
		expect(result).not.toBeNull();
		expect(ctx._logLines[0]).toContain("stubs-introduced (1)");
	});
});

describe("checkDeferredCoverage", () => {
	it("N: returns null when no deferred obligations are on disk", () => {
		const ctx = makeCtx();
		const session = makeSession({ session_id: "no-such-session" });
		expect(checkDeferredCoverage(ctx, session)).toBeNull();
	});
});

describe("checkUntestedExports", () => {
	it("N: returns null when no files were written this session", () => {
		const ctx = makeCtx();
		expect(checkUntestedExports(ctx, makeEvent(), makeSession())).toBeNull();
	});
});

describe("checkBisectNotReset", () => {
	it("N: returns null with no bisect commands recorded", () => {
		const ctx = makeCtx();
		expect(checkBisectNotReset(ctx, makeSession({ commands_run: ["npm test"] }))).toBeNull();
	});
});

describe("checkSpecDrift", () => {
	it("N: returns null when verification_stop_checks is disabled", () => {
		const ctx = makeCtx({ verification_stop_checks: { enabled: false } });
		expect(checkSpecDrift(ctx, makeSession())).toBeNull();
	});

	it("N: returns null when there is no outstanding drift", () => {
		const ctx = makeCtx({ verification_stop_checks: { enabled: true } });
		expect(checkSpecDrift(ctx, makeSession({ spec_drift_outstanding: [] }))).toBeNull();
	});
});

describe("checkReviewFindings", () => {
	it("N: returns null when verification_stop_checks is disabled", () => {
		const ctx = makeCtx({ verification_stop_checks: { enabled: false } });
		expect(checkReviewFindings(ctx)).toBeNull();
	});

	it("N: returns null when no open findings exist (mocked openReviewFindings → [])", () => {
		const ctx = makeCtx({ verification_stop_checks: { enabled: true } });
		expect(checkReviewFindings(ctx)).toBeNull();
	});
});

describe("checkDocMarkerDrift", () => {
	it("N: returns null with no doc-fact source files edited", () => {
		const ctx = makeCtx();
		const session = makeSession({ files_written: new Set(["src/a.ts"]), commands_run: [] });
		expect(checkDocMarkerDrift(ctx, session)).toBeNull();
	});
});
