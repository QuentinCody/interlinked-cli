import { describe, expect, it } from "vitest";
import { buildDigest, classifyCall, digestHash, digestSubject, renderDigest, verifierScope, type WindowCall } from "./window.js";

const call = (seq: number, overrides: Partial<WindowCall> = {}): WindowCall => ({
	seq,
	ts: `2026-11-05T00:00:${String(seq).padStart(2, "0")}Z`,
	tool: "Bash",
	class: "shell",
	files: [],
	command: `cmd ${seq}`,
	outcome: "pass",
	scope: "n/a",
	...overrides,
});

describe("classifyCall — positive (the class a rule can name)", () => {
	it("P1: test runners, typecheck, build, lint, git are named by the command", () => {
		expect(classifyCall("Bash", "npx vitest run src/a.test.ts", [])).toBe("test");
		expect(classifyCall("Bash", "npm run typecheck", [])).toBe("typecheck");
		expect(classifyCall("Bash", "npm run build", [])).toBe("build");
		expect(classifyCall("Bash", "npx biome check src", [])).toBe("lint");
		expect(classifyCall("Bash", "git commit -m x", [])).toBe("git");
	});
	it("P2: edit, read and search tools are named by the tool", () => {
		expect(classifyCall("Edit", null, ["a.ts"])).toBe("edit");
		expect(classifyCall("Read", null, ["a.ts"])).toBe("read");
		expect(classifyCall("Grep", null, [])).toBe("search");
	});
	it("N1: a shell command naming a runner inside a string is still shell", () => {
		expect(classifyCall("Bash", 'echo "run vitest later"', [])).toBe("shell");
	});
});

describe("verifierScope", () => {
	it("P3: a path with an extension is file, a bare directory is dir, nothing is suite", () => {
		expect(verifierScope("npx vitest run src/a.test.ts")).toBe("file");
		expect(verifierScope("npx vitest run src/harness/packets")).toBe("dir");
		expect(verifierScope("npx vitest run")).toBe("suite");
		expect(verifierScope("npm run typecheck")).toBe("suite");
	});
	it("N2: a non-verifier has no scope", () => expect(verifierScope("ls -la")).toBe("n/a"));
});

describe("buildDigest — order and truncation", () => {
	it("P4: calls are ordered by seq whatever the input order; nothing is folded into counts", () => {
		const d = buildDigest({ kind: "turn", session_id: "s", calls: [call(3), call(1), call(2)], prompts: ["do x"], final_message: "done", fired_packets: [] });
		expect(d.calls.map((c) => c.seq)).toEqual([1, 2, 3]);
		expect([d.from_seq, d.to_seq, d.truncated]).toEqual([1, 3, false]);
	});
	it("P5: over the call cap the OLDEST calls are dropped and the digest says so", () => {
		const d = buildDigest({ kind: "turn", session_id: "s", calls: Array.from({ length: 5 }, (_, i) => call(i + 1)), prompts: [], final_message: null, fired_packets: [] }, { maxCalls: 3 });
		expect(d.calls.map((c) => c.seq)).toEqual([3, 4, 5]);
		expect(d.truncated).toBe(true);
	});
	it("P6: 'tests passed before the edit' and 'tests passed after the edit' are different digests", () => {
		const test = (seq: number) => call(seq, { class: "test", command: "npx vitest run src/a.test.ts", scope: "file" });
		const edit = (seq: number) => call(seq, { tool: "Edit", class: "edit", command: null, files: ["src/a.ts"] });
		const before = buildDigest({ kind: "turn", session_id: "s", calls: [test(1), edit(2)], prompts: [], final_message: null, fired_packets: [] });
		const after = buildDigest({ kind: "turn", session_id: "s", calls: [edit(1), test(2)], prompts: [], final_message: null, fired_packets: [] });
		expect(digestHash(before)).not.toBe(digestHash(after));
		expect(renderDigest(before)).not.toEqual(renderDigest(after));
	});
});

describe("renderDigest — bounded, ordered, outcomes kept", () => {
	it("P7: every call keeps seq, class, outcome and scope in order", () => {
		const d = buildDigest({ kind: "turn", session_id: "s", calls: [call(1, { class: "test", outcome: "fail", scope: "file" }), call(2, { tool: "Edit", class: "edit", command: null, files: ["src/a.ts"] })], prompts: ["fix it"], final_message: "fixed", fired_packets: ["x"] });
		const r = renderDigest(d) as { calls: string[]; prompts: string[]; final_message: string | null };
		expect(r.calls).toEqual(["1 test Bash fail file: cmd 1", "2 edit Edit pass: src/a.ts"]);
		expect(r.prompts).toEqual(["fix it"]);
		expect(r.final_message).toBe("fixed");
	});
	it("P8: a long window folds the OLDEST calls into an ordered class/outcome summary and never drops a recent call", () => {
		const calls = Array.from({ length: 200 }, (_, i) => call(i + 1, { command: `x`.repeat(80) }));
		const r = renderDigest(buildDigest({ kind: "session", session_id: "s", calls, prompts: [], final_message: null, fired_packets: [] }), 2_000) as { calls: string[]; folded: string | null };
		expect(JSON.stringify(r).length).toBeLessThanOrEqual(2_200);
		expect(r.folded).toMatch(/^\d+ earlier calls in order:/);
		expect(r.calls[r.calls.length - 1]).toMatch(/^200 /);
	});
	it("P10: the budget binds the WHOLE state: ten long prompts plus calls still fit, newest prompts kept", () => {
		const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i} ${"p".repeat(500)}`);
		const d = buildDigest({ kind: "turn", session_id: "s", calls: Array.from({ length: 50 }, (_, i) => call(i + 1, { command: "x".repeat(100) })), prompts, final_message: "m".repeat(2000), fired_packets: [] });
		const r = renderDigest(d) as { prompts: string[] };
		expect(JSON.stringify(r).length).toBeLessThanOrEqual(4_096);
		expect(r.prompts[r.prompts.length - 1]).toMatch(/^prompt 9/);
	});
	it("P11: a credential inside a command, a prompt or a message never reaches the rendering", () => {
		const secret = `sk-ant-api03-${"a".repeat(40)}`;
		const d = buildDigest({ kind: "turn", session_id: "s", calls: [call(1, { command: `curl -H "Authorization: Bearer ${secret}" x` })], prompts: [`use ${secret}`], final_message: `done with ${secret}`, fired_packets: [] });
		expect(JSON.stringify(renderDigest(d))).not.toContain("a".repeat(40));
	});
	it("N3: an unknown outcome is rendered as unknown, never as pass", () => {
		const r = renderDigest(buildDigest({ kind: "turn", session_id: "s", calls: [call(1, { outcome: "unknown" })], prompts: [], final_message: null, fired_packets: [] })) as { calls: string[] };
		expect(r.calls[0]).toContain(" unknown");
	});
});

describe("digestSubject", () => {
	it("P9: joins commands and files in order for the deciders and triggers", () => {
		const d = buildDigest({ kind: "turn", session_id: "s", calls: [call(1, { command: "git commit -m x" }), call(2, { tool: "Edit", command: null, files: ["a.ts"] })], prompts: [], final_message: null, fired_packets: [] });
		expect(digestSubject(d)).toBe("git commit -m x\na.ts");
	});
});
