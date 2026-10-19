import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";
import {
	buildGuardBlockState,
	GUARD_BLOCK_HOLD_THRESHOLD,
	GUARD_BLOCK_QUESTION,
	observePreToolUseForBlockShadow,
	resetBlockShadowState,
} from "./block-shadow.js";
import {
	CLOUDFLARE_ACCOUNT_ENV,
	CLOUDFLARE_TOKEN_ENV,
	DECISION_SHADOW_LEDGER,
	drainDecisionShadows,
	resetDecisionShadowState,
} from "./decision-shadow.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "block-shadow-"));
	mkdirSync(join(dir, ".interlinked"));
	resetDecisionShadowState();
	resetBlockShadowState();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const resolveKey = (name: string): string | undefined =>
	({ [CLOUDFLARE_TOKEN_ENV]: "tok", [CLOUDFLARE_ACCOUNT_ENV]: "acct" })[name];
const ON = { decision_shadow: { enabled: true } } as unknown as GuardRulesConfig;
const OFF = { decision_shadow: { enabled: false } } as unknown as GuardRulesConfig;
const BLOCK: HarnessDecision = { decision: "block", reason: "Recursive deletion", rule_id: "builtin-rm-rf" };
const ALLOW: HarnessDecision = { decision: "allow" };

let seq = 0;
function bash(command: string, over: Partial<HarnessEvent> = {}): HarnessEvent {
	seq++;
	return {
		hook_event: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_use_id: `tu${seq}`,
		tool_input: { command }, cwd: dir, ...over,
	} as HarnessEvent;
}
function fetchSpy(p: number, bodies: string[]) {
	return async (_url: string, init: RequestInit): Promise<Response> => {
		bodies.push(String(init.body));
		return new Response(JSON.stringify({ result: { model: "clef-flash", answers: { q1: { type: "noul", noul: p } } } }), { status: 200 });
	};
}
const rows = (): Record<string, unknown>[] => {
	try {
		return readFileSync(join(dir, ".interlinked", DECISION_SHADOW_LEDGER), "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
	} catch {
		return [];
	}
};

describe("block-shadow — positive (must fire)", () => {
	it("P1: a blocked Bash command logs one guard_block row with the rule id", async () => {
		const bodies: string[] = [];
		observePreToolUseForBlockShadow(bash("rm -rf ~/work"), BLOCK, ON, { fetchImpl: fetchSpy(0.9, bodies), resolveKey });
		await drainDecisionShadows();
		expect(bodies).toHaveLength(1);
		expect(rows()).toEqual([
			expect.objectContaining({ surface: "guard_block", rule_id: "builtin-rm-rf", tool: "Bash", p: 0.9, verdict: "would_hold", threshold_used: GUARD_BLOCK_HOLD_THRESHOLD }),
		]);
	});

	it("P2: p below the E20 threshold is would_release", async () => {
		observePreToolUseForBlockShadow(bash("rm -rf scratch/tmp-out"), BLOCK, ON, { fetchImpl: fetchSpy(0.05, []), resolveKey });
		await drainDecisionShadows();
		expect(rows()[0]).toMatchObject({ verdict: "would_release", p: 0.05 });
	});

	it("P3: the request carries the E20 state and question verbatim, previous calls in order", async () => {
		const bodies: string[] = [];
		const deps = { fetchImpl: fetchSpy(0.5, bodies), resolveKey };
		observePreToolUseForBlockShadow(bash("ls"), ALLOW, ON, deps);
		observePreToolUseForBlockShadow({ ...bash(""), tool_name: "Read", tool_input: { file_path: "/a.ts" } }, ALLOW, ON, deps);
		observePreToolUseForBlockShadow(bash("git status"), ALLOW, ON, deps);
		observePreToolUseForBlockShadow(bash("echo one"), ALLOW, ON, deps);
		observePreToolUseForBlockShadow(bash("git reset --hard"), BLOCK, ON, deps);
		await drainDecisionShadows();
		const body = JSON.parse(bodies[0] ?? "{}") as { state: unknown; questions: { q1: unknown } };
		expect(body.questions.q1).toEqual(GUARD_BLOCK_QUESTION);
		expect(body.state).toEqual({
			command: "git reset --hard",
			cwd: null,
			previous_calls: [
				{ tool: "Read", input_head: '{"file_path": "/a.ts"}' },
				{ tool: "Bash", input_head: "git status" },
				{ tool: "Bash", input_head: "echo one" },
			],
		});
		// E28: the blocked flag hurts Clef-flash; it is never sent.
		expect(body.state).not.toHaveProperty("blocked_by_harness");
	});

	it("P4: a credential in the blocked command is redacted before it is sent", () => {
		const key = `sk-${"Q1w2E3r4T5y6U7i8"}${"O9p0A1s2D3f4G5h6"}`;
		const s = buildGuardBlockState(bash(`OPENAI_API_KEY=${key} rm -rf /data`), []);
		expect(JSON.stringify(s)).not.toContain(key);
		expect(s.command).toContain("rm -rf /data");
	});
});

describe("block-shadow — negative (must not fire)", () => {
	it("N1: an allowed Bash command makes no call", async () => {
		const bodies: string[] = [];
		observePreToolUseForBlockShadow(bash("rm -rf build"), ALLOW, ON, { fetchImpl: fetchSpy(0.9, bodies), resolveKey });
		await drainDecisionShadows();
		expect(bodies).toHaveLength(0);
		expect(rows()).toHaveLength(0);
	});

	it("N2: a dry_run block (interlinked harness test) logs nothing", async () => {
		const bodies: string[] = [];
		observePreToolUseForBlockShadow(bash("rm -rf /", { dry_run: true }), BLOCK, ON, { fetchImpl: fetchSpy(0.9, bodies), resolveKey });
		await drainDecisionShadows();
		expect(bodies).toHaveLength(0);
		expect(rows()).toHaveLength(0);
	});

	it("N3: a blocked non-shell tool is not this surface", async () => {
		const bodies: string[] = [];
		const write = { ...bash(""), tool_name: "Write", tool_input: { file_path: "/x", content: "y" } } as HarnessEvent;
		observePreToolUseForBlockShadow(write, BLOCK, ON, { fetchImpl: fetchSpy(0.9, bodies), resolveKey });
		await drainDecisionShadows();
		expect(bodies).toHaveLength(0);
	});

	it("N4: disabled config makes zero calls, including the surface switch", async () => {
		const bodies: string[] = [];
		const surfaceOff = { decision_shadow: { enabled: true, surfaces: { guard_block: false } } } as unknown as GuardRulesConfig;
		for (const r of [OFF, surfaceOff, {} as GuardRulesConfig]) {
			observePreToolUseForBlockShadow(bash("rm -rf /"), BLOCK, r, { fetchImpl: fetchSpy(0.9, bodies), resolveKey });
		}
		await drainDecisionShadows();
		expect(bodies).toHaveLength(0);
	});

	it("N5: a backend failure never throws and writes no row", async () => {
		const failing = async (): Promise<Response> => new Response("nope", { status: 503 });
		expect(() => observePreToolUseForBlockShadow(bash("rm -rf /"), BLOCK, ON, { fetchImpl: failing, resolveKey })).not.toThrow();
		await drainDecisionShadows();
		expect(rows()).toHaveLength(0);
	});
});
