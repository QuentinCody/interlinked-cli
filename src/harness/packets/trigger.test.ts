import { describe, expect, it } from "vitest";
import { samplePacket } from "./fixtures.js";
import { matchesTrigger, settleView, type TriggerView, viewsFromToolInput } from "./trigger.js";
import type { PacketApplies } from "./types.js";

const base = samplePacket().applies;
const bash = (command: string, phase: "pre" | "post" = "post"): TriggerView => ({ tool: "Bash", phase, path: null, command, hunks: [] });
const edit = (path: string, hunks: { old: string; new: string }[], tool = "Edit"): TriggerView => ({ tool, phase: "post", path, command: null, hunks });
const applies = (partial: Partial<PacketApplies>): PacketApplies => ({ ...base, ...partial });

describe("matchesTrigger — positive (must match)", () => {
	it("P1: tool, phase and command regex all hold", () => {
		expect(matchesTrigger(base, bash("cat .interlinked/collection.jsonl"))).toBe(true);
	});
	it("P2: a path trigger with a new-text regex matched in the SECOND hunk", () => {
		const a = applies({ tools: ["Edit"], command_regex: null, path_regex: "src/harness/evaluator/.*\\.ts$", new_text_regex: "appendFileSync" });
		expect(matchesTrigger(a, edit("/repo/src/harness/evaluator/x.ts", [{ old: "a", new: "b" }, { old: "", new: "appendFileSync(p)" }]))).toBe(true);
	});
	it("P3: a null regex is no constraint", () => {
		const a = applies({ command_regex: null });
		expect(matchesTrigger(a, bash("echo hi"))).toBe(true);
	});
	it("P4: backslashed Windows paths match a forward-slash path regex", () => {
		const a = applies({ tools: ["Write"], command_regex: null, path_regex: "src/a/b\\.ts$" });
		expect(matchesTrigger(a, edit("C:\\repo\\src\\a\\b.ts", [{ old: "", new: "x" }], "Write"))).toBe(true);
	});
});

describe("matchesTrigger — negative (must not match)", () => {
	it("N1: wrong tool", () => expect(matchesTrigger(base, { ...bash("cat collection.jsonl"), tool: "Read" })).toBe(false));
	it("N2: wrong phase", () => expect(matchesTrigger(base, bash("cat collection.jsonl", "pre"))).toBe(false));
	it("N3: command regex does not hold", () => expect(matchesTrigger(base, bash("ls"))).toBe(false));
	it("N4: command regex set but the view has no command", () => expect(matchesTrigger(base, edit("/x.ts", [], "Bash"))).toBe(false));
	it("N5: exclude_path_regex removes a test file", () => {
		const a = applies({ tools: ["Edit"], command_regex: null, path_regex: "src/", exclude_path_regex: "\\.test\\.ts$" });
		expect(matchesTrigger(a, edit("/repo/src/x.test.ts", [{ old: "", new: "y" }]))).toBe(false);
	});
	it("N6: path regex set but the view has no path", () => {
		const a = applies({ tools: ["Bash"], command_regex: null, path_regex: "src/" });
		expect(matchesTrigger(a, bash("ls"))).toBe(false);
	});
	it("N7: new_text_regex matches only OLD text", () => {
		const a = applies({ tools: ["Edit"], command_regex: null, new_text_regex: "secret" });
		expect(matchesTrigger(a, edit("/repo/x.ts", [{ old: "secret", new: "clean" }]))).toBe(false);
	});
});

describe("viewsFromToolInput", () => {
	it("P5: Bash yields one command view", () => {
		expect(viewsFromToolInput("Bash", "pre", { command: "ls" })).toEqual([{ tool: "Bash", phase: "pre", path: null, command: "ls", hunks: [] }]);
	});
	it("P6: Write yields one hunk from empty to the content", () => {
		expect(viewsFromToolInput("Write", "post", { file_path: "/r/a.ts", content: "x" })).toEqual([{ tool: "Write", phase: "post", path: "/r/a.ts", command: null, hunks: [{ old: "", new: "x" }] }]);
	});
	it("P7: Edit yields the old/new pair; MultiEdit one hunk per edit", () => {
		expect(viewsFromToolInput("Edit", "post", { file_path: "/r/a.ts", old_string: "a", new_string: "b" })[0]?.hunks).toEqual([{ old: "a", new: "b" }]);
		const multi = viewsFromToolInput("MultiEdit", "post", { file_path: "/r/a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] });
		expect(multi[0]?.hunks).toEqual([{ old: "a", new: "b" }, { old: "c", new: "d" }]);
	});
	it("P8: apply_patch yields one view per non-deleted file", () => {
		const patch = "*** Begin Patch\n*** Add File: src/new.ts\n+export const x = 1;\n*** Delete File: src/old.ts\n*** End Patch\n";
		const views = viewsFromToolInput("apply_patch", "post", { patch });
		expect(views.map((v) => v.path)).toEqual(["src/new.ts"]);
		expect(views[0]?.hunks[0]?.new).toContain("export const x = 1;");
	});
	it("N8: a write tool with no file_path yields nothing", () => {
		expect(viewsFromToolInput("Edit", "post", { old_string: "a", new_string: "b" })).toEqual([]);
	});
});

describe("settleView — the deterministic decider runs before any model", () => {
	const settle = { compliant_regex: "\\b(tail|head) -[nc]\\b", violated_regex: "\\bcat\\s+\\S+\\.jsonl\\s*$" };
	it("P9: a bounded read settles compliant", () => expect(settleView(settle, bash("tail -n 5 collection.jsonl"))).toBe("compliant"));
	it("P10: a bare cat settles violated", () => expect(settleView(settle, bash("cat collection.jsonl"))).toBe("violated"));
	it("P11: compliant wins when both match", () => expect(settleView(settle, bash("cat collection.jsonl | tail -n 5; cat x.jsonl"))).toBe("compliant"));
	it("N9: neither regex matching is the model's residue (null)", () => expect(settleView(settle, bash("python3 read.py collection.jsonl"))).toBeNull());
	it("N10: a hunks view is judged on its NEW text only", () => {
		const s = { compliant_regex: null, violated_regex: "appendFileSync" };
		expect(settleView(s, edit("/r/a.ts", [{ old: "appendFileSync(x)", new: "writeLedger(x)" }]))).toBeNull();
		expect(settleView(s, edit("/r/a.ts", [{ old: "", new: "appendFileSync(x)" }]))).toBe("violated");
	});
});
