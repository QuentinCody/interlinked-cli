// ===========================================
// Mutation-kill companion for src/commands/git.ts
// ===========================================
// The existing suites (git.integration.test.ts, __tests__/git-commands.test.ts)
// assert BEHAVIOR through toContain/toMatchObject checks that, for several
// code regions, are satisfied by a substring collision (e.g. local trailer
// key "Interlinked-Checkpoint" also contains "Checkpoint", so a check that
// merely asserts presence of "Checkpoint" doesn't prove the SERVER section's
// own "Checkpoint" label survived) or by a mock that ignores the argument a
// mutant would corrupt (mockReturnValueOnce chains that don't inspect the
// `short` param). This file closes exactly those gaps: real-newline-join
// checks, blank-line-adjacency checks, exact-line/exact-string assertions
// via the real kvLine() helper, and argument-aware mock assertions.
//
// Provenance: scratch/fleet-r3/receipts/src_commands_git.ts.jsonl (fleet W8).
// Verified against the live 64-survivor manifest (generation 1476) via a
// safe shadow-mutation harness (scratch/fleet-r3/git-shadow-verify.mts +
// scratch/fleet-r3/git-shadow-mocks/*.mts) that never touches real git state
// or network — every `it()` below is annotated with the exact mutantId(s)
// it was empirically confirmed to kill.

process.env.NO_COLOR = "1";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { parseWire, wireString } from "../lib/value-validation.js";
import { kvLine, stripAnsi } from "../lib/formatter.js";

// --- mock surfaces (same pattern as git.integration.test.ts) --------------

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
		parseInterlinkedTrailers: actual.parseInterlinkedTrailers,
		isGitRepo: (cwd: string) => mockIsGitRepo(cwd),
		getCurrentBranch: (cwd: string) => mockGetCurrentBranch(cwd),
		getHeadSha: (cwd: string, short?: boolean) => mockGetHeadSha(cwd, short),
		getCommitMessage: (ref: string, cwd: string) => mockGetCommitMessage(ref, cwd),
	};
});

const mockReadAttributionTrailer = vi.fn();
vi.mock("../lib/attribution.js", () => ({
	readAttributionTrailer: (ref?: string, cwd?: string) => mockReadAttributionTrailer(ref, cwd),
}));

const mockCallTool = vi.fn();
vi.mock("../lib/api-client.js", () => ({
	getClient: () => ({ callTool: mockCallTool }),
}));

import { gitContextCommand, gitLinkCheckpointCommand } from "./git.js";

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let previousExitCode: number | string | undefined;

beforeEach(() => {
	vi.clearAllMocks();
	previousExitCode = process.exitCode;
	process.exitCode = 0;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

	mockIsGitRepo.mockReturnValue(true);
	mockGetCurrentBranch.mockReturnValue("main");
	mockGetHeadSha.mockImplementation((_cwd, short) =>
		short === true ? "abc123f" : "abc123f456789abcdef0123456789012345678901",
	);
	mockGetCommitMessage.mockReturnValue("Subject line\n\nBody text");
	mockReadAttributionTrailer.mockReturnValue(null);
	mockExecSync.mockReturnValue("");
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	process.exitCode = previousExitCode;
});

// stripAnsi normalizes regardless of whether NO_COLOR actually suppressed
// color codes for this module graph's evaluation order -- assertions below
// must never depend on that ordering to pass.
function stdout(): string {
	return stripAnsi(logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n"));
}
function lastJson(): unknown {
	return JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
}
function nonEmptyLines(text: string): string[] {
	return text.split("\n").filter((l) => l.trim() !== "");
}

// ===========================================================================
// gitContextCommand — formatServerContextLines + its own normal-mode render
// ===========================================================================

describe("gitContextCommand normal mode — formatServerContextLines mutation-kill", () => {
	// test-contract: public-api — when the server is unreachable, the normal-
	// mode render shows ONLY local git context (branch/HEAD); nothing else is
	// appended, and every section boundary is a real newline, not a glued
	// concatenation.
	it("server unreachable -- renders only local context, real newline join", async () => {
		// kills: 0b8d1fcf52b87032 (join("\n")->join("")), 9363923c9e52fa21
		// (formatServerContextLines `if (!server) return [];` -> non-empty array),
		// f19f7676c151852d (gitContextCommand.normal's own leading `[]` init)
		mockGetCommitMessage.mockReturnValue("Subject only, no trailers");
		mockCallTool.mockResolvedValue(null);

		await gitContextCommand({});

		const out = stdout();
		const lines = nonEmptyLines(out);
		expect(lines).toHaveLength(4);
		expect(lines[0]).toBe("Git Context");
		expect(lines[2]).toContain("Branch");
		expect(lines[3]).toContain("HEAD");
		expect(out).toContain("\n  Branch");
	});

	// test-contract: public-api — a server-side error renders exactly the
	// "Server" line, blank-line-separated from local context, and stops
	// before Checkpoint/Agent/Trailers are ever considered.
	it("server.error -- blank-line-separated Server line, returns before Checkpoint/Agent", async () => {
		// kills: 34d4bc89ae8d46a8 (leading [""] -> []), a2c45c4d668b9003 (the ""
		// inside it -> "Stryker was here!")
		mockGetCommitMessage.mockReturnValue("Subject only, no trailers");
		mockCallTool.mockRejectedValue(new Error("boom-unreachable"));

		await gitContextCommand({});

		const out = stdout();
		expect(out).toContain("\n\n  Server");
		expect(out).not.toContain("Server Context");
		expect(out).not.toContain("Checkpoint");
	});

	// test-contract: public-api — a falsy checkpoint is never rendered, and a
	// truthy agent value IS rendered under its own "Agent" label.
	it("checkpoint falsy / agent truthy / trailers undefined -- Checkpoint suppressed, Agent shown, no crash", async () => {
		// kills: f19f36d1917e4b3c (checkpoint cond -> true), f4fe110efb37d14e
		// (agent cond -> false), c0696da8e19ad947 (Agent push block emptied),
		// 34339a9629ea0cd1 ("Agent" label -> ""), a10797a9a5d1b278 (trailers cond
		// -> true), d50d45939a4aabc2 (&& -> ||) — the last two crash
		// formatTrailerLines(undefined) once the guard is defeated.
		mockGetCommitMessage.mockReturnValue("Subject only, no trailers");
		mockCallTool.mockResolvedValue({
			commit_sha: "deadbee",
			bridge_events: [{ id: 1, event_type: "x", checkpoint_id: 0, agent_name: "AGENT-TOKEN-XYZ" }],
		});

		await gitContextCommand({ commit: "deadbee" });

		expect(process.exitCode).toBe(0);
		const out = stdout();
		expect(out).not.toContain("Checkpoint");
		expect(out).toContain("AGENT-TOKEN-XYZ");
		expect(out).toContain("\n  Agent");
	});

	// test-contract: public-api — a truthy checkpoint IS rendered under its
	// own "Checkpoint" label, and a falsy agent is never rendered.
	it("checkpoint truthy / agent falsy / trailers=[] -- Checkpoint shown, Agent suppressed", async () => {
		// kills: d163ad722c09d16d ("Checkpoint" label -> ""), 34140fd6aef5a46d
		// (agent cond -> true)
		mockGetCommitMessage.mockReturnValue("Subject only, no trailers");
		mockCallTool.mockResolvedValue({
			latest_checkpoint: { id: 501, agent: "", summary: "CP-TOKEN-XYZ" },
			trailers: [],
		});

		await gitContextCommand({});

		const out = stdout();
		expect(out).toContain("\n  Checkpoint");
		expect(out).not.toContain("Agent");
	});

	// test-contract: public-api — the Attribution line carries its own label,
	// and the Local Trailers section is blank-line-separated with every
	// trailer entry actually rendered (not just its header).
	it("local trailers + attribution -- real blank separator, every entry pushed", async () => {
		// kills: 0fe346b967c83ce4 ("Attribution" label -> ""), 01e2b8f3b8797d17
		// (blank "" before Local Trailers -> "Stryker was here!"), 26dacef86e627929
		// (the per-entry push loop body emptied)
		mockGetCurrentBranch.mockReturnValue("feature/x");
		mockGetHeadSha.mockReturnValue("cafef00");
		mockReadAttributionTrailer.mockReturnValue({
			agent_lines: 145,
			human_lines: 56,
			total_lines: 201,
			agent_percentage: 72,
			per_file: {},
		});
		mockGetCommitMessage.mockReturnValue("Subject\n\nInterlinked-Foo: unique-trailer-value");
		mockCallTool.mockResolvedValue({ trailers: [] });

		await gitContextCommand({});

		const out = stdout();
		expect(out).toContain("\n  Attribution");
		expect(out).toContain("\n\n  Local Trailers");
		expect(out).toContain("unique-trailer-value");
	});

	// test-contract: public-api — formatTrailerLines splits a real "Key: Value"
	// trailer into an exact key/value kvLine, leaves an unsplit trailer (no
	// colon, or colon at position 0) verbatim on its raw 4-space-indented
	// line, and independently trims whitespace on both the key and the value.
	it("formatTrailerLines: real-colon / no-colon / colon-at-0 / padded trailers each render exactly", async () => {
		// kills: e4bb3371488ff618 (":" search -> ""), 4b0272a607bf9813 /
		// a0d2822e652a5bcb (colonIdx>0 -> true/false), 352132feb71a3101 /
		// 049780f8377fa224 (colonIdx>0 -> >=0/<=0), 60236e52019e307d (key
		// .trim() dropped), bd2cc131c2fb1379 (key slice dropped),
		// 70b3fec8a64fd5e2 (value .trim() dropped), a2d923240330ea4e (value
		// slice dropped), e07d49681c92b245 (colonIdx+1 -> colonIdx-1),
		// 13cbc70b9dea1aca (leading [] init -> non-empty)
		mockGetCommitMessage.mockReturnValue("Subject only, no trailers");
		mockCallTool.mockResolvedValue({
			latest_checkpoint: { id: 9, agent: "", summary: "" },
			trailers: [
				"Foo-Real: real-value",
				"totally-no-colon-here",
				":colon-at-position-zero",
				"  MyKey  :  MyValue  ",
			],
		});

		await gitContextCommand({});

		const out = stdout();
		const lines = out.split("\n");
		expect(lines.some((l) => l.startsWith("    Foo-Real: real-value"))).toBe(false);
		expect(out).toContain("real-value");
		expect(lines).toContainEqual("    totally-no-colon-here");
		expect(lines).toContainEqual("    :colon-at-position-zero");
		expect(lines).toContainEqual(stripAnsi(kvLine("MyKey", "MyValue", 28)));
		expect(nonEmptyLines(out)).toHaveLength(10);
	});
});

// ===========================================================================
// gitLinkCheckpointCommand
// ===========================================================================

describe("gitLinkCheckpointCommand — mutation-kill", () => {
	// test-contract: boundary — a falsy push_checkpoint_to_git result must not
	// crash the --apply optional-chaining guard.
	it("--apply with a falsy push result does not crash on the optional-chained trailers guard", async () => {
		// kills: 6b0eb49f341adb26 (serverResult?.trailers -> serverResult.trailers)
		mockCallTool.mockResolvedValue(undefined);

		await gitLinkCheckpointCommand({ checkpoint: "42", apply: true, json: true });

		expect(process.exitCode).toBe(0);
		expect(lastJson()).toHaveProperty(["applied"], false);
		expect(mockExecSync).not.toHaveBeenCalled();
	});

	// test-contract: public-api — --apply amends with EXACTLY the genuinely
	// new trailers (already-present, colon-at-0, and untrimmed-key duplicates
	// are all filtered), using the documented execSync options, and the
	// re-capture getHeadSha call explicitly asks for the long SHA.
	it("--apply amends with a dedup-filtered trailer set; exact execSync options; re-capture asks for long SHA", async () => {
		// kills: 598e2a3e321cfc8b/ee6e2138f2b05efe ("utf-8" -> ""),
		// 5ac0ffff1ed72356/bb3fb25c29fbd80c (["pipe","pipe","pipe"] -> []),
		// 7322f589b4980148/3c8810dd6e40895e/3404c9b67c9dc42f/559d90715eb279b4/
		// 30f98fd77eadae5c/7bc9a1892a3245a3 (each of the 6 "pipe" strings -> ""),
		// d64e4874938a4ee9 (the re-capture getHeadSha(cwd, false) -> true),
		// 12f8d8e051e01bf2 (dedup filter colonIdx<=0 -> <0),
		// d4e9db3ce1dbc3fa (dedup filter key.trim() dropped)
		mockGetCommitMessage.mockReturnValue("Subject\n\nInterlinked-Checkpoint: 42");
		let headShaCallCount = 0;
		mockGetHeadSha.mockImplementation((_cwd: string, short?: boolean) => {
			if (short === true) return "abc123f";
			headShaCallCount++;
			return headShaCallCount === 1
				? "preamendsha000000000000000000000000000000"
				: "postamendsha11111111111111111111111111111";
		});
		mockCallTool.mockResolvedValue({
			checkpoint_id: 42,
			trailers: [
				"Interlinked-Checkpoint: 42", // already present -> filtered
				":no-key-value", // colonIdx===0 -> must be filtered (dedup guard)
				" Interlinked-Checkpoint : 42", // untrimmed-key duplicate -> must be filtered
				"Interlinked-Agent: Worker-Alpha", // genuinely new -> kept
			],
			notes_json: '{"k":1}',
		});

		await gitLinkCheckpointCommand({ checkpoint: "42", apply: true, json: true });

		expect(mockExecSync).toHaveBeenCalledTimes(2);
		const [amendCmd, amendOptions] = nonNull(mockExecSync.mock.calls[0]);
		const amendOpts = nonNull(amendOptions);
		expect(amendCmd).toBe("git commit --amend -F -");
		expect(amendOpts).toMatchObject({ encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
		expect(amendOpts.input).toBe(
			"Subject\n\nInterlinked-Checkpoint: 42\n\nInterlinked-Agent: Worker-Alpha",
		);

		const notesOpts = nonNull(nonNull(mockExecSync.mock.calls[1])[1]);
		expect(notesOpts).toMatchObject({ encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });

		for (const call of mockGetHeadSha.mock.calls) {
			if (call[1] !== true) expect(call[1]).toBe(false);
		}
		expect(lastJson()).toHaveProperty(["commit_sha"], "postamendsha11111111111111111111111111111");
	});

	// test-contract: public-api — --apply trims only TRAILING whitespace off
	// the existing commit message before appending trailers (trimEnd, not
	// trimStart).
	it("--apply trims only trailing whitespace off the existing commit message", async () => {
		// kills: 383587d3c7040c6b (currentMsg.trimEnd() -> trimStart())
		mockGetCommitMessage.mockReturnValue("  Subject with leading and trailing space  ");
		mockCallTool.mockResolvedValue({
			checkpoint_id: 42,
			trailers: ["Interlinked-Foo: bar-value"],
			notes_json: "",
		});

		await gitLinkCheckpointCommand({ checkpoint: "42", apply: true, json: true });

		const amendOpts = nonNull(nonNull(mockExecSync.mock.calls[0])[1]);
		expect(parseWire(amendOpts.input, wireString, "amend input").startsWith("  Subject")).toBe(true);
	});

	// test-contract: public-api — multiple new trailers are newline-joined,
	// not concatenated, before being appended to the commit message.
	it("--apply joins multiple new trailers with a real newline", async () => {
		// kills: ce4962e4fdcc1c3e (join("\n") -> join(""))
		mockGetCommitMessage.mockReturnValue("Subject with no trailers yet");
		mockCallTool.mockResolvedValue({
			checkpoint_id: 42,
			trailers: ["Interlinked-Checkpoint: 42", "Interlinked-Agent: Worker-Alpha"],
			notes_json: "",
		});

		await gitLinkCheckpointCommand({ checkpoint: "42", apply: true, json: true });

		const amendOpts = nonNull(nonNull(mockExecSync.mock.calls[0])[1]);
		expect(amendOpts.input).toContain("Interlinked-Checkpoint: 42\nInterlinked-Agent: Worker-Alpha");
	});

	// test-contract: public-api — the pre-amend commit message is always read
	// from "HEAD" (never any other ref), and a missing message falls back to
	// an empty string rather than leaking a placeholder into the amend.
	it("--apply reads the message at ref='HEAD'; a missing message falls back to ''", async () => {
		// kills: 1e03485730c5dd73 ("HEAD" -> ""), c306ec3f100e496b (the || ""
		// fallback -> "Stryker was here!")
		mockGetCommitMessage.mockReturnValue(null);
		mockCallTool.mockResolvedValue({
			checkpoint_id: 42,
			trailers: ["Interlinked-Foo: bar-value"],
			notes_json: "",
		});

		await gitLinkCheckpointCommand({ checkpoint: "42", apply: true, json: true });

		expect(mockGetCommitMessage).toHaveBeenCalledWith("HEAD", process.cwd());
		const amendOpts = nonNull(nonNull(mockExecSync.mock.calls[0])[1]);
		expect(parseWire(amendOpts.input, wireString, "amend input").startsWith("\n\nInterlinked-Foo: bar-value")).toBe(true);
	});

	// test-contract: public-api — without --apply, the render shows the
	// default hint branch only: no spurious Trailers/Notes sections when
	// trailers is empty, and every section boundary is a real newline.
	it("normal mode without --apply -- default hint branch, no spurious sections, real newline join", async () => {
		// kills: e200611460cbf841 ("Checkpoint" label -> ""), 74d551309a483475
		// (trailers cond -> true), 81218902de0a5428 (&& -> ||), 4a929a85e78a0fb6
		// (nested length>0 -> true), 8bae395a7c35826d (>0 -> >=0), 3cfc4d955d17d4d8
		// (join("\n") -> join("")), 8e21d50505d2f1cb (blank before hint text ->
		// "Stryker was here!"), 2709d696bd89bb73 (leading [] init -> non-empty)
		mockCallTool.mockResolvedValue({ checkpoint_id: 7, trailers: [] });

		await gitLinkCheckpointCommand({ checkpoint: "7" });

		const out = stdout();
		expect(out.startsWith("\nLink Checkpoint")).toBe(true);
		expect(out).toContain("\n  Checkpoint");
		expect(out).not.toContain("Trailers");
		expect(out).not.toContain("Notes");
		expect(out).toContain("\n\n  Use --apply to add trailers and notes to HEAD.");
	});

	// test-contract: public-api — after a successful --apply, the Trailers
	// section, the Notes section, and the applied-success block are each
	// blank-line-separated from whatever precedes them.
	it("normal mode --apply succeeded -- Trailers/Notes/applied-success blocks each have a real blank separator", async () => {
		// kills: bdc5e3a6ed27b3b7 (blank before "  Trailers" -> "Stryker was here!"),
		// a599b7254fe69e92 ("  Trailers" label -> ""), 456ee78399b2d9a7 ("Notes"
		// label -> ""), 9b162905772e9c24 (blank before Notes -> "Stryker was
		// here!"), 073c9d6c59503ce5 (blank before applied-success -> "Stryker
		// was here!")
		mockGetCommitMessage.mockReturnValue("Subject");
		mockCallTool.mockResolvedValue({
			checkpoint_id: 42,
			trailers: ["Interlinked-Checkpoint: 42", "raw-no-colon"],
			notes_json: '{"k":1}',
		});

		await gitLinkCheckpointCommand({ checkpoint: "42", apply: true });

		const out = stdout();
		expect(out).toContain("\n\n  Trailers");
		expect(out).toContain("\n\n  Notes");
		expect(out).toContain("\n\n  Trailers and notes applied to HEAD.");
	});

	// test-contract: public-api — when --apply is set but the amend throws,
	// the "Failed to apply trailers" branch is blank-line-separated from
	// whatever precedes it.
	it("normal mode --apply set but the amend throws -- Failed-to-apply branch has a real blank separator", async () => {
		// kills: 4bbb71b0969b9a27 (blank before "Failed to apply trailers" ->
		// "Stryker was here!")
		mockGetCommitMessage.mockReturnValue("Subject");
		mockExecSync.mockImplementation(() => {
			throw new Error("amend failed");
		});
		mockCallTool.mockResolvedValue({ checkpoint_id: 42, trailers: ["Interlinked-Checkpoint: 42"] });

		await gitLinkCheckpointCommand({ checkpoint: "42", apply: true });

		expect(stdout()).toContain("\n\n  Failed to apply trailers. See output above.");
	});
});
