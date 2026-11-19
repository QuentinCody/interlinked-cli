import { describe, expect, it } from "vitest";
import { consentDecision, renderEvidence, renderState } from "./evidence.js";
import { samplePacket } from "./fixtures.js";
import type { TriggerView } from "./trigger.js";

const bash = (command: string): TriggerView => ({ tool: "Bash", phase: "post", path: null, command, hunks: [] });
const edit = (path: string, text: string): TriggerView => ({ tool: "Edit", phase: "post", path, command: null, hunks: [{ old: "", new: text }] });

describe("consentDecision — positive (allowed)", () => {
	it("P1: a command packet with the command kind consented", () => {
		expect(consentDecision({ kinds: ["command"], paths: [] }, "command", bash("ls"), "/repo")).toEqual({ ok: true });
	});
	it("P2: a hunks packet whose path matches a consented glob (repo-relative)", () => {
		expect(consentDecision({ kinds: ["hunks"], paths: ["src/**"] }, "hunks", edit("/repo/src/a.ts", "x"), "/repo")).toEqual({ ok: true });
	});
});

describe("consentDecision — negative (refused, with the gate named)", () => {
	it("N1: no consent section at all", () => expect(consentDecision(undefined, "command", bash("ls"), "/repo")).toEqual({ ok: false, gate: "no_consent" }));
	it("N2: the evidence kind is not consented", () =>
		expect(consentDecision({ kinds: ["hunks"], paths: ["**"] }, "command", bash("ls"), "/repo")).toEqual({ ok: false, gate: "no_consent" }));
	it("N3: a path outside every consented glob is a privacy refusal on its own", () =>
		expect(consentDecision({ kinds: ["hunks"], paths: ["src/**"] }, "hunks", edit("/repo/docs/x.md", "x"), "/repo")).toEqual({ ok: false, gate: "privacy" }));
	it("N4: a path packet with no path globs consented", () =>
		expect(consentDecision({ kinds: ["hunks"], paths: [] }, "hunks", edit("/repo/src/a.ts", "x"), "/repo")).toEqual({ ok: false, gate: "privacy" }));
	it("N5: a path outside the repo is never consented", () =>
		expect(consentDecision({ kinds: ["hunks"], paths: ["**"] }, "hunks", edit("/elsewhere/a.ts", "x"), "/repo")).toEqual({ ok: false, gate: "privacy" }));
});

describe("renderEvidence", () => {
	it("P3: a known credential is redacted before anything is rendered", () => {
		const r = renderEvidence("command", bash(`curl -H "Authorization: Bearer sk-ant-api03-${"a".repeat(40)}" https://x`), { commandChars: 4000, hunkChars: 100, maxHunks: 2 });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const cmd = (r.evidence as { command: string }).command;
		expect(cmd).not.toContain("a".repeat(40));
		expect(cmd).toContain("https://x");
	});
	it("N7: a residual secret signature in the RENDERED text refuses the call", () => {
		const r = renderEvidence("command", bash("echo hi"), { commandChars: 4000, hunkChars: 100, maxHunks: 2 }, () => 1);
		expect(r).toEqual({ ok: false, gate: "secret" });
	});
	it("P4: a clean command renders as {command}", () => {
		const r = renderEvidence("command", bash("tail -n 5 x.jsonl"), { commandChars: 4000, hunkChars: 100, maxHunks: 2 });
		expect(r).toEqual({ ok: true, evidence: { command: "tail -n 5 x.jsonl" } });
	});
	it("P5: hunks are capped in count and length, and the total is reported", () => {
		const view: TriggerView = { tool: "Edit", phase: "post", path: "/repo/a.ts", command: null, hunks: [{ old: "", new: "1" }, { old: "", new: "2" }, { old: "", new: "x".repeat(500) }] };
		const r = renderEvidence("hunks", view, { commandChars: 10, hunkChars: 40, maxHunks: 2 });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const ev = r.evidence as { path: string; hunks: { new: string }[]; hunks_total: number };
		expect(ev.hunks).toHaveLength(2);
		expect(ev.hunks_total).toBe(3);
	});
	it("N6: a long command is cut with a marker, never silently", () => {
		const r = renderEvidence("command", bash("y".repeat(100)), { commandChars: 50, hunkChars: 10, maxHunks: 1 });
		expect(r.ok).toBe(true);
		if (r.ok) expect((r.evidence as { command: string }).command).toContain("[truncated]");
	});
});

describe("renderState", () => {
	it("P6: one state carries the tool, the evidence once, and every packet's quote keyed by id", () => {
		const s = renderState("Bash", { command: "ls" }, [samplePacket(), samplePacket({ id: "two" })]);
		expect(s).toEqual({
			tool: "Bash",
			evidence: { command: "ls" },
			rules: { "bounded-log-read": { instruction: samplePacket().source.quote, from: "CLAUDE.md" }, two: { instruction: samplePacket().source.quote, from: "CLAUDE.md" } },
		});
	});
});
