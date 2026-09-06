// Tests for the Stop-rescan signal filter: sanctioned-scratch carve-outs,
// introduced-only filtering, subagent attribution, and the repeat-Stop delta.
// "positive (must fire)" = the finding reaches the main actor's list;
// "negative (must not fire)" = it is correctly dropped, collapsed, or moved.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadStopDigestState, recordStopDigestState } from "./stop-digest-state.js";
import {
	digestStopRescan,
	type RescanFindingLike,
	SANCTIONED_SCRATCH_CHECKS,
} from "./stop-rescan-report.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "stop-rescan-report-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function finding(over: Partial<RescanFindingLike> = {}): RescanFindingLike {
	return {
		file: "src/a.ts",
		checkId: "eval_usage",
		line: 4,
		text: "eval(a)",
		deferred: false,
		deferReason: null,
		...over,
	};
}

function run(
	findings: RescanFindingLike[],
	over: Partial<Parameters<typeof digestStopRescan>[0]> = {},
) {
	return digestStopRescan({
		findings,
		cwd: "/repo",
		sessionId: "S",
		interlinkedDir: dir,
		...over,
	});
}

describe("digestStopRescan — positive (must fire)", () => {
	it("P1: reports an introduced finding on a main-actor file in the main list", () => {
		const out = run([finding()]);
		expect(out.warnings.join("\n")).toContain("src/a.ts");
		expect(out.warnings.join("\n")).toContain("eval_usage:4");
	});

	it("P2: keeps a NON-sanctioned check id on a scratch/ file", () => {
		const out = run([finding({ file: "scratch/probe.ts", checkId: "eval_usage" })]);
		expect(out.warnings.join("\n")).toContain("scratch/probe.ts");
	});

	it("P3: keeps a sanctioned check id on a file OUTSIDE scratch/", () => {
		const out = run([finding({ file: "src/a.ts", checkId: "ubs_print_debug_leak" })]);
		expect(out.warnings.join("\n")).toContain("ubs_print_debug_leak");
	});

	it("P4: collapses acknowledged-deferred rows to one count line per file", () => {
		const out = run([
			finding({ line: 1, deferred: true, deferReason: "ack" }),
			finding({ line: 2, deferred: true, deferReason: "ack" }),
		]);
		const text = out.warnings.join("\n");
		expect(text).toContain("2 acknowledged-deferred");
		expect(text).not.toContain("eval_usage:1");
	});

	it("P5: emits ONE subagent summary line naming file, agent and finding counts", () => {
		const attribution = {
			byFile: new Map([["src/a.ts", ["agent1", "agent2"]]]),
			agents: new Set(["agent1", "agent2"]),
		};
		const out = run([finding()], { attribution });
		const text = out.warnings.join("\n");
		expect(text).toContain("1 file(s) touched by 2 subagent(s) carry 1 open finding(s)");
		expect(text).toContain(".interlinked/stop-digest.jsonl");
	});

	it("P6: prints only NEW findings plus a resolved/unchanged line on a repeat Stop", () => {
		run([finding({ line: 1, text: "eval(old)" })]);
		const out = run([
			finding({ line: 1, text: "eval(old)" }),
			finding({ line: 9, text: "eval(new)" }),
		]);
		const text = out.warnings.join("\n");
		expect(text).toContain("eval(new)");
		expect(text).not.toContain("eval(old)");
		expect(text).toContain("0 resolved, 1 unchanged (suppressed)");
	});

	it("P7: records this Stop's open fingerprints so the next Stop can diff them", () => {
		run([finding()]);
		expect(loadStopDigestState(dir).sessions.S?.open).toHaveLength(1);
	});

	it("P8: spools a detail row for every finding it filtered out of the main list", () => {
		const out = run([finding({ file: "scratch/probe.ts", checkId: "ubs_print_debug_leak" })]);
		expect(out.spoolRows.some((r) => r.kind === "sanctioned-scratch")).toBe(true);
	});

	it("P10: collapses a file's 5th+ open finding into a '...and N more' count line", () => {
		// MAX_FINDINGS_PER_FILE is 4: the 5th distinct line on the same file must
		// fold into a summary instead of printing a 5th `checkId:line` row.
		const out = run(
			Array.from({ length: 5 }, (_, i) => finding({ line: i + 1, text: `eval(${i})` })),
		);
		const text = out.warnings.join("\n");
		expect(text).toContain("...and 1 more (see stop-digest.jsonl)");
		expect(text).not.toContain("eval(4)");
	});
});

describe("digestStopRescan — negative (must not fire)", () => {
	it("N1: drops a sanctioned probe-pattern finding under scratch/", () => {
		const out = run([finding({ file: "scratch/probe.ts", checkId: "ubs_print_debug_leak" })]);
		expect(out.warnings.join("\n")).not.toContain("scratch/probe.ts");
	});

	it("N2: drops a finding that already exists in the git baseline", () => {
		const out = run([finding()], { scanBaseline: () => [finding()] });
		expect(out.warnings).toEqual([]);
	});

	it("N3: moves a subagent-attributed file OUT of the main list", () => {
		const attribution = {
			byFile: new Map([["src/a.ts", ["agent1"]]]),
			agents: new Set(["agent1"]),
		};
		const out = run([finding()], { attribution });
		expect(out.warnings.join("\n")).not.toContain("eval_usage:4");
	});

	it("N4: keeps an UNATTRIBUTABLE file in the main list (fail open)", () => {
		const attribution = {
			byFile: new Map([["src/other.ts", ["agent1"]]]),
			agents: new Set(["agent1"]),
		};
		const out = run([finding()], { attribution });
		expect(out.warnings.join("\n")).toContain("eval_usage:4");
	});

	it("N5: writes no state under dryRun", () => {
		run([finding()], { dryRun: true });
		expect(loadStopDigestState(dir).sessions).toEqual({});
	});

	it("N6: returns no warnings at all when there are no findings", () => {
		expect(run([]).warnings).toEqual([]);
	});

	it("N7: does not clobber a prior snapshot's reported tags", () => {
		recordStopDigestState({ interlinkedDir: dir, sessionId: "S", openIds: [], tags: ["kept"] });
		run([finding()]);
		expect(loadStopDigestState(dir).sessions.S?.reported_tags).toContain("kept");
	});

	it("N8: suppresses everything when a repeat Stop has no new findings", () => {
		run([finding()]);
		const out = run([finding()]);
		expect(out.warnings.join("\n")).not.toContain("eval_usage:4");
	});
});

describe("SANCTIONED_SCRATCH_CHECKS", () => {
	it("P9: names the four probe-pattern classes the scratchpad policy sanctions", () => {
		expect([...SANCTIONED_SCRATCH_CHECKS].sort()).toEqual([
			"json_parse_unsafe",
			"no_test_file",
			"top_level_side_effect",
			"ubs_print_debug_leak",
		]);
	});
});
