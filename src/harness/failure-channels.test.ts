import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
// Behavioral unit tests for the failure-recovery channel orchestrator.
// Every imported `./` dependency is mocked at the module boundary so the
// orchestration logic (branch selection, warning assembly, fail-open
// catches, signature/path derivation) is exercised deterministically with
// zero real fs / git / network / time dependence.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
	HarnessEvent,
	RollbackAssessment,
	TriageResult,
} from "./types.js";

// --- Module-boundary mocks (must precede the SUT import) ----------------

vi.mock("./checks/failure-triage.js", () => ({
	classifyFailure: vi.fn(),
}));
vi.mock("./checks/failure-explanation.js", () => ({
	explainFailure: vi.fn(),
}));
vi.mock("./checks/recovery-suggestion.js", () => ({
	suggestRecovery: vi.fn(),
}));
vi.mock("./checks/rollback-feasibility.js", () => ({
	assessRollbackFeasibility: vi.fn(),
	formatRollbackLine: vi.fn(),
}));
vi.mock("./failure-record.js", () => ({
	mintFailureId: vi.fn(() => "fail_fixed-id"),
	failureRecordRelPath: vi.fn((id: string) => `.interlinked/failures/${id}.json`),
	writeFailureRecord: vi.fn(),
}));
vi.mock("./recurrence.js", () => ({
	recordToolFailure: vi.fn(),
}));
vi.mock("./session-state.js", () => ({
	isFileTrackedAsWritten: vi.fn(() => true),
}));

import { nonNull } from "../lib/non-null.js";
import { explainFailure } from "./checks/failure-explanation.js";
import { classifyFailure } from "./checks/failure-triage.js";
import { suggestRecovery } from "./checks/recovery-suggestion.js";
import {
	assessRollbackFeasibility,
	formatRollbackLine,
} from "./checks/rollback-feasibility.js";
import { runFailureChannels } from "./failure-channels.js";
import {
	failureRecordRelPath,
	mintFailureId,
	writeFailureRecord,
} from "./failure-record.js";
import { recordToolFailure } from "./recurrence.js";
import { isFileTrackedAsWritten } from "./session-state.js";

const classifyFailureMock = vi.mocked(classifyFailure);
const explainFailureMock = vi.mocked(explainFailure);
const suggestRecoveryMock = vi.mocked(suggestRecovery);
const assessRollbackMock = vi.mocked(assessRollbackFeasibility);
const formatRollbackLineMock = vi.mocked(formatRollbackLine);
const mintFailureIdMock = vi.mocked(mintFailureId);
const failureRecordRelPathMock = vi.mocked(failureRecordRelPath);
const writeFailureRecordMock = vi.mocked(writeFailureRecord);
const recordToolFailureMock = vi.mocked(recordToolFailure);
const isFileTrackedAsWrittenMock = vi.mocked(isFileTrackedAsWritten);

// --- Fixtures -----------------------------------------------------------

const GOOD_TRIAGE: TriageResult = {
	label: "agent-error",
	category: "type-mismatch",
	confidence: 0.8,
	source: "local-heuristic",
};

function makeEvent(
	over: Partial<HarnessEvent> = {},
	omit: readonly ("tool_outcome" | "tool_name" | "tool_input" | "error_message" | "stderr")[] = [],
): HarnessEvent {
	const base: HarnessEvent = {
		hook_event: "PostToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: "Edit",
		tool_outcome: "error",
		tool_input: { file_path: "src/foo.ts" },
		tool_use_id: "tu-1",
		error_message: "boom happened",
		exit_code: 2,
		stderr: "stderr text",
		stdout: "stdout text",
		timestamp: "2026-06-05T00:00:00Z",
	};
	const merged: HarnessEvent = { ...base, ...over };
	for (const key of omit) delete merged[key];
	return merged;
}

const SESSION = ({ ...completeSessionFixture(), ...{ session_id: "sess-1" } });

const SAFE_ROLLBACK: RollbackAssessment = {
	safe: true,
	command: ["git", "checkout", "--", "src/foo.ts"],
	reason: "uncommitted change to a file we wrote",
	caused_by_us: true,
};

function defaultHappyMocks(): void {
	classifyFailureMock.mockReturnValue(GOOD_TRIAGE);
	suggestRecoveryMock.mockReturnValue("try X");
	explainFailureMock.mockReturnValue("because Y");
	assessRollbackMock.mockReturnValue(SAFE_ROLLBACK);
	formatRollbackLineMock.mockReturnValue(
		"[interlinked:rollback] revert\nTo revert: `git checkout`",
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mintFailureIdMock.mockReturnValue("fail_fixed-id");
	failureRecordRelPathMock.mockImplementation(
		(id: string) => `.interlinked/failures/${id}.json`,
	);
	isFileTrackedAsWrittenMock.mockReturnValue(true);
	defaultHappyMocks();
});

// --- Early returns ------------------------------------------------------

describe("runFailureChannels early returns", () => {
	it("returns null when tool_outcome is not 'error'", () => {
		const out = runFailureChannels({
			event: makeEvent({ tool_outcome: "success" }),
			cwd: "/repo",
		});
		expect(out).toBeNull();
		expect(classifyFailureMock).not.toHaveBeenCalled();
	});

	it("returns null when tool_outcome is undefined", () => {
		const out = runFailureChannels({
			event: makeEvent({}, ["tool_outcome"]),
			cwd: "/repo",
		});
		expect(out).toBeNull();
	});

	it("returns null when tool_name is missing", () => {
		const out = runFailureChannels({
			event: makeEvent({ tool_name: undefined }),
			cwd: "/repo",
		});
		expect(out).toBeNull();
		expect(recordToolFailureMock).not.toHaveBeenCalled();
	});

	it("returns null when tool_name is the empty string (falsy)", () => {
		const out = runFailureChannels({
			event: makeEvent({ tool_name: "" }),
			cwd: "/repo",
		});
		expect(out).toBeNull();
	});
});

// --- Happy path: all channels fire -------------------------------------

describe("runFailureChannels full pipeline", () => {
	it("assembles every channel warning in order and returns the output", () => {
		const out = runFailureChannels({
			event: makeEvent(),
			session: SESSION,
			cwd: "/repo",
		});

		expect(out).not.toBeNull();
		expect(out!.failure_id).toBe("fail_fixed-id");
		expect(out!.triage).toEqual(GOOD_TRIAGE);
		// signature: tool:category:message-prefix
		expect(out!.signature).toBe("tool_failure:Edit:type-mismatch:boom happened");
		expect(out!.record_path).toBe(
			"/repo/.interlinked/failures/fail_fixed-id.json",
		);

		expect(out!.warnings).toEqual([
			"[interlinked:triage] agent-error / type-mismatch (80% local-heuristic)",
			"[interlinked:recovery] try X",
			"[interlinked:explain] because Y",
			"[interlinked:rollback] revert\nTo revert: `git checkout`",
			"[interlinked:failure] full record: .interlinked/failures/fail_fixed-id.json",
		]);
	});

	it("records recurrence with the triage-derived signature and extracted file", () => {
		runFailureChannels({ event: makeEvent(), session: SESSION, cwd: "/repo" });

		expect(recordToolFailureMock).toHaveBeenCalledTimes(1);
		expect(recordToolFailureMock).toHaveBeenCalledWith({
			tool_name: "Edit",
			signature: "tool_failure:Edit:type-mismatch:boom happened",
			agent_source: "claude",
			session_id: "sess-1",
			file: "src/foo.ts",
			message: "boom happened",
			cwd: "/repo",
		});
	});

	it("writes a disk record carrying triage/recovery/explanation/rollback", () => {
		runFailureChannels({ event: makeEvent(), session: SESSION, cwd: "/repo" });

		expect(writeFailureRecordMock).toHaveBeenCalledTimes(1);
		const [record, cwdArg] = nonNull(writeFailureRecordMock.mock.calls[0]);
		expect(cwdArg).toBe("/repo");
		expect(record).toMatchObject({
			failure_id: "fail_fixed-id",
			tool_name: "Edit",
			signature: "tool_failure:Edit:type-mismatch:boom happened",
			recovery: "try X",
			explanation: "because Y",
			rollback: SAFE_ROLLBACK,
			triage: GOOD_TRIAGE,
			error_message: "boom happened",
			exit_code: 2,
			stderr: "stderr text",
			stdout: "stdout text",
		});
	});

	it("passes the bound provenance check through to assessRollbackFeasibility", () => {
		runFailureChannels({ event: makeEvent(), session: SESSION, cwd: "/repo" });
		expect(assessRollbackMock).toHaveBeenCalledTimes(1);
		const [filePath, cwdArg, provenance] = nonNull(assessRollbackMock.mock.calls[0]);
		expect(filePath).toBe("src/foo.ts");
		expect(cwdArg).toBe("/repo");
		// Invoking the closure should delegate to the mocked session helper.
		expect(provenance("src/foo.ts")).toBe(true);
		expect(isFileTrackedAsWrittenMock).toHaveBeenCalledWith(
			SESSION,
			"src/foo.ts",
			"/repo",
		);
	});
});

// --- safeRun fail-open catch paths -------------------------------------

describe("runFailureChannels fail-open catches (safeRun)", () => {
	it("falls back to a classifier-crashed triage when classifyFailure throws", () => {
		classifyFailureMock.mockImplementation(() => {
			throw new Error("classifier exploded");
		});

		const out = runFailureChannels({
			event: makeEvent(),
			session: SESSION,
			cwd: "/repo",
		});

		expect(out!.triage).toEqual({
			label: "unknown",
			category: "classifier-crashed",
			confidence: 0,
			source: "local-heuristic",
		});
		// confidence 0 → 0%, signature uses the fallback category.
		expect(out!.signature).toBe(
			"tool_failure:Edit:classifier-crashed:boom happened",
		);
		expect(out!.warnings[0]).toBe(
			"[interlinked:triage] unknown / classifier-crashed (0% local-heuristic)",
		);
	});

	it("omits the recovery warning when suggestRecovery returns null", () => {
		suggestRecoveryMock.mockReturnValue(null);
		const out = runFailureChannels({
			event: makeEvent(),
			session: SESSION,
			cwd: "/repo",
		});
		expect(out!.warnings.some((w) => w.startsWith("[interlinked:recovery]"))).toBe(
			false,
		);
	});

	it("omits the recovery warning when suggestRecovery throws (safeRun→null)", () => {
		suggestRecoveryMock.mockImplementation(() => {
			throw new Error("recovery exploded");
		});
		const out = runFailureChannels({
			event: makeEvent(),
			session: SESSION,
			cwd: "/repo",
		});
		expect(out!.warnings.some((w) => w.startsWith("[interlinked:recovery]"))).toBe(
			false,
		);
	});

	it("omits the explain warning when explainFailure returns null", () => {
		explainFailureMock.mockReturnValue(null);
		const out = runFailureChannels({
			event: makeEvent(),
			session: SESSION,
			cwd: "/repo",
		});
		expect(out!.warnings.some((w) => w.startsWith("[interlinked:explain]"))).toBe(
			false,
		);
	});

	it("omits the explain warning when explainFailure throws (safeRun→null)", () => {
		explainFailureMock.mockImplementation(() => {
			throw new Error("explain exploded");
		});
		const out = runFailureChannels({
			event: makeEvent(),
			session: SESSION,
			cwd: "/repo",
		});
		expect(out!.warnings.some((w) => w.startsWith("[interlinked:explain]"))).toBe(
			false,
		);
	});

	it("skips the rollback line when assessRollbackFeasibility throws (safeRun→undefined)", () => {
		assessRollbackMock.mockImplementation(() => {
			throw new Error("rollback exploded");
		});
		const out = runFailureChannels({
			event: makeEvent(),
			session: SESSION,
			cwd: "/repo",
		});
		expect(out!.warnings.some((w) => w.startsWith("[interlinked:rollback]"))).toBe(
			false,
		);
		expect(formatRollbackLineMock).not.toHaveBeenCalled();
		// record.rollback is the undefined fallback.
		const [record] = nonNull(writeFailureRecordMock.mock.calls[0]);
		expect(record.rollback).toBeUndefined();
	});
});

// --- Rollback gating branches ------------------------------------------

describe("runFailureChannels rollback gating", () => {
	it("skips rollback entirely when no session is supplied", () => {
		const out = runFailureChannels({ event: makeEvent(), cwd: "/repo" });
		expect(assessRollbackMock).not.toHaveBeenCalled();
		expect(out!.warnings.some((w) => w.startsWith("[interlinked:rollback]"))).toBe(
			false,
		);
	});

	it("skips rollback when the tool is not a file-edit tool", () => {
		const out = runFailureChannels({
			event: makeEvent({ tool_name: "Bash", tool_input: { file_path: "x" } }),
			session: SESSION,
			cwd: "/repo",
		});
		expect(assessRollbackMock).not.toHaveBeenCalled();
		expect(out!.warnings.some((w) => w.startsWith("[interlinked:rollback]"))).toBe(
			false,
		);
	});

	it("skips rollback when no file path can be extracted", () => {
		const out = runFailureChannels({
			event: makeEvent({ tool_input: {} }),
			session: SESSION,
			cwd: "/repo",
		});
		expect(assessRollbackMock).not.toHaveBeenCalled();
		expect(out!.warnings.some((w) => w.startsWith("[interlinked:rollback]"))).toBe(
			false,
		);
	});

	it("runs rollback for an alternate file-edit tool (e.g. apply_patch)", () => {
		const out = runFailureChannels({
			event: makeEvent({ tool_name: "apply_patch" }),
			session: SESSION,
			cwd: "/repo",
		});
		expect(assessRollbackMock).toHaveBeenCalledTimes(1);
		expect(out!.warnings.some((w) => w.startsWith("[interlinked:rollback]"))).toBe(
			true,
		);
	});

	it("assesses rollback but emits no line when formatRollbackLine returns null", () => {
		formatRollbackLineMock.mockReturnValue(null);
		const out = runFailureChannels({
			event: makeEvent(),
			session: SESSION,
			cwd: "/repo",
		});
		expect(assessRollbackMock).toHaveBeenCalledTimes(1);
		expect(formatRollbackLineMock).toHaveBeenCalledTimes(1);
		expect(out!.warnings.some((w) => w.startsWith("[interlinked:rollback]"))).toBe(
			false,
		);
		// rollback assessment is still stored on the record.
		const [record] = nonNull(writeFailureRecordMock.mock.calls[0]);
		expect(record.rollback).toEqual(SAFE_ROLLBACK);
	});
});

// --- Disk-write catch path ---------------------------------------------

describe("runFailureChannels disk write", () => {
	it("returns empty record_path and omits the record warning when write throws", () => {
		writeFailureRecordMock.mockImplementation(() => {
			throw new Error("disk full");
		});
		const out = runFailureChannels({
			event: makeEvent(),
			session: SESSION,
			cwd: "/repo",
		});
		expect(out!.record_path).toBe("");
		expect(out!.warnings.some((w) => w.startsWith("[interlinked:failure]"))).toBe(
			false,
		);
		// Earlier channel warnings still flow through.
		expect(out!.warnings.some((w) => w.startsWith("[interlinked:triage]"))).toBe(
			true,
		);
	});
});

// --- formatTriageLine branch (suppressed line) -------------------------

describe("triage line suppression", () => {
	it("omits the triage warning for the unknown/no-diagnostic sentinel", () => {
		classifyFailureMock.mockReturnValue({
			label: "unknown",
			category: "no-diagnostic",
			confidence: 0,
			source: "local-heuristic",
		});
		const out = runFailureChannels({
			event: makeEvent(),
			session: SESSION,
			cwd: "/repo",
		});
		expect(out!.warnings.some((w) => w.startsWith("[interlinked:triage]"))).toBe(
			false,
		);
		// signature falls back to category ("no-diagnostic").
		expect(out!.signature).toBe(
			"tool_failure:Edit:no-diagnostic:boom happened",
		);
	});

	it("emits the triage line when label is unknown but category is not no-diagnostic", () => {
		classifyFailureMock.mockReturnValue({
			label: "unknown",
			category: "weird",
			confidence: 0.5,
			source: "local-heuristic",
		});
		const out = runFailureChannels({
			event: makeEvent(),
			session: SESSION,
			cwd: "/repo",
		});
		expect(out!.warnings).toContain(
			"[interlinked:triage] unknown / weird (50% local-heuristic)",
		);
	});
});

// --- buildSignature derivation branches --------------------------------

describe("signature derivation", () => {
	it("falls back to the triage label when category is empty", () => {
		classifyFailureMock.mockReturnValue({
			label: "transient",
			category: "",
			confidence: 0.3,
			source: "local-heuristic",
		});
		const out = runFailureChannels({
			event: makeEvent(),
			session: SESSION,
			cwd: "/repo",
		});
		// errClass = category("") || label("transient")
		expect(out!.signature).toBe("tool_failure:Edit:transient:boom happened");
	});

	it("uses stderr for the signature prefix when error_message is absent", () => {
		const out = runFailureChannels({
			event: makeEvent({ stderr: "   raw   stderr   text " }, ["error_message"]),
			session: SESSION,
			cwd: "/repo",
		});
		// whitespace collapsed + trimmed + sliced to 30 chars.
		expect(out!.signature).toBe("tool_failure:Edit:type-mismatch:raw stderr text");
	});

	it("yields an empty message prefix when both error_message and stderr are absent", () => {
		const out = runFailureChannels({
			event: makeEvent({}, ["error_message", "stderr"]),
			session: SESSION,
			cwd: "/repo",
		});
		expect(out!.signature).toBe("tool_failure:Edit:type-mismatch:");
	});

	it("truncates the message prefix to 30 characters", () => {
		const long = "x".repeat(50);
		const out = runFailureChannels({
			event: makeEvent({ error_message: long }),
			session: SESSION,
			cwd: "/repo",
		});
		expect(out!.signature).toBe(`tool_failure:Edit:type-mismatch:${"x".repeat(30)}`);
	});
});

// --- extractFilePath branches ------------------------------------------

describe("file-path extraction", () => {
	it("prefers tool_input.file_path", () => {
		runFailureChannels({
			event: makeEvent({ tool_input: { file_path: "a.ts", path: "b.ts" } }),
			session: SESSION,
			cwd: "/repo",
		});
		expect(nonNull(recordToolFailureMock.mock.calls[0])[0].file).toBe("a.ts");
	});

	it("falls back to tool_input.path when file_path is absent", () => {
		runFailureChannels({
			event: makeEvent({ tool_input: { path: "b.ts" } }),
			session: SESSION,
			cwd: "/repo",
		});
		expect(nonNull(recordToolFailureMock.mock.calls[0])[0].file).toBe("b.ts");
		expect(nonNull(assessRollbackMock.mock.calls[0])[0]).toBe("b.ts");
	});

	it("treats a non-string file_path as absent and falls through to path", () => {
		runFailureChannels({
			event: makeEvent({ tool_input: { file_path: 123, path: "b.ts" } }),
			session: SESSION,
			cwd: "/repo",
		});
		expect(nonNull(recordToolFailureMock.mock.calls[0])[0].file).toBe("b.ts");
	});

	it("treats an empty-string file_path as absent and falls through to path", () => {
		runFailureChannels({
			event: makeEvent({ tool_input: { file_path: "", path: "b.ts" } }),
			session: SESSION,
			cwd: "/repo",
		});
		expect(nonNull(recordToolFailureMock.mock.calls[0])[0].file).toBe("b.ts");
	});

	it("treats a non-string path as absent → undefined file (no rollback)", () => {
		runFailureChannels({
			event: makeEvent({ tool_input: { path: 42 } }),
			session: SESSION,
			cwd: "/repo",
		});
		expect(nonNull(recordToolFailureMock.mock.calls[0])[0].file).toBeUndefined();
		expect(assessRollbackMock).not.toHaveBeenCalled();
	});

	it("treats an empty-string path as absent → undefined file", () => {
		runFailureChannels({
			event: makeEvent({ tool_input: { path: "" } }),
			session: SESSION,
			cwd: "/repo",
		});
		expect(nonNull(recordToolFailureMock.mock.calls[0])[0].file).toBeUndefined();
	});

	it("yields undefined file when tool_input itself is absent", () => {
		runFailureChannels({
			event: makeEvent({ tool_input: undefined }),
			session: SESSION,
			cwd: "/repo",
		});
		expect(nonNull(recordToolFailureMock.mock.calls[0])[0].file).toBeUndefined();
	});
});

// --- toFailureEvent passthrough ----------------------------------------

describe("toFailureEvent construction", () => {
	it("forwards canonical diagnostic fields into the failure event", () => {
		runFailureChannels({ event: makeEvent(), session: SESSION, cwd: "/repo" });
		const passed = nonNull(classifyFailureMock.mock.calls[0])[0];
		expect(passed).toMatchObject({
			session_id: "sess-1",
			agent_source: "claude",
			tool_name: "Edit",
			tool_use_id: "tu-1",
			error_message: "boom happened",
			exit_code: 2,
			stderr: "stderr text",
			stdout: "stdout text",
			timestamp: "2026-06-05T00:00:00Z",
		});
	});

	it("forwards the event's tool_name into the failure event unchanged", () => {
		// NOTE: toFailureEvent applies `event.tool_name ?? "unknown"`, but that
		// nullish fallback is unreachable through the public API — runFailureChannels
		// returns null on a falsy tool_name (line 83 guard) before toFailureEvent is
		// ever called, so event.tool_name is always a truthy string here. toFailureEvent
		// is not exported, so the fallback cannot be exercised without editing the source.
		runFailureChannels({
			event: makeEvent({ tool_name: "Write" }),
			session: SESSION,
			cwd: "/repo",
		});
		const passed = nonNull(classifyFailureMock.mock.calls[0])[0];
		expect(passed.tool_name).toBe("Write");
	});

	it("message defaults to undefined in the recurrence row when error_message is absent", () => {
		runFailureChannels({
			event: makeEvent({}, ["error_message"]),
			session: SESSION,
			cwd: "/repo",
		});
		expect(nonNull(recordToolFailureMock.mock.calls[0])[0].message).toBeUndefined();
	});
});
