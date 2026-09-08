import { wireAbsentOptional, parseWire, wireArray, wireBoolean, wireNumber, wireObject, wireOptional, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
// ===========================================
// Behavioral tests for `interlinked git` (git.ts)
// ===========================================
// Covers gitContextCommand + gitLinkCheckpointCommand end-to-end:
// every output mode (json / normal), every server-context branch,
// the --apply amend+notes path (execSync), shell-arg sanitization,
// trailer filtering, and all error / catch branches.
//
// Strategy: git-utils + attribution + api-client + node:child_process
// are mocked (deterministic, no real subprocess). formatter + output
// stay REAL so the rendering branches are exercised honestly; NO_COLOR
// is forced before any import so ANSI is stripped and we can assert
// plain output strings.

// NO_COLOR must be set before formatter.ts is imported (it reads the env
// once at module load to decide whether to emit ANSI).
process.env.NO_COLOR = "1";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";

// --- mock surfaces ---------------------------------------------------------

const mockExecSync = vi.fn<typeof import("node:child_process").execSync>();
vi.mock("node:child_process", () => ({
	execSync: (...args: Parameters<typeof mockExecSync>) => mockExecSync(...args),
}));

const mockIsGitRepo = vi.fn<(cwd: string) => boolean>();
const mockGetCurrentBranch = vi.fn<(cwd: string) => string | null>();
const mockGetHeadSha = vi.fn<(cwd: string, short?: boolean) => string | null>();
const mockGetCommitMessage = vi.fn<(ref: string, cwd: string) => string | null>();

vi.mock("../lib/git-utils.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/git-utils.js")>();
	return {
		...actual,
		// Keep the REAL parseInterlinkedTrailers so trailer parsing is exercised.
		parseInterlinkedTrailers: actual.parseInterlinkedTrailers,
		isGitRepo: (cwd: string) => mockIsGitRepo(cwd),
		getCurrentBranch: (cwd: string) => mockGetCurrentBranch(cwd),
		getHeadSha: (cwd: string, short?: boolean) => mockGetHeadSha(cwd, short),
		getCommitMessage: (ref: string, cwd: string) => mockGetCommitMessage(ref, cwd),
	};
});

interface AttributionShape {
	agent_lines: number;
	human_lines: number;
	total_lines: number;
	agent_percentage: number;
	per_file: Record<string, { agent: number; human: number }>;
}
const mockReadAttributionTrailer = vi.fn<(ref?: string, cwd?: string) => AttributionShape | null>();
vi.mock("../lib/attribution.js", () => ({
	readAttributionTrailer: (ref?: string, cwd?: string) => mockReadAttributionTrailer(ref, cwd),
}));

const mockCallTool = vi.fn();
vi.mock("../lib/api-client.js", () => ({
	getClient: () => ({ callTool: mockCallTool }),
}));

// Import AFTER the mocks are registered.
import { gitContextCommand, gitLinkCheckpointCommand } from "./git.js";

// --- console / exit capture ------------------------------------------------

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	process.exitCode = 0;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

	// Sensible defaults — individual tests override as needed.
	mockIsGitRepo.mockReturnValue(true);
	mockGetCurrentBranch.mockReturnValue("main");
	mockGetHeadSha.mockImplementation((_cwd, short) =>
		short === false ? "abc123f456789abcdef0123456789012345678901" : "abc123f",
	);
	mockGetCommitMessage.mockReturnValue("Subject line\n\nBody text");
	mockReadAttributionTrailer.mockReturnValue(null);
	mockExecSync.mockReturnValue("");
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
});

/** Concatenated stdout across all console.log calls (NO_COLOR → plain text). */
function stdout(): string {
	return logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
}
/** Concatenated stderr across all console.error calls. */
function stderr(): string {
	return errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
}
/** Parse the single JSON document printed in --json mode. */
function lastJson(): unknown {
	const raw = logSpy.mock.calls.at(-1)?.[0];
	return JSON.parse(String(raw));
}

// ===========================================================================
// gitContextCommand
// ===========================================================================

describe("gitContextCommand — guard + error branches", () => {
	it("errors to stderr + exit 1 when not in a git repo", async () => {
		mockIsGitRepo.mockReturnValue(false);

		await gitContextCommand({});

		expect(process.exitCode).toBe(1);
		expect(stderr()).toContain("Error: Not a git repository");
		// callTool must never be reached once the guard throws.
		expect(mockCallTool).not.toHaveBeenCalled();
	});

	it("JSON error mode emits a structured {error} document", async () => {
		mockIsGitRepo.mockReturnValue(false);

		await gitContextCommand({ json: true });

		expect(process.exitCode).toBe(1);
		const parsed = parseWire(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0])), wireObject({ "error": wireString }), "test JSON value");
		expect(parsed.error).toContain("Not a git repository");
	});

	it("gitContextCommand stringifies a non-Error throw in the outer catch (String(err) branch)", async () => {
		// A non-Error rejection from a local git helper hits the outer catch's
		// `err instanceof Error ? err.message : String(err)` else-branch.
		mockGetCurrentBranch.mockImplementation(() => {
			throw "branch lookup exploded"; // non-Error literal
		});

		await gitContextCommand({});

		expect(process.exitCode).toBe(1);
		expect(stderr()).toContain("Error: branch lookup exploded");
	});
});

describe("gitContextCommand — JSON mode (server shapes)", () => {
	it("uses ref 'HEAD' (not opts.commit) for local reads and omits commit_sha server arg", async () => {
		mockCallTool.mockResolvedValue({ trailers: [] });

		await gitContextCommand({ json: true });

		// ref defaulting: attribution + commit message read against "HEAD".
		expect(mockReadAttributionTrailer).toHaveBeenCalledWith("HEAD", process.cwd());
		expect(mockGetCommitMessage).toHaveBeenCalledWith("HEAD", process.cwd());
		// No --commit → server call args object is empty (no commit_sha key).
		expect(mockCallTool).toHaveBeenCalledWith("get_git_context", {});
	});

	it("passes commit_sha to the server and reads local refs at that commit", async () => {
		mockCallTool.mockResolvedValue({ trailers: [] });

		await gitContextCommand({ commit: "deadbee", json: true });

		expect(mockReadAttributionTrailer).toHaveBeenCalledWith("deadbee", process.cwd());
		expect(mockGetCommitMessage).toHaveBeenCalledWith("deadbee", process.cwd());
		expect(mockCallTool).toHaveBeenCalledWith("get_git_context", { commit_sha: "deadbee" });
	});

	it("maps latest_checkpoint into server context (summary present)", async () => {
		mockCallTool.mockResolvedValue({
			latest_checkpoint: { id: 42, agent: "Worker-Alpha", summary: "Auth refactor" },
			trailers: ["Interlinked-Checkpoint: 42"],
		});

		await gitContextCommand({ json: true });

		const out = parseWire(lastJson(), wireObject({ "server": wireObject({ "checkpoint": wireString, "agent": wireString }) }), "test JSON value");
		expect(out.server.checkpoint).toBe('#42 — "Auth refactor"');
		expect(out.server.agent).toBe("Worker-Alpha");
	});

	it("latest_checkpoint with missing summary falls back to empty quotes (|| '')", async () => {
		mockCallTool.mockResolvedValue({
			latest_checkpoint: { id: 7, agent: "Lead" },
			trailers: [],
		});

		await gitContextCommand({ json: true });

		const out = parseWire(lastJson(), wireObject({ "server": wireObject({ "checkpoint": wireString }) }), "test JSON value");
		expect(out.server.checkpoint).toBe('#7 — ""');
	});

	it("maps bridge_events[0] into server context (checkpoint_id + agent_name)", async () => {
		mockCallTool.mockResolvedValue({
			commit_sha: "deadbee",
			bridge_events: [{ id: 1, event_type: "push", checkpoint_id: 99, agent_name: "Bob" }],
			trailers: ["Interlinked-Agent: Bob"],
		});

		await gitContextCommand({ commit: "deadbee", json: true });

		const out = parseWire(lastJson(), wireObject({ "server": wireObject({ "checkpoint": wireString, "agent": wireString }) }), "test JSON value");
		expect(out.server.checkpoint).toBe('#99 — ""');
		expect(out.server.agent).toBe("Bob");
	});

	it("bridge_events with falsy checkpoint_id → checkpoint undefined, agent_name falls to undefined", async () => {
		mockCallTool.mockResolvedValue({
			bridge_events: [{ id: 1, event_type: "push", checkpoint_id: 0 }],
			trailers: [],
		});

		await gitContextCommand({ json: true });

		const out = parseWire(lastJson(), wireObject({ "server": wireObject({ "checkpoint": wireAbsentOptional(wireOptional(wireString)), "agent": wireAbsentOptional(wireOptional(wireString)) }) }), "test JSON value");
		// 0 is falsy → ternary picks undefined; serialized JSON drops the key.
		expect(out.server.checkpoint).toBeUndefined();
		expect(out.server.agent).toBeUndefined();
	});

	it("no checkpoint + no bridge events → server holds only trailers", async () => {
		mockCallTool.mockResolvedValue({ trailers: ["Interlinked-X: y"] });

		await gitContextCommand({ json: true });

		const out = parseWire(lastJson(), wireObject({ "server": wireObject({ "trailers": wireArray(wireString), "checkpoint": wireAbsentOptional(wireOptional(wireString)) }) }), "test JSON value");
		expect(out.server.trailers).toEqual(["Interlinked-X: y"]);
		expect(out.server.checkpoint).toBeUndefined();
	});

	it("falsy server result (null) → no server field is set", async () => {
		mockCallTool.mockResolvedValue(null);

		await gitContextCommand({ json: true });

		const out = parseWire(lastJson(), wireObject({ "server": wireAbsentOptional(wireOptional(wireUnknown)) }), "test JSON value");
		expect(out.server).toBeUndefined();
	});

	it("server rejects with auth error → server.error = 'not authenticated'", async () => {
		mockCallTool.mockRejectedValue(new Error("Not authenticated. Run login."));

		await gitContextCommand({ json: true });

		const out = parseWire(lastJson(), wireObject({ "server": wireObject({ "error": wireString }) }), "test JSON value");
		expect(out.server.error).toBe("not authenticated");
	});

	it("server rejects with generic Error → server.error = 'unreachable'", async () => {
		mockCallTool.mockRejectedValue(new Error("ECONNREFUSED"));

		await gitContextCommand({ json: true });

		const out = parseWire(lastJson(), wireObject({ "server": wireObject({ "error": wireString }) }), "test JSON value");
		expect(out.server.error).toBe("unreachable");
	});

	it("server rejects with a non-Error value → server.error = 'unreachable'", async () => {
		mockCallTool.mockRejectedValue("string failure");

		await gitContextCommand({ json: true });

		const out = parseWire(lastJson(), wireObject({ "server": wireObject({ "error": wireString }) }), "test JSON value");
		expect(out.server.error).toBe("unreachable");
	});

	it("serializes local branch/head/attribution/trailers from real parsing", async () => {
		mockGetCurrentBranch.mockReturnValue("feature/x");
		mockGetHeadSha.mockReturnValue("cafef00");
		mockReadAttributionTrailer.mockReturnValue({
			agent_lines: 145,
			human_lines: 56,
			total_lines: 201,
			agent_percentage: 72,
			per_file: {},
		});
		mockGetCommitMessage.mockReturnValue(
			"Subject\n\nInterlinked-Checkpoint: 42\nInterlinked-Agent: Worker-Alpha\nignored: nope",
		);
		mockCallTool.mockResolvedValue({ trailers: [] });

		await gitContextCommand({ json: true });

		const out = parseWire(lastJson(), wireObject({ "branch": wireString, "head": wireString, "attribution": wireObject({ "agent_percentage": wireNumber, "agent_lines": wireNumber, "total_lines": wireNumber }), "trailers": wireRecord(wireString) }), "test JSON value");
		expect(out.branch).toBe("feature/x");
		expect(out.head).toBe("cafef00");
		expect(out.attribution).toEqual({
			agent_percentage: 72,
			agent_lines: 145,
			total_lines: 201,
		});
		// Real parseInterlinkedTrailers: only Interlinked-* lines, "ignored" dropped.
		expect(out.trailers).toEqual({
			"Interlinked-Checkpoint": "42",
			"Interlinked-Agent": "Worker-Alpha",
		});
	});

	it("null commit message → trailers is an empty object ({} branch of ternary)", async () => {
		mockGetCommitMessage.mockReturnValue(null);
		mockCallTool.mockResolvedValue({ trailers: [] });

		await gitContextCommand({ json: true });

		const out = parseWire(lastJson(), wireObject({ "trailers": wireRecord(wireString) }), "test JSON value");
		expect(out.trailers).toEqual({});
	});
});

describe("gitContextCommand — normal (human) rendering", () => {
	it("renders full context: branch, HEAD, attribution, local trailers, server checkpoint+agent+trailers", async () => {
		mockGetCurrentBranch.mockReturnValue("main");
		mockGetHeadSha.mockReturnValue("abc123f");
		mockReadAttributionTrailer.mockReturnValue({
			agent_lines: 145,
			human_lines: 56,
			total_lines: 201,
			agent_percentage: 72,
			per_file: {},
		});
		mockGetCommitMessage.mockReturnValue("Subj\n\nInterlinked-Checkpoint: 42");
		mockCallTool.mockResolvedValue({
			latest_checkpoint: { id: 42, agent: "Worker-Alpha", summary: "Auth" },
			// One trailer with a colon (key/value split) + one without (raw line).
			trailers: ["Interlinked-Agent: Worker-Alpha", "no-colon-line"],
		});

		await gitContextCommand({});

		const out = stdout();
		expect(out).toContain("Git Context");
		expect(out).toContain("Branch");
		expect(out).toContain("main");
		expect(out).toContain("HEAD");
		expect(out).toContain("abc123f");
		expect(out).toContain("72% agent (145/201 lines)");
		expect(out).toContain("Local Trailers");
		expect(out).toContain("Server Context");
		expect(out).toContain("Checkpoint");
		expect(out).toContain('#42 — "Auth"');
		expect(out).toContain("Agent");
		expect(out).toContain("Worker-Alpha");
		// Colon-split trailer key rendered, and the raw no-colon line printed verbatim.
		expect(out).toContain("no-colon-line");
	});

	it("renders detached-HEAD + unknown-HEAD placeholders and skips attribution/trailers when absent", async () => {
		mockGetCurrentBranch.mockReturnValue(null); // detached
		mockGetHeadSha.mockReturnValue(null); // unknown
		mockReadAttributionTrailer.mockReturnValue(null); // no attribution block
		mockGetCommitMessage.mockReturnValue("Subject only, no trailers");
		mockCallTool.mockResolvedValue({ trailers: [] }); // empty → no per-trailer lines

		await gitContextCommand({});

		const out = stdout();
		expect(out).toContain("detached HEAD");
		expect(out).toContain("unknown");
		expect(out).not.toContain("Attribution");
		expect(out).not.toContain("Local Trailers");
		// Server present but has only an empty trailers array → header shown, no rows.
		expect(out).toContain("Server Context");
	});

	it("renders the server.error line (yellow path) in normal mode", async () => {
		mockCallTool.mockRejectedValue(new Error("Not authenticated"));

		await gitContextCommand({});

		expect(stdout()).toContain("Server");
		expect(stdout()).toContain("not authenticated");
	});

	it("omits the Server section entirely when result.server is unset (null server result)", async () => {
		mockCallTool.mockResolvedValue(null);

		await gitContextCommand({});

		const out = stdout();
		expect(out).toContain("Git Context");
		expect(out).not.toContain("Server Context");
		expect(out).not.toContain("Server ");
	});
});

// ===========================================================================
// gitLinkCheckpointCommand
// ===========================================================================

describe("gitLinkCheckpointCommand — guard + resolution errors", () => {
	it("errors when not a git repo (callTool never reached)", async () => {
		mockIsGitRepo.mockReturnValue(false);

		await gitLinkCheckpointCommand({ checkpoint: "42", json: true });

		expect(process.exitCode).toBe(1);
		const parsed = parseWire(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0])), wireObject({ "error": wireString }), "test JSON value");
		expect(parsed.error).toContain("Not a git repository");
		expect(mockCallTool).not.toHaveBeenCalled();
	});

	it("errors when commit SHA can't be determined (no --commit, getHeadSha null)", async () => {
		mockGetHeadSha.mockReturnValue(null);

		await gitLinkCheckpointCommand({ json: true });

		expect(process.exitCode).toBe(1);
		expect(stderr()).toContain("Could not determine commit SHA");
		expect(mockCallTool).not.toHaveBeenCalled();
	});

	it("rejects a non-numeric --checkpoint before any server call", async () => {
		await gitLinkCheckpointCommand({ checkpoint: "abc", json: true });

		expect(process.exitCode).toBe(1);
		expect(stderr()).toContain("Invalid checkpoint ID: abc");
		expect(mockCallTool).not.toHaveBeenCalled();
	});

	it("errors when no checkpoint given and server lookup yields none", async () => {
		// get_git_context resolves but with no latest_checkpoint.id.
		mockCallTool.mockResolvedValueOnce({ trailers: [] });

		await gitLinkCheckpointCommand({ json: true });

		expect(process.exitCode).toBe(1);
		expect(stderr()).toContain("No checkpoint ID specified");
		// push_checkpoint_to_git must not have been called.
		expect(mockCallTool).toHaveBeenCalledTimes(1);
		expect(mockCallTool).toHaveBeenCalledWith("get_git_context", {});
	});

	it("errors when no checkpoint given and the server lookup itself throws (inner catch)", async () => {
		// First call (get_git_context) rejects → swallowed → checkpointId stays undefined.
		mockCallTool.mockRejectedValueOnce(new Error("offline"));

		await gitLinkCheckpointCommand({ json: true });

		expect(process.exitCode).toBe(1);
		expect(stderr()).toContain("No checkpoint ID specified");
		expect(mockCallTool).toHaveBeenCalledTimes(1);
	});

	it("gitLinkCheckpointCommand stringifies a non-Error throw in the outer catch (String(err) branch)", async () => {
		// getCurrentBranch runs inside the outer try (after the repo/SHA guards);
		// a non-Error throw exercises the catch's `String(err)` else-branch.
		mockGetCurrentBranch.mockImplementation(() => {
			throw "branch boom"; // non-Error literal
		});

		await gitLinkCheckpointCommand({ checkpoint: "42" });

		expect(process.exitCode).toBe(1);
		expect(stderr()).toContain("Error: branch boom");
		// Threw before reaching the server call.
		expect(mockCallTool).not.toHaveBeenCalled();
	});
});

describe("gitLinkCheckpointCommand — server call wiring", () => {
	it("uses full HEAD SHA + branch_name and passes a numeric checkpoint_id", async () => {
		mockCallTool.mockResolvedValue({
			checkpoint_id: 42,
			trailers: ["Interlinked-Checkpoint: 42"],
			notes: {},
			notes_json: "{}",
		});

		await gitLinkCheckpointCommand({ checkpoint: "42", json: true });

		expect(mockCallTool).toHaveBeenCalledWith("push_checkpoint_to_git", {
			checkpoint_id: 42, // number, not "42"
			commit_sha: "abc123f456789abcdef0123456789012345678901",
			branch_name: "main",
		});
		const out = parseWire(lastJson(), wireObject({ "checkpoint_id": wireNumber, "applied": wireBoolean, "commit_sha": wireString }), "test JSON value");
		expect(out.checkpoint_id).toBe(42);
		expect(out.applied).toBe(false);
		expect(out.commit_sha).toBe("abc123f456789abcdef0123456789012345678901");
	});

	it("omits branch_name when detached HEAD (branch null → spread skipped)", async () => {
		mockGetCurrentBranch.mockReturnValue(null);
		mockCallTool.mockResolvedValue({ checkpoint_id: 5, trailers: [] });

		await gitLinkCheckpointCommand({ checkpoint: "5", json: true });

		const pushArgs = mockCallTool.mock.calls.find(
			(call) => call[0] === "push_checkpoint_to_git",
		)?.[1];
		expect(pushArgs).not.toHaveProperty("branch_name");
		expect(pushArgs).toMatchObject({ checkpoint_id: 5 });
	});

	it("honors an explicit --commit over getHeadSha", async () => {
		mockCallTool.mockResolvedValue({ checkpoint_id: 5, trailers: [] });

		await gitLinkCheckpointCommand({ checkpoint: "5", commit: "feedface", json: true });

		const pushArgs = mockCallTool.mock.calls.find(
			(call) => call[0] === "push_checkpoint_to_git",
		)?.[1];
		expect(pushArgs).toMatchObject({ commit_sha: "feedface" });
	});

	it("fetches the latest checkpoint id from the server when none is supplied", async () => {
		mockCallTool
			.mockResolvedValueOnce({ latest_checkpoint: { id: 99, agent: "Lead" } })
			.mockResolvedValueOnce({ checkpoint_id: 99, trailers: [] });

		await gitLinkCheckpointCommand({ json: true });

		expect(mockCallTool).toHaveBeenNthCalledWith(1, "get_git_context", {});
		expect(mockCallTool).toHaveBeenNthCalledWith(
			2,
			"push_checkpoint_to_git",
			expect.objectContaining({ checkpoint_id: 99 }),
		);
		expect(lastJson()).toHaveProperty(["checkpoint_id"], 99);
	});

	it("propagates a push_checkpoint_to_git rejection to the outer catch (error output)", async () => {
		mockCallTool.mockRejectedValueOnce(new Error("server 500"));

		await gitLinkCheckpointCommand({ checkpoint: "42", json: true });

		expect(process.exitCode).toBe(1);
		const parsed = parseWire(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0])), wireObject({ "error": wireString }), "test JSON value");
		expect(parsed.error).toBe("server 500");
	});

	it("tolerates a falsy push result (serverResult undefined → optional chains)", async () => {
		mockCallTool.mockResolvedValue(undefined);

		await gitLinkCheckpointCommand({ checkpoint: "42", json: true });

		const out = parseWire(lastJson(), wireObject({ "checkpoint_id": wireNumber, "trailers": wireAbsentOptional(wireOptional(wireArray(wireString))), "applied": wireBoolean }), "test JSON value");
		expect(out.checkpoint_id).toBe(42);
		expect(out.trailers).toBeUndefined();
		expect(out.applied).toBe(false);
		// --apply not set, and no trailers → execSync untouched.
		expect(mockExecSync).not.toHaveBeenCalled();
	});
});

describe("gitLinkCheckpointCommand — --apply (amend + notes via execSync)", () => {
	const pushResult = {
		checkpoint_id: 42,
		trailers: ["Interlinked-Checkpoint: 42", "Interlinked-Agent: Worker-Alpha"],
		notes: { checkpoint_id: 42 },
		notes_json: '{"checkpoint_id":42}',
	};

	it("amends the commit with new trailers and attaches notes to the post-amend SHA", async () => {
		// Existing HEAD message has NO interlinked trailers → both are "new".
		mockGetCommitMessage.mockReturnValue("Subject\n\nbody");
		// getHeadSha(short=false): first the pre-amend SHA, then the re-captured post-amend SHA.
		mockGetHeadSha
			.mockReturnValueOnce("preamendsha000000000000000000000000000000") // commitSha
			.mockReturnValueOnce("postamendsha11111111111111111111111111111"); // newHead after amend
		mockCallTool.mockResolvedValue(pushResult);

		await gitLinkCheckpointCommand({ checkpoint: "42", apply: true, json: true });

		// Two execSync calls: amend then notes add.
		expect(mockExecSync).toHaveBeenCalledTimes(2);

		// 1) amend: command + input message containing both trailers.
		const [amendCmd, amendOptions] = nonNull(mockExecSync.mock.calls[0]);
		const amendOpts = nonNull(amendOptions);
		expect(amendCmd).toBe("git commit --amend -F -");
		expect(amendOpts.input).toContain("Interlinked-Checkpoint: 42");
		expect(amendOpts.input).toContain("Interlinked-Agent: Worker-Alpha");

		// 2) notes target the RE-CAPTURED post-amend SHA, fed via stdin.
		const [notesCmd, notesOptions] = nonNull(mockExecSync.mock.calls[1]);
		const notesOpts = nonNull(notesOptions);
		expect(notesCmd).toBe("git notes add -f -F - postamendsha11111111111111111111111111111");
		expect(notesOpts.input).toBe('{"checkpoint_id":42}');

		const out = parseWire(lastJson(), wireObject({ "applied": wireBoolean, "commit_sha": wireString }), "test JSON value");
		expect(out.applied).toBe(true);
		expect(out.commit_sha).toBe("postamendsha11111111111111111111111111111");
	});

	it("filters out trailers already present, sanitizes values, and amends with only the new one", async () => {
		// HEAD already has Interlinked-Checkpoint → only Interlinked-Agent is new.
		// The Agent value carries shell metacharacters that must be stripped.
		mockGetCommitMessage.mockReturnValue("Subject\n\nInterlinked-Checkpoint: 42");
		mockCallTool.mockResolvedValue({
			checkpoint_id: 42,
			trailers: [
				"Interlinked-Checkpoint: 42", // already present → filtered out
				'Interlinked-Agent: Wor`ker$(rm)"\\!\n\t', // new → kept + sanitized
				"malformed-no-colon", // colonIdx <= 0 → filtered out
			],
			notes_json: "",
		});

		await gitLinkCheckpointCommand({ checkpoint: "42", apply: true, json: true });

		const amendOpts = nonNull(nonNull(mockExecSync.mock.calls[0])[1]);
		// New trailer present, dangerous chars removed.
		expect(amendOpts.input).toContain("Interlinked-Agent: Worker(rm)");
		expect(amendOpts.input).not.toMatch(/[`$\\!"]/);
		// Already-present trailer not re-added; malformed line skipped.
		expect(amendOpts.input).not.toContain("malformed-no-colon");
		// notes_json empty → no notes execSync call (only the amend happened).
		expect(mockExecSync).toHaveBeenCalledTimes(1);
		expect(lastJson()).toHaveProperty(["applied"], true);
	});

	it("when every trailer is already present, skips the amend but still applies (applied=true)", async () => {
		mockGetCommitMessage.mockReturnValue(
			"Subject\n\nInterlinked-Checkpoint: 42\nInterlinked-Agent: Worker-Alpha",
		);
		mockCallTool.mockResolvedValue({
			checkpoint_id: 42,
			trailers: ["Interlinked-Checkpoint: 42", "Interlinked-Agent: Worker-Alpha"],
			notes_json: "", // no notes either
		});

		await gitLinkCheckpointCommand({ checkpoint: "42", apply: true, json: true });

		// newTrailerLines empty → no amend; notes_json empty → no notes. Zero execSync.
		expect(mockExecSync).not.toHaveBeenCalled();
		expect(lastJson()).toHaveProperty(["applied"], true);
	});

	it("null current message coerces to '' (|| '') so amend still builds", async () => {
		mockGetCommitMessage.mockReturnValue(null); // currentMsg = ""
		mockCallTool.mockResolvedValue({
			checkpoint_id: 42,
			trailers: ["Interlinked-Checkpoint: 42"],
			notes_json: "",
		});

		await gitLinkCheckpointCommand({ checkpoint: "42", apply: true, json: true });

		expect(mockExecSync).toHaveBeenCalledTimes(1);
		const amendOpts = nonNull(nonNull(mockExecSync.mock.calls[0])[1]);
		expect(amendOpts.input).toContain("Interlinked-Checkpoint: 42");
	});

	it("post-amend getHeadSha null → commit_sha falls back to the original (newHead || commitSha)", async () => {
		mockGetCommitMessage.mockReturnValue("Subject");
		mockGetHeadSha
			.mockReturnValueOnce("origcommitsha0000000000000000000000000000") // commitSha
			.mockReturnValueOnce(null); // re-capture fails → fallback
		mockCallTool.mockResolvedValue({
			checkpoint_id: 42,
			trailers: ["Interlinked-Checkpoint: 42"],
			notes_json: '{"k":1}',
		});

		await gitLinkCheckpointCommand({ checkpoint: "42", apply: true, json: true });

		const out = parseWire(lastJson(), wireObject({ "commit_sha": wireString, "applied": wireBoolean }), "test JSON value");
		expect(out.commit_sha).toBe("origcommitsha0000000000000000000000000000");
		expect(out.applied).toBe(true);
		// notes still attached, targeting the fallback SHA.
		const notesCall = mockExecSync.mock.calls.find((call) =>
			String(call[0]).startsWith("git notes add"),
		);
		expect(notesCall?.[0]).toContain("origcommitsha0000000000000000000000000000");
	});

	it("amend execSync throwing flips applied=false (outer apply try/catch)", async () => {
		mockGetCommitMessage.mockReturnValue("Subject");
		mockExecSync.mockImplementation(() => {
			throw new Error("nothing to amend");
		});
		mockCallTool.mockResolvedValue({
			checkpoint_id: 42,
			trailers: ["Interlinked-Checkpoint: 42"],
			notes_json: '{"k":1}',
		});

		await gitLinkCheckpointCommand({ checkpoint: "42", apply: true, json: true });

		// Amend threw → caught → applied stays false; command still succeeds (exit 0).
		expect(process.exitCode).toBe(0);
		expect(lastJson()).toHaveProperty(["applied"], false);
	});

	it("notes execSync throwing is swallowed (inner catch) — applied stays true", async () => {
		mockGetCommitMessage.mockReturnValue("Subject");
		mockGetHeadSha
			.mockReturnValueOnce("preamendsha000000000000000000000000000000")
			.mockReturnValueOnce("postamendsha11111111111111111111111111111");
		// First call (amend) succeeds; second call (notes) throws.
		mockExecSync.mockReturnValueOnce("").mockImplementationOnce(() => {
			throw new Error("notes refused");
		});
		mockCallTool.mockResolvedValue({
			checkpoint_id: 42,
			trailers: ["Interlinked-Checkpoint: 42"],
			notes_json: '{"k":1}',
		});

		await gitLinkCheckpointCommand({ checkpoint: "42", apply: true, json: true });

		// Notes failure swallowed by the inner try/catch → applied true, exit 0.
		expect(process.exitCode).toBe(0);
		expect(lastJson()).toHaveProperty(["applied"], true);
		expect(mockExecSync).toHaveBeenCalledTimes(2);
	});

	it("--apply with no server trailers leaves applied=false (guard: serverResult.trailers falsy)", async () => {
		mockCallTool.mockResolvedValue({ checkpoint_id: 42, notes_json: '{"k":1}' });

		await gitLinkCheckpointCommand({ checkpoint: "42", apply: true, json: true });

		// `opts.apply && serverResult?.trailers` short-circuits → block skipped.
		expect(mockExecSync).not.toHaveBeenCalled();
		expect(lastJson()).toHaveProperty(["applied"], false);
	});
});

describe("gitLinkCheckpointCommand — normal (human) rendering", () => {
	it("renders applied state: trailers (colon-split + raw), notes attached, success + warning lines", async () => {
		mockGetCommitMessage.mockReturnValue("Subject"); // no existing trailers
		mockCallTool.mockResolvedValue({
			checkpoint_id: 42,
			trailers: ["Interlinked-Checkpoint: 42", "raw-no-colon"],
			notes_json: '{"k":1}',
		});

		await gitLinkCheckpointCommand({ checkpoint: "42", apply: true });

		const out = stdout();
		expect(out).toContain("Link Checkpoint");
		expect(out).toContain("#42");
		expect(out).toContain("Commit");
		expect(out).toContain("Trailers");
		expect(out).toContain("Interlinked-Checkpoint");
		expect(out).toContain("raw-no-colon"); // colonIdx <= 0 → raw line branch
		expect(out).toContain("(JSON attached)");
		expect(out).toContain("Trailers and notes applied to HEAD");
		expect(out).toContain("HEAD was amended");
	});

	it("renders the 'failed to apply' branch when --apply set but applied stayed false", async () => {
		mockGetCommitMessage.mockReturnValue("Subject");
		mockExecSync.mockImplementation(() => {
			throw new Error("amend failed");
		});
		mockCallTool.mockResolvedValue({
			checkpoint_id: 42,
			trailers: ["Interlinked-Checkpoint: 42"],
		});

		await gitLinkCheckpointCommand({ checkpoint: "42", apply: true });

		expect(stdout()).toContain("Failed to apply trailers");
	});

	it("renders the default hint branch when --apply is not set", async () => {
		mockCallTool.mockResolvedValue({ checkpoint_id: 42, trailers: [] });

		await gitLinkCheckpointCommand({ checkpoint: "42" });

		const out = stdout();
		expect(out).toContain("Use --apply to add trailers and notes to HEAD");
		expect(out).toContain("--apply amends HEAD");
		// Empty trailers array → no Trailers section; no notes_json → no Notes line.
		expect(out).not.toContain("(JSON attached)");
	});

	it("renders the full HEAD SHA as the Commit value in normal mode", async () => {
		mockCallTool.mockResolvedValue({ checkpoint_id: 7, trailers: [] });

		await gitLinkCheckpointCommand({ checkpoint: "7" });

		// commit_sha is the full SHA from getHeadSha (the || 'unknown' fallback
		// is structurally exercised by the operator but commit_sha is always set).
		expect(stdout()).toContain("abc123f456789abcdef0123456789012345678901");
	});
});
