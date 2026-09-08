import { makeGuardRules } from "./__tests__/fixtures.js";
// Mutation-kill wave 28 for pre-tool-guards.ts.
//
// The sibling `pre-tool-guards.integration.test.ts` drives these guards
// through real fs/git fixtures and asserts on the final decision. That
// style leaves a class of mutant alive: a fallback literal (`|| ""`), a
// truthiness-forced condition (`cond` -> `true`/`false`), or a nullish-vs-
// logical operator swap (`?? ` -> `&&`) that happens to produce the SAME
// final decision through the downstream real implementation (e.g. an empty
// protected-files list returns null either way). These tests mock each
// guard's one injected dependency and assert on the EXACT call args (or
// non-call), which is the only way to observe these mutants directly.
//
// test-contract: unit (mocked collaborators) — the target here is the
// guard's own branch/fallback wiring, not the collaborator's behavior,
// which is covered by that collaborator's own test file.

import { makeSession as makeSessionFixture } from "../__tests__/fixtures/evaluator.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../types.js";

const mocks = vi.hoisted(() => ({
	isInspectionWrapperCall: vi.fn<typeof import("./inspection-wrapper.js").isInspectionWrapperCall>(() => false),
	parseInstallCommands: vi.fn<typeof import("../package-install-parser.js").parseInstallCommands>(() => []),
	loadAllowlist: vi.fn<typeof import("../package-allowlist.js").loadAllowlist>(),
	evaluatePackageInstall: vi.fn<typeof import("./package-install-guard.js").evaluatePackageInstall>(() => null),
	evaluateGitScopeGateSync: vi.fn<typeof import("./git-session-scope-gate.js").evaluateGitScopeGateSync>(() => null),
	evaluateProtectedFiles: vi.fn<typeof import("./filesystem-guards.js").evaluateProtectedFiles>(() => null),
	evaluateRepoConfinement: vi.fn<typeof import("./filesystem-guards.js").evaluateRepoConfinement>(() => null),
	evaluateTddNewFileGateForEvent: vi.fn<typeof import("./tdd-new-file-gate.js").evaluateTddNewFileGateForEvent>(() => null),
	evaluateCharacterizeForEvent: vi.fn<typeof import("./characterize-before-touch.js").evaluateCharacterizeForEvent>(() => null),
	evaluateConfigLooseningForEvent: vi.fn<typeof import("./config-loosening-gate.js").evaluateConfigLooseningForEvent>(() => null),
	evaluateBaselineIntegrityForEvent: vi.fn<typeof import("./baseline-integrity-gate.js").evaluateBaselineIntegrityForEvent>(() => null),
	baselineBashWriteRefusal: vi.fn<typeof import("./baseline-bash-guard.js").baselineBashWriteRefusal>(() => null),
	evaluateManifestEdit: vi.fn<typeof import("./manifest-edit-guard.js").evaluateManifestEdit>(() => null),
	computeFullNewContent: vi.fn<typeof import("./pre-tool-helpers.js").computeFullNewContent>(() => null),
	containsSecrets: vi.fn<typeof import("./pre-tool-helpers.js").containsSecrets>(() => false),
}));

vi.mock("./inspection-wrapper.js", () => ({
	isInspectionWrapperCall: mocks.isInspectionWrapperCall,
}));
vi.mock("../package-install-parser.js", () => ({
	parseInstallCommands: mocks.parseInstallCommands,
}));
vi.mock("../package-allowlist.js", () => ({ loadAllowlist: mocks.loadAllowlist }));
vi.mock("./package-install-guard.js", () => ({
	evaluatePackageInstall: mocks.evaluatePackageInstall,
}));
vi.mock("./git-session-scope-gate.js", () => ({
	evaluateGitScopeGateSync: mocks.evaluateGitScopeGateSync,
}));
vi.mock("./filesystem-guards.js", () => ({
	evaluateProtectedFiles: mocks.evaluateProtectedFiles,
	evaluateRepoConfinement: mocks.evaluateRepoConfinement,
}));
vi.mock("./tdd-new-file-gate.js", () => ({
	evaluateTddNewFileGateForEvent: mocks.evaluateTddNewFileGateForEvent,
}));
vi.mock("./characterize-before-touch.js", () => ({
	evaluateCharacterizeForEvent: mocks.evaluateCharacterizeForEvent,
}));
vi.mock("./config-loosening-gate.js", () => ({
	evaluateConfigLooseningForEvent: mocks.evaluateConfigLooseningForEvent,
}));
vi.mock("./baseline-integrity-gate.js", () => ({
	evaluateBaselineIntegrityForEvent: mocks.evaluateBaselineIntegrityForEvent,
}));
vi.mock("./baseline-bash-guard.js", () => ({
	baselineBashWriteRefusal: mocks.baselineBashWriteRefusal,
}));
vi.mock("./manifest-edit-guard.js", () => ({ evaluateManifestEdit: mocks.evaluateManifestEdit }));
vi.mock("./pre-tool-helpers.js", () => ({
	computeFullNewContent: mocks.computeFullNewContent,
	containsSecrets: mocks.containsSecrets,
}));

import {
	evaluateBaselineIntegrityGate,
	evaluateConfigLooseningGate,
	evaluateGitScopeGate,
	evaluateManifestEditGuard,
	evaluateMetaTestWrapper,
	evaluatePackageInstallGuard,
	evaluateProtectedFilesGuard,
	evaluateRepoConfinementGuard,
	evaluateTddGate,
} from "./pre-tool-guards.js";

type ToolInput = NonNullable<HarnessEvent["tool_input"]>;

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-w28",
		agent_source: "claude",
		timestamp: "2026-06-07T00:00:00.000Z",
		cwd: "/tmp/pre-tool-guards-w28",
		...overrides,
	};
}

function makeSession(): SessionTrajectory {
	return ({ ...makeSessionFixture(), session_id: "sess-w28" } satisfies SessionTrajectory);
}

function makeRules(overrides: Partial<GuardRulesConfig> = {}): GuardRulesConfig {
	return ({ ...makeGuardRules(),
		protected_files: [],
		repo_confinement_allowlist: [],
		linked_projects: [],
		...overrides,
	} satisfies GuardRulesConfig);
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	delete process.env.INTERLINKED_DISABLE_PACKAGE_GUARD;
});

// ============================================================
// evaluateMetaTestWrapper
// ============================================================

describe("evaluateMetaTestWrapper — mutation kill", () => {
	// test-contract: boundary — non-string tool_input.command must coerce to
	// the documented "" fallback (line 53), not pass through raw.
	it("calls isInspectionWrapperCall with the empty-string fallback, never the raw non-string value", () => {
		const result = evaluateMetaTestWrapper("Bash", { command: 42 });
		expect(result).toBeNull();
		expect(mocks.isInspectionWrapperCall).toHaveBeenCalledWith("");
	});
});

// ============================================================
// evaluatePackageInstallGuard
// ============================================================

describe("evaluatePackageInstallGuard — mutation kill", () => {
	// test-contract: invariant — an absent command (line 95's "" fallback)
	// must be falsy at the line-96 `if (cmd)` gate, never trigger parsing.
	it("never calls parseInstallCommands when the command field is absent", () => {
		const result = evaluatePackageInstallGuard(makeEvent(), "Bash", ({} satisfies ToolInput));
		expect(result).toBeNull();
		expect(mocks.parseInstallCommands).not.toHaveBeenCalled();
	});

	// test-contract: boundary — `installCommands.length > 0` (line 98) must
	// gate the allowlist load; a zero-length parse must short-circuit.
	it("skips allowlist load and install evaluation when no install commands are parsed", () => {
		mocks.parseInstallCommands.mockReturnValueOnce([]);
		const result = evaluatePackageInstallGuard(makeEvent(), "Bash", { command: "echo hi" });
		expect(result).toBeNull();
		expect(mocks.loadAllowlist).not.toHaveBeenCalled();
		expect(mocks.evaluatePackageInstall).not.toHaveBeenCalled();
	});
});

// ============================================================
// evaluateGitScopeGate
// ============================================================

describe("evaluateGitScopeGate — mutation kill", () => {
	// test-contract: invariant — an absent command (line 128's "" fallback)
	// must be falsy at the line-129 `if (cmd)` gate, never reach the sync gate.
	it("never calls evaluateGitScopeGateSync when the command field is absent", () => {
		const rules = makeRules({
			git_session_scope_gate: { enabled: true, mode: "ask" },
		} satisfies Partial<GuardRulesConfig>);
		const result = evaluateGitScopeGate(
			makeEvent(),
			rules,
			makeSession(),
			"Bash",
			({} satisfies ToolInput),
			[],
		);
		expect(result).toBeNull();
		expect(mocks.evaluateGitScopeGateSync).not.toHaveBeenCalled();
	});

	// test-contract: invariant — line 137's `verdict.reason ?? default` must
	// substitute only on null/undefined, and produce the literal default text.
	it("falls back to the default ambiguous-scope reason when verdict.reason is undefined (not just falsy)", () => {
		mocks.evaluateGitScopeGateSync.mockReturnValueOnce({
			decision: "ask",
			resolved_files: [],
			unauthorized_files: [],
			baseline_files: [],
		});
		const rules = makeRules({
			git_session_scope_gate: { enabled: true, mode: "ask" },
		} satisfies Partial<GuardRulesConfig>);
		const result = evaluateGitScopeGate(
			makeEvent(),
			rules,
			makeSession(),
			"Bash",
			{ command: "git add x" },
			[],
		);
		expect(result?.reason).toBe("git operation scope ambiguous");
	});
});

// ============================================================
// evaluateProtectedFilesGuard
// ============================================================

describe("evaluateProtectedFilesGuard — mutation kill", () => {
	// test-contract: boundary — line 172's `isFileOperation||isFileWrite`
	// gate must exclude Bash; forcing it true would call the collaborator.
	it("never calls evaluateProtectedFiles for a tool that is neither a file-op nor a file-write", () => {
		const result = evaluateProtectedFilesGuard("Bash", { command: "ls" }, makeRules(), []);
		expect(result).toBeNull();
		expect(mocks.evaluateProtectedFiles).not.toHaveBeenCalled();
	});

	// test-contract: invariant — an absent file_path/path (line 173's ""
	// fallback) must be falsy at the line-174 `if (filePath)` gate.
	it("never calls evaluateProtectedFiles when neither file_path nor path is present", () => {
		const result = evaluateProtectedFilesGuard("Write", { content: "x" }, makeRules(), []);
		expect(result).toBeNull();
		expect(mocks.evaluateProtectedFiles).not.toHaveBeenCalled();
	});

	// test-contract: invariant — content must resolve to the "" fallback
	// (line 175) when neither source field is present; a boolean/incidental
	// value here would reach the downstream secrets check malformed.
	it("passes an empty-string content when neither content nor new_string is present", () => {
		const result = evaluateProtectedFilesGuard(
			"Write",
			{ file_path: "a.txt" },
			makeRules(),
			[],
		);
		expect(result).toBeNull();
		expect(mocks.evaluateProtectedFiles).toHaveBeenCalledWith(
			expect.objectContaining({ filePath: "a.txt", content: "" }),
		);
	});

	// test-contract: invariant — `content` must win over the "" fallback when
	// present (line 175's first `||` arm), never be dropped by an operator swap.
	it("passes the raw content string through when only content (not new_string) is present", () => {
		const result = evaluateProtectedFilesGuard(
			"Write",
			{ file_path: "b.txt", content: "hello" },
			makeRules(),
			[],
		);
		expect(result).toBeNull();
		expect(mocks.evaluateProtectedFiles).toHaveBeenCalledWith(
			expect.objectContaining({ filePath: "b.txt", content: "hello" }),
		);
	});
});

// ============================================================
// evaluateRepoConfinementGuard
// ============================================================

describe("evaluateRepoConfinementGuard — mutation kill", () => {
	// test-contract: invariant — an absent file_path/path (line 198's ""
	// fallback) must be falsy at the line-199 `if (rawPath)` gate.
	it("never calls evaluateRepoConfinement when no path is present", () => {
		const result = evaluateRepoConfinementGuard(
			makeEvent(),
			"Write",
			({} satisfies ToolInput),
			makeRules(),
			[],
		);
		expect(result).toBeNull();
		expect(mocks.evaluateRepoConfinement).not.toHaveBeenCalled();
	});

	// test-contract: invariant — an absent allowlist/linked_projects key must
	// resolve to `[]` (lines 203-204), never to a non-empty sentinel array.
	it("defaults allowlist and linkedProjects to [] when rules omit both keys", () => {
		const rules = ({ ...makeGuardRules(),  protected_files: [] } satisfies GuardRulesConfig);
		const result = evaluateRepoConfinementGuard(
			makeEvent(),
			"Write",
			{ file_path: "x.txt" },
			rules,
			[],
		);
		expect(result).toBeNull();
		expect(mocks.evaluateRepoConfinement).toHaveBeenCalledWith(
			expect.objectContaining({ allowlist: [], linkedProjects: [] }),
		);
	});
});

// ============================================================
// evaluateTddGate (+ mergeGateWarnings, exercised only from here)
// ============================================================

describe("evaluateTddGate — mutation kill", () => {
	// test-contract: boundary — line 221's `isFileWrite(toolName)` gates both
	// sub-gates; a non-write tool must call neither.
	it("skips both TDD sub-gates for a non-file-write tool", () => {
		const result = evaluateTddGate(makeEvent(), makeRules(), makeSession(), "Bash", []);
		expect(result).toBeNull();
		expect(mocks.evaluateTddNewFileGateForEvent).not.toHaveBeenCalled();
		expect(mocks.evaluateCharacterizeForEvent).not.toHaveBeenCalled();
	});

	// test-contract: invariant — line 227-228's `if (c) return ...` must fire
	// on a truthy characterize-gate decision, not just the new-file gate.
	it("returns the characterize-gate decision when the new-file gate is silent and the characterize gate fires", () => {
		mocks.evaluateTddNewFileGateForEvent.mockReturnValueOnce(null);
		mocks.evaluateCharacterizeForEvent.mockReturnValueOnce({
			decision: "block",
			reason: "needs characterization test",
		});
		const event = makeEvent();
		const rules = makeRules();
		const session = makeSession();
		const warnings: string[] = [];
		const result = evaluateTddGate(event, rules, session, "Write", warnings);
		expect(mocks.evaluateCharacterizeForEvent).toHaveBeenCalledOnce();
		expect(mocks.evaluateCharacterizeForEvent).toHaveBeenCalledWith(event, rules, session);
		expect(result?.decision).toBe("block");
		expect(result?.reason).toBe("needs characterization test");
	});

	// test-contract: invariant — mergeGateWarnings's line-238 `if (d.warnings)`
	// must push the sub-gate's own warnings onto the shared array.
	it("merges the sub-gate's own warnings into the shared warnings array (not just its own decision)", () => {
		mocks.evaluateTddNewFileGateForEvent.mockReturnValueOnce({
			decision: "block",
			reason: "no companion test",
			warnings: ["sub-gate warning"],
		});
		const warnings: string[] = ["outer warning"];
		const result = evaluateTddGate(makeEvent(), makeRules(), makeSession(), "Write", warnings);
		expect(result?.warnings).toEqual(["outer warning", "sub-gate warning"]);
	});
});

// ============================================================
// evaluateConfigLooseningGate
// ============================================================

describe("evaluateConfigLooseningGate — mutation kill", () => {
	// test-contract: boundary — isFileWrite(toolName) gates line 251; a
	// non-write tool must short-circuit before the sub-gate ever runs.
	it("never calls evaluateConfigLooseningForEvent for a non-file-write tool", () => {
		const result = evaluateConfigLooseningGate(makeEvent(), "Bash", []);
		expect(result).toBeNull();
		expect(mocks.evaluateConfigLooseningForEvent).not.toHaveBeenCalled();
	});
});

// ============================================================
// evaluateBaselineIntegrityGate (+ its internal bashBaselineRefusal helper)
// ============================================================

describe("evaluateBaselineIntegrityGate — mutation kill", () => {
	// test-contract: boundary — line 285's `isFileWrite` and line 289's
	// `toolName === "Bash"` must both exclude a plain Read call.
	it("never evaluates either baseline path for a read-only tool", () => {
		const result = evaluateBaselineIntegrityGate(makeEvent({ tool_name: "Read" }), "Read", []);
		expect(result).toBeNull();
		expect(mocks.evaluateBaselineIntegrityForEvent).not.toHaveBeenCalled();
		expect(mocks.baselineBashWriteRefusal).not.toHaveBeenCalled();
	});

	// test-contract: boundary — toolName === "Bash" (line 289) must route into
	// bashBaselineRefusal; with the default null return the guard is null too.
	it("does evaluate the bash baseline-refusal path for an actual Bash call", () => {
		const event = makeEvent({ tool_name: "Bash", tool_input: { command: "echo hi" } });
		const result = evaluateBaselineIntegrityGate(event, "Bash", []);
		expect(result).toBeNull();
		expect(mocks.baselineBashWriteRefusal).toHaveBeenCalledWith("echo hi", event.cwd);
	});

	// test-contract: bug — event.tool_input?.command (line 273) must tolerate
	// a wholly absent tool_input without throwing.
	it("does not throw when tool_input is entirely absent on a Bash call", () => {
		const event = makeEvent({ tool_name: "Bash" });
		delete event.tool_input;
		let result: ReturnType<typeof evaluateBaselineIntegrityGate>;
		expect(() => {
			result = evaluateBaselineIntegrityGate(event, "Bash", []);
		}).not.toThrow();
		expect(result!).toBeNull();
	});

	// test-contract: invariant — a string command (line 274) must pass through
	// verbatim to baselineBashWriteRefusal, not the "" fallback.
	it("passes the raw command string through when tool_input.command is a string", () => {
		const event = makeEvent({ tool_name: "Bash", tool_input: { command: "echo hi" } });
		const result = evaluateBaselineIntegrityGate(event, "Bash", []);
		expect(result).toBeNull();
		expect(mocks.baselineBashWriteRefusal).toHaveBeenCalledWith("echo hi", expect.any(String));
	});

	// test-contract: invariant — a non-string command (line 274) must resolve
	// to the "" fallback, not the raw non-string value.
	it("falls back to an empty command string when tool_input.command is not a string", () => {
		const event = makeEvent({
			tool_name: "Bash",
			tool_input: { command: 42 },
		});
		const result = evaluateBaselineIntegrityGate(event, "Bash", []);
		expect(result).toBeNull();
		expect(mocks.baselineBashWriteRefusal).toHaveBeenCalledWith("", expect.any(String));
	});

	// test-contract: invariant — an absent event.cwd (line 275) must resolve
	// to process.cwd(), not the nullish value itself.
	it("falls back to process.cwd() when event.cwd is absent", () => {
		const event = makeEvent({ tool_name: "Bash", tool_input: { command: "echo hi" } });
		delete event.cwd;
		const result = evaluateBaselineIntegrityGate(event, "Bash", []);
		expect(result).toBeNull();
		expect(mocks.baselineBashWriteRefusal).toHaveBeenCalledWith("echo hi", process.cwd());
	});

	// test-contract: invariant — line 276's `if (!reason) return null;` must
	// let a truthy reason through to a real block decision.
	it("returns a block decision carrying baselineBashWriteRefusal's own reason", () => {
		mocks.baselineBashWriteRefusal.mockReturnValueOnce("baseline loosened");
		const event = makeEvent({ tool_name: "Bash", tool_input: { command: "echo hi" } });
		const result = evaluateBaselineIntegrityGate(event, "Bash", []);
		expect(result?.decision).toBe("block");
		expect(result?.reason).toBe("baseline loosened");
	});
});

// ============================================================
// evaluateManifestEditGuard
// ============================================================

describe("evaluateManifestEditGuard — mutation kill", () => {
	// test-contract: invariant — an absent file_path/path (line 348's ""
	// fallback) must be falsy at the line-349 `if (mfPath)` gate.
	it("never calls computeFullNewContent when no manifest path is present", () => {
		const result = evaluateManifestEditGuard(makeEvent(), "Write", ({} satisfies ToolInput), []);
		expect(result).toBeNull();
		expect(mocks.computeFullNewContent).not.toHaveBeenCalled();
	});

	// test-contract: invariant — line 353's `fullNewContent !== null` must
	// gate the manifest-edit evaluation; a null resolve must skip it.
	it("never calls evaluateManifestEdit when computeFullNewContent resolves to null", () => {
		mocks.computeFullNewContent.mockReturnValueOnce(null);
		const result = evaluateManifestEditGuard(
			makeEvent(),
			"Write",
			{ file_path: "package.json", content: "{}" },
			[],
		);
		expect(result).toBeNull();
		expect(mocks.evaluateManifestEdit).not.toHaveBeenCalled();
	});
});
