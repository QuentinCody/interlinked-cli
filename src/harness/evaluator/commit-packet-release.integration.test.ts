// A released instruction across HEAD / index / worktree (seventh review, audit C2). In a real git fixture the
// real `packets release` command moves the words into the packet file and leaves a pointer; then each commit
// form is judged by the real commit gate. The commit must never carry a pointer whose words are nowhere, and its
// verdict must follow what the COMMIT carries, never unstaged worktree bytes.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { packetsReleaseCommand } from "../../commands/packets-release.js";
import { sampleFile, warnPacket } from "../packets/fixtures.js";
import type { HarnessEvent } from "../types.js";
import { checkCommitBaselineGate } from "./commit-baseline-gate.js";

const WORDS = "Never full-read `collection.jsonl`, `activity.jsonl`, or `timeline.jsonl` (hundreds of MB); use `interlinked query` or `tail -n`.";
const SOURCE = `# rules\n\n- ${WORDS}\n- Keep cwd at the repo root.\n`;
const PACKETS = ".interlinked/instruction-packets.json";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let root: string;
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
const commitEvent = (command: string): HarnessEvent => ({ hook_event: "PreToolUse", session_id: "s1", agent_source: "claude", tool_name: "Bash", tool_input: { command }, timestamp: "2026-11-06T00:00:00.000Z", cwd: root });
const verdict = (command: string) => checkCommitBaselineGate(commitEvent(command));

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "commit-packet-release-"));
	git("init", "-q");
	git("config", "user.email", "t@t.test");
	git("config", "user.name", "t");
	git("config", "commit.gpgsign", "false");
	mkdirSync(join(root, ".interlinked"));
	writeFileSync(join(root, "CLAUDE.md"), SOURCE);
	const live = warnPacket({ source: { file: "CLAUDE.md", span: null, quote: WORDS } });
	writeFileSync(join(root, PACKETS), `${JSON.stringify(sampleFile([live], { sources: { "CLAUDE.md": sha(SOURCE) } }), null, 2)}\n`);
	git("add", "-f", "CLAUDE.md", PACKETS);
	git("commit", "-q", "-m", "seed");
	vi.spyOn(console, "log").mockImplementation(() => {});
	expect(packetsReleaseCommand({ file: "CLAUDE.md", cwd: root })).toBe(0);
	expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).not.toContain(WORDS);
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

describe("a release commits as a pair", () => {
	it("P1: staging only the pointer-bearing instruction file is blocked — the commit would hold neither the words nor a release", () => {
		git("add", "CLAUDE.md");
		const d = verdict("git commit -m 'drop the words'");
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("pointer-without-release:bounded-log-read");
	});
	it("P2: `git commit CLAUDE.md` (pathspec commit of the instruction file alone) is blocked the same way", () => {
		expect(verdict("git commit CLAUDE.md -m x")?.reason).toContain("pointer-without-release:bounded-log-read");
	});
	it("P3: staging only the packet file with its release is blocked — the committed instruction file does not hold the pointer", () => {
		git("add", "-f", PACKETS);
		expect(verdict("git commit -m half")?.reason).toContain("release-added:bounded-log-read");
	});
	it("N1: both files staged together pass; `git commit -a` passes", () => {
		git("add", "-f", "CLAUDE.md", PACKETS);
		expect(verdict("git commit -m release")).toBeNull();
		expect(verdict("git commit -a -m release")).toBeNull();
	});
	it("N2: the verdict follows what the commit carries — both staged, worktree CLAUDE.md later reverted to the words: still passes", () => {
		git("add", "-f", "CLAUDE.md", PACKETS);
		writeFileSync(join(root, "CLAUDE.md"), SOURCE); // unstaged: not part of this commit
		expect(verdict("git commit -m release")).toBeNull();
	});
	it("P4 (break R4 #10): renaming the pointer-bearing file and clearing the release is blocked — the new name is scanned too", () => {
		git("add", "-f", "CLAUDE.md", PACKETS);
		git("commit", "-q", "-m", "release");
		git("mv", "CLAUDE.md", "AGENTS.md");
		const file = JSON.parse(readFileSync(join(root, PACKETS), "utf8")) as { packets: { release: unknown; calibration: { status: string } }[] };
		const shadow = sampleFile([warnPacket({ source: { file: "CLAUDE.md", span: null, quote: WORDS } })]).packets[0]?.calibration;
		file.packets[0] = { ...file.packets[0]!, release: null, calibration: { ...shadow!, status: "shadow", tau: null, bound_to: null } as never };
		writeFileSync(join(root, PACKETS), `${JSON.stringify(file, null, 2)}\n`);
		git("add", "-f", PACKETS);
		expect(verdict("git commit -m rename")?.reason).toContain("pointer-without-release:bounded-log-read");
	});
	it("P5 (R6 W6): a renamed pointer file that sorts after 500 other changed paths is not skipped silently", () => {
		git("add", "-f", "CLAUDE.md", PACKETS);
		git("commit", "-q", "-m", "release");
		for (let i = 0; i < 501; i++) writeFileSync(join(root, `a${String(i).padStart(4, "0")}.txt`), "x");
		git("add", ".");
		git("mv", "CLAUDE.md", "zz.md");
		const file = JSON.parse(readFileSync(join(root, PACKETS), "utf8")) as { packets: { release: unknown; calibration: { status: string } }[] };
		const shadow = sampleFile([warnPacket({ source: { file: "CLAUDE.md", span: null, quote: WORDS } })]).packets[0]?.calibration;
		file.packets[0] = { ...file.packets[0]!, release: null, calibration: { ...shadow!, status: "shadow", tau: null, bound_to: null } as never };
		writeFileSync(join(root, PACKETS), `${JSON.stringify(file, null, 2)}\n`);
		git("add", "-f", PACKETS);
		const d = verdict("git commit -m rename");
		expect(d?.decision).toBe("block");
		expect(d?.reason).toMatch(/pointer-(without-release:bounded-log-read|scan-truncated)/);
	});
	it("P6 (R6 W6): with no packet file in HEAD or the index, a staged pointer is still a pointer without a release", () => {
		const pointerText = readFileSync(join(root, "CLAUDE.md"), "utf8");
		rmSync(root, { recursive: true, force: true });
		root = mkdtempSync(join(tmpdir(), "commit-packet-release-bare-"));
		git("init", "-q");
		writeFileSync(join(root, "CLAUDE.md"), pointerText);
		git("add", "CLAUDE.md");
		expect(verdict("git commit -m pointer")?.reason).toContain("pointer-without-release:bounded-log-read");
	});
	it("N3: an unrelated commit with the release left unstaged is not blocked (HEAD has no pointer, nothing changes)", () => {
		writeFileSync(join(root, "notes.txt"), "x");
		git("add", "notes.txt");
		expect(verdict("git commit -m notes")).toBeNull();
	});
});
