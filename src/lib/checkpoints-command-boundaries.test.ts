import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execSync: vi.fn(), execFileSync: vi.fn() }));
import { compareCheckpoints, createCheckpoint, listCheckpoints, rewindToCheckpoint, type Checkpoint } from "./checkpoints.js";

const roots: string[] = [];
const sha1 = "a".repeat(40);
const sha256 = "b".repeat(64);

function fixture(baseCommit: string): string {
	const root = mkdtempSync(join(tmpdir(), "checkpoint-boundaries-"));
	roots.push(root);
	mkdirSync(join(root, ".interlinked"));
	const checkpoint: Checkpoint = {
		id: "stored", session_id: "session", agent: "agent", message: "Snapshot",
		timestamp: "2026-09-08T00:00:00Z", base_commit: baseCommit, trigger: "manual",
		files_changed: ["app.ts"], restorable: true,
		stash_ref: "e".repeat(40),
	};
	writeFileSync(join(root, ".interlinked", "checkpoints.json"), JSON.stringify([
		checkpoint, { ...checkpoint, id: "other", base_commit: sha1 },
	]));
	return root;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("INTERLINKED_DATA_DIR", "");
	vi.mocked(execSync).mockImplementation((command) => {
		if (String(command).includes("rev-parse HEAD")) return sha1;
		return "";
	});
	vi.mocked(execFileSync).mockImplementation((_file, args) => {
		if (args?.[0] === "diff" && args[1] === "--name-only") return "app.ts\0";
		if (args?.[0] === "rev-list") return `${"e".repeat(40)} ${sha1} ${"f".repeat(40)}`;
		if (args?.[0] === "rev-parse" && args[3] === `${"e".repeat(40)}^1`) return sha1;
		if (args?.[0] === "stash" && args[1] === "list") {
			const push = vi.mocked(execFileSync).mock.calls.find((call) => call[1]?.[0] === "stash" && call[1]?.[1] === "push");
			return `${"e".repeat(40)}:${push?.[1]?.[4]}`;
		}
		return "";
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("checkpoint input-bearing Git boundaries", () => {
	it.each(["invalid-path", "missing-index"])("preflights %s before forced mutation", (failure) => {
		const root = fixture(sha1);
		vi.mocked(execSync).mockImplementation((command) => String(command).includes("status --porcelain") ? " M app.ts" : sha1);
		vi.mocked(execFileSync).mockImplementation((_file, args) => {
			if (args?.[0] === "rev-list") return `${"e".repeat(40)} ${sha1} ${"f".repeat(40)}`;
			if (args?.[0] === "ls-tree" && args[4] === "e".repeat(40) && failure === "invalid-path") return "../escape\0";
			if (args?.[0] === "ls-tree" && args[4] === "f".repeat(40) && failure === "missing-index") throw new Error("missing index tree");
			return "";
		});

		expect(() => rewindToCheckpoint("stored", { cwd: root, force: true })).toThrow("Checkpoint snapshot unavailable");
		expect(vi.mocked(execFileSync).mock.calls.some((call) => ["restore", "clean", "update-ref"].includes(String(call[1]?.[0])))).toBe(false);
	});

	it("pins a captured object before a worktree restoration failure", () => {
		const root = fixture(sha1);
		let message = "";
		vi.mocked(execSync).mockImplementation((command) => String(command).includes("diff --name-only") ? "app.ts" : sha1);
		vi.mocked(execFileSync).mockImplementation((_file, args) => {
			if (args?.[0] === "diff" && args[1] === "--name-only") return "app.ts\0";
			if (args?.[0] === "stash" && args[1] === "push") message = String(args[4]);
			if (args?.[0] === "stash" && args[1] === "list") return `${"e".repeat(40)}:${message}`;
			if (args?.[0] === "rev-list") return `${"e".repeat(40)} ${sha1} ${"f".repeat(40)}`;
			if (args?.[0] === "restore") throw new Error("worktree restore failed");
			return "";
		});

		expect(() => createCheckpoint({ cwd: root, sessionId: "session", agent: "agent", message: "Snapshot", trigger: "manual" })).toThrow("worktree restore failed");
		const calls = vi.mocked(execFileSync).mock.calls;
		const pin = calls.findIndex((call) => call[1]?.[0] === "update-ref");
		const restore = calls.findIndex((call) => call[1]?.[0] === "restore");
		expect(pin).toBeGreaterThanOrEqual(0);
		expect(restore).toBeGreaterThan(pin);
		expect(calls[pin]?.[1]).toEqual(["update-ref", expect.stringMatching(/^refs\/interlinked\/checkpoints\/[a-f0-9]{12}$/), "e".repeat(40)]);
	});

	it.each(["diff --name-only", "ls-files"])("propagates %s failure before writing checkpoint history", (probe) => {
		const root = fixture(sha1);
		const metadataPath = join(root, ".interlinked", "checkpoints.json");
		const before = readFileSync(metadataPath, "utf8");
		vi.mocked(execSync).mockImplementation((command) => {
			if (String(command).includes("rev-parse HEAD")) return sha1;
			if (String(command).includes("diff --name-only")) return "app.ts";
			return "";
		});
		vi.mocked(execFileSync).mockImplementation((_file, args) => {
			if ((probe === "diff --name-only" && args?.[0] === "diff") || (probe === "ls-files" && args?.[0] === "ls-files")) throw new Error("Git capture probe failed");
			return args?.[0] === "diff" ? "app.ts\0" : "";
		});

		expect(() => createCheckpoint({ cwd: root, sessionId: "session", agent: "agent", message: "Snapshot", trigger: "manual" })).toThrow("Git capture probe failed");
		expect(readFileSync(metadataPath, "utf8")).toBe(before);
		expect(vi.mocked(execFileSync).mock.calls.some((call) => ["stash", "update-ref", "restore"].includes(String(call[1]?.[0])))).toBe(false);
	});

	it.each(["", "HEAD", "main", "--help", "abc123", "$(literal)", `${sha1};literal`])("refuses stored revision %j before Git execution", (revision) => {
		const root = fixture(revision);
		expect(listCheckpoints({ cwd: root })).toHaveLength(2);
		expect(() => rewindToCheckpoint("stored", { cwd: root, force: true })).toThrow("Invalid checkpoint base commit");
		expect(() => compareCheckpoints("stored", "other", root)).toThrow("Invalid checkpoint base commit");
		expect(execSync).not.toHaveBeenCalled();
		expect(execFileSync).not.toHaveBeenCalled();
	});

	it.each([sha1, sha256])("uses argument arrays for a supported object ID %s", (revision) => {
		const root = fixture(revision);
		vi.mocked(execSync).mockImplementation((command) => String(command).includes("rev-parse HEAD") ? "c".repeat(40) : "");
		vi.mocked(execFileSync).mockImplementation((_file, args) => args?.[0] === "rev-list" ? `${"e".repeat(40)} ${revision} ${"f".repeat(40)}` : "");
		rewindToCheckpoint("stored", { cwd: root });
		compareCheckpoints("stored", "other", root);
		expect(execFileSync).toHaveBeenCalledWith("git", ["update-ref", "--no-deref", "HEAD", revision, "c".repeat(40)], expect.objectContaining({ cwd: root }));
		expect(execFileSync).toHaveBeenCalledWith("git", ["diff", "--stat", `${revision}..${sha1}`, "--"], expect.objectContaining({ cwd: root }));
	});

	it("verifies the target is a commit before force can discard a dirty tree", () => {
		const root = fixture(sha1);
		vi.mocked(execSync).mockImplementation((command) => String(command).includes("status --porcelain") ? " M app.ts" : "");
		vi.mocked(execFileSync).mockImplementation((_file, args) => {
			if (args?.[0] === "rev-parse") throw new Error("missing commit object");
			return "";
		});

		expect(() => rewindToCheckpoint("stored", { cwd: root, force: true })).toThrow("missing commit object");
		expect(execFileSync).toHaveBeenCalledWith("git", ["rev-parse", "--verify", "--end-of-options", `${sha1}^{commit}`], expect.objectContaining({ cwd: root }));
		expect(vi.mocked(execSync).mock.calls.some(([command]) => /checkout|clean/.test(String(command)))).toBe(false);
	});

	it("passes agent and session text in one literal stash-message argument", () => {
		const root = fixture(sha1);
		const agent = "agent $(literal) ; text";
		const session = 'session "quoted" data';
		vi.mocked(execSync).mockImplementation((command) => {
			if (String(command).includes("rev-parse HEAD")) return sha1;
			if (String(command).includes("diff --name-only")) return "app.ts";
			return "";
		});
		const created = createCheckpoint({ cwd: root, sessionId: session, agent, message: "Snapshot", trigger: "manual" });
		const stashMessage = `interlinked:checkpoint:${created.id}:${JSON.stringify({ id: created.id, session_id: session, agent, trigger: "manual" })}`;
		expect(execFileSync).toHaveBeenCalledWith("git", ["stash", "push", "--include-untracked", "-m", stashMessage, "--", ".", ":(literal,exclude).interlinked"], expect.objectContaining({ cwd: root }));
		expect(vi.mocked(execSync).mock.calls.some(([command]) => String(command).includes(agent))).toBe(false);
	});
});
