import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sampleFile, samplePacket } from "./fixtures.js";
import { dryRun, readCollectionRows, type ReplayRow, rowToViews } from "./replay.js";

function row(seq: number, tool: string, action: Record<string, unknown>, phase = "pre", session = "s1"): string {
	return JSON.stringify({ schema: "collection.v1", kind: "tool_event", phase, provider_tool: tool, session_id: session, seq, action });
}

describe("rowToViews — positive (rows that yield views)", () => {
	it("P1: a Bash pre row yields a command view", () => {
		const v = rowToViews(JSON.parse(row(1, "Bash", { command: "ls" })));
		expect(v).toEqual([{ session_id: "s1", seq: 1, tool_use_id: null, provider: null, view: { tool: "Bash", phase: "pre", path: null, command: "ls", hunks: [] } }]);
	});
	it("P2: an Edit row with diff hunks yields a path view with the hunks", () => {
		const v = rowToViews(JSON.parse(row(2, "Edit", { path: "/r/a.ts", diff: { hunks: [{ old: "a", new: "b" }] } })));
		expect(v[0]?.view).toEqual({ tool: "Edit", phase: "pre", path: "/r/a.ts", command: null, hunks: [{ old: "a", new: "b" }] });
	});
	it("P3: a Write row with content yields one empty→content hunk", () => {
		const v = rowToViews(JSON.parse(row(3, "Write", { path: "/r/a.ts", content: "x" })));
		expect(v[0]?.view.hunks).toEqual([{ old: "", new: "x" }]);
	});
	it("P4: a post row keeps its phase", () => {
		expect(rowToViews(JSON.parse(row(4, "Bash", { command: "ls" }, "post")))[0]?.view.phase).toBe("post");
	});
});

describe("rowToViews — negative (rows that yield nothing)", () => {
	it("N1: a non tool_event row", () => expect(rowToViews({ kind: "agent_event", phase: "pre" })).toEqual([]));
	it("N2: a row with an unknown phase", () => expect(rowToViews(JSON.parse(row(5, "Bash", { command: "ls" }, "stop")))).toEqual([]));
	it("N3: an edit row with neither hunks nor content nor path", () => expect(rowToViews(JSON.parse(row(6, "Edit", {})))).toEqual([]));
	it("N4: a non-object", () => expect(rowToViews("x")).toEqual([]));
});

describe("dryRun", () => {
	const rows: ReplayRow[] = [
		...rowToViews(JSON.parse(row(1, "Bash", { command: "cat .interlinked/collection.jsonl" }))),
		...rowToViews(JSON.parse(row(2, "Bash", { command: "ls" }))),
		...rowToViews(JSON.parse(row(3, "Bash", { command: "tail -n 5 activity.jsonl" }, "pre", "s2"))),
		...rowToViews(JSON.parse(row(4, "Edit", { path: "/r/a.ts", diff: { hunks: [{ old: "", new: "x" }] } }))),
	];
	// The sample packet is a POST packet; replay rows are PRE. Counting ignores the
	// packet's phase on purpose (the corpus holds one pre row per call) — see replay.ts.
	it("P5: counts triggered rows, sessions and the tool denominator", () => {
		const r = dryRun(sampleFile([samplePacket()]), rows, "claude-code");
		expect(r).toEqual([
			expect.objectContaining({ id: "bounded-log-read", triggered: 2, sessions: 2, tool_rows: 3, cold: false, too_wide: true, support: { supported: true } }),
		]);
		expect(r[0]?.width).toBeCloseTo(2 / 3);
	});
	it("P5b: settled rows are counted and removed from the residue the model would see", () => {
		const p = samplePacket({ settle: { compliant_regex: "\\btail -n\\b", violated_regex: "\\bcat\\b" } });
		expect(dryRun(sampleFile([p]), rows, "claude-code")[0]).toEqual(expect.objectContaining({ triggered: 2, settled_compliant: 1, settled_violated: 1, residue: 0 }));
	});
	it("P6: a packet that never triggers is cold", () => {
		const p = samplePacket({ id: "never", applies: { ...samplePacket().applies, command_regex: "zzz" } });
		expect(dryRun(sampleFile([p]), rows, "claude-code")[0]).toEqual(expect.objectContaining({ triggered: 0, cold: true, too_wide: false }));
	});
	it("P7: the width bound is configurable and compared against the tool denominator", () => {
		expect(dryRun(sampleFile([samplePacket()]), rows, "claude-code", { widthBound: 0.9 })[0]?.too_wide).toBe(false);
	});
	it("N5: an unsupported runner is reported, not assumed", () => {
		expect(dryRun(sampleFile([samplePacket()]), rows, "cursor")[0]?.support.supported).toBe(false);
	});
});

describe("readCollectionRows", () => {
	let dir = "";
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});
	it("P8: streams the newest bytes, drops the partial first line and bad JSON", async () => {
		dir = mkdtempSync(join(tmpdir(), "packets-replay-"));
		const file = join(dir, "collection.jsonl");
		const lines = [row(1, "Bash", { command: "one" }), "{not json", row(2, "Bash", { command: "two" }), row(3, "Bash", { command: "three" })];
		writeFileSync(file, `${lines.join("\n")}\n`);
		const all: ReplayRow[] = [];
		for await (const r of readCollectionRows(file, 10 * 1024)) all.push(r);
		expect(all.map((r) => r.view.command)).toEqual(["one", "two", "three"]);
		const tail: ReplayRow[] = [];
		const lastTwo = Buffer.byteLength(`${lines[2]}\n${lines[3]}\n`) + 5; // 5 bytes into the previous line
		for await (const r of readCollectionRows(file, lastTwo)) tail.push(r);
		expect(tail.map((r) => r.view.command)).toEqual(["two", "three"]);
	});
	it("N6: a missing file yields nothing", async () => {
		const out: ReplayRow[] = [];
		for await (const r of readCollectionRows("/nonexistent/collection.jsonl", 1024)) out.push(r);
		expect(out).toEqual([]);
	});
});
