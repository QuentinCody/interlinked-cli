import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanSecrets } from "../signatures.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import {
	CLOUDFLARE_ACCOUNT_ENV,
	CLOUDFLARE_TOKEN_ENV,
	DECISION_SHADOW_LEDGER,
	drainDecisionShadows,
	resetDecisionShadowState,
} from "./decision-shadow.js";
import {
	buildSecretHitState,
	schedulePreToolSecretShadow,
	scheduleSecretHitShadow,
	SECRET_HIT_KEEP_THRESHOLD,
	SECRET_HIT_QUESTION,
	sourceKindForPath,
} from "./secret-shadow.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "secret-shadow-"));
	mkdirSync(join(dir, ".interlinked"));
	resetDecisionShadowState();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Synthetic, assembled at runtime so no credential literal sits in the source.
const SECRET = `sk-${"Zx9Cv8Bn7Mq6Wl5Ek4Rj3"}${"Th2Yg1Uf0Id9Os8Pa7"}`;
const OUTPUT = `$ cat .env\nOPENAI_API_KEY=${SECRET}\nDEBUG=1\n`;
const resolveKey = (name: string): string | undefined =>
	({ [CLOUDFLARE_TOKEN_ENV]: "tok", [CLOUDFLARE_ACCOUNT_ENV]: "acct" })[name];
const ON = { decision_shadow: { enabled: true } } as unknown as GuardRulesConfig;

let seq = 0;
function post(over: Partial<HarnessEvent> = {}): HarnessEvent {
	seq++;
	return {
		hook_event: "PostToolUse", session_id: "s1", tool_name: "Bash", tool_use_id: `tu${seq}`,
		tool_input: { command: "cat .env" }, cwd: dir, ...over,
	} as HarnessEvent;
}
function fetchSpy(p: number, bodies: string[]) {
	return async (_url: string, init: RequestInit): Promise<Response> => {
		bodies.push(String(init.body));
		return new Response(JSON.stringify({ result: { model: "clef-flash", answers: { q1: { type: "noul", noul: p } } } }), { status: 200 });
	};
}
const ledgerText = (): string => {
	try {
		return readFileSync(join(dir, ".interlinked", DECISION_SHADOW_LEDGER), "utf-8");
	} catch {
		return "";
	}
};
const rows = (): Record<string, unknown>[] => ledgerText().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

describe("secret-shadow — positive (must fire)", () => {
	it("P1: a PostToolUse output hit logs one secret_hit row with the signature id", async () => {
		const bodies: string[] = [];
		scheduleSecretHitShadow(post(), ON, OUTPUT, scanSecrets(OUTPUT), "tool_output", { fetchImpl: fetchSpy(0.02, bodies), resolveKey });
		await drainDecisionShadows();
		expect(bodies).toHaveLength(1);
		expect(rows()).toEqual([
			expect.objectContaining({ surface: "secret_hit", rule_id: "sig-secret-openai", p: 0.02, verdict: "would_clear", threshold_used: SECRET_HIT_KEEP_THRESHOLD }),
		]);
	});

	it("P2: the request carries the E19 state and question; the raw secret is in neither the body nor the ledger", async () => {
		const bodies: string[] = [];
		scheduleSecretHitShadow(post(), ON, OUTPUT, scanSecrets(OUTPUT), "tool_output", { fetchImpl: fetchSpy(0.9, bodies), resolveKey });
		await drainDecisionShadows();
		const body = JSON.parse(bodies[0] ?? "{}") as { state: Record<string, string>; questions: { q1: unknown } };
		expect(body.questions.q1).toEqual(SECRET_HIT_QUESTION);
		expect(Object.keys(body.state)).toEqual(["rule_id", "source_kind", "masked_match", "masked_context"]);
		expect(body.state.masked_match).toBe(`${SECRET.slice(0, 4)}…${SECRET.slice(-2)}`);
		expect(body.state.masked_context).toContain(`⟦${SECRET.slice(0, 4)}…${SECRET.slice(-2)}⟧`);
		for (const text of [bodies[0] ?? "", ledgerText()]) {
			expect(text).not.toContain(SECRET);
			expect(text).not.toContain(SECRET.slice(4, -2));
		}
		expect(rows()[0]?.verdict).toBe("would_keep");
	});

	it("P3: a PreToolUse Write whose content holds a signature is asked with a path-derived source kind", async () => {
		const bodies: string[] = [];
		const write = post({ hook_event: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(dir, "src/config.ts"), content: OUTPUT } });
		schedulePreToolSecretShadow(write, ON, { fetchImpl: fetchSpy(0.6, bodies), resolveKey });
		await drainDecisionShadows();
		expect((JSON.parse(bodies[0] ?? "{}") as { state: { source_kind: string } }).state.source_kind).toBe("src_code");
		expect(rows()[0]).toMatchObject({ surface: "secret_hit", tool: "Write", verdict: "would_keep" });
	});

	it("P4: source kinds follow the E19 buckets", () => {
		expect(sourceKindForPath("src/a.test.ts")).toBe("src_test");
		expect(sourceKindForPath("docs/guide.md")).toBe("doc");
		expect(sourceKindForPath("scratch/probe.mts")).toBe("scratch");
		expect(sourceKindForPath("src/lib/x.ts")).toBe("src_code");
	});
});

describe("secret-shadow — negative (must not fire)", () => {
	it("N1: no signature match means no call", async () => {
		const bodies: string[] = [];
		scheduleSecretHitShadow(post(), ON, "plain output", [], "tool_output", { fetchImpl: fetchSpy(0.5, bodies), resolveKey });
		await drainDecisionShadows();
		expect(bodies).toHaveLength(0);
	});

	it("N2: a dry_run event logs nothing", async () => {
		const bodies: string[] = [];
		scheduleSecretHitShadow(post({ dry_run: true }), ON, OUTPUT, scanSecrets(OUTPUT), "tool_output", { fetchImpl: fetchSpy(0.5, bodies), resolveKey });
		await drainDecisionShadows();
		expect(bodies).toHaveLength(0);
		expect(ledgerText()).toBe("");
	});

	it("N3: disabled config or the surface switch makes zero calls", async () => {
		const bodies: string[] = [];
		const off = [
			{ decision_shadow: { enabled: false } },
			{ decision_shadow: { enabled: true, surfaces: { secret_hit: false } } },
			{},
		] as unknown as GuardRulesConfig[];
		for (const r of off) {
			scheduleSecretHitShadow(post(), r, OUTPUT, scanSecrets(OUTPUT), "tool_output", { fetchImpl: fetchSpy(0.5, bodies), resolveKey });
			schedulePreToolSecretShadow(post({ hook_event: "PreToolUse", tool_name: "Write", tool_input: { file_path: "a.ts", content: OUTPUT } }), r, { fetchImpl: fetchSpy(0.5, bodies), resolveKey });
		}
		await drainDecisionShadows();
		expect(bodies).toHaveLength(0);
	});

	it("N4: a backend failure never throws and writes no row", async () => {
		const throwing = async (): Promise<Response> => {
			throw new Error("down");
		};
		expect(() => scheduleSecretHitShadow(post(), ON, OUTPUT, scanSecrets(OUTPUT), "tool_output", { fetchImpl: throwing, resolveKey })).not.toThrow();
		await drainDecisionShadows();
		expect(ledgerText()).toBe("");
	});

	it("N5: a match that cannot be relocated builds no state", () => {
		expect(buildSecretHitState("no secret here", ["sig-secret-openai"], "tool_output")).toBeNull();
		expect(buildSecretHitState(OUTPUT, ["sig-unknown-rule"], "tool_output")).toBeNull();
	});

	it("N6: a PreToolUse Write without a signature match makes no call", async () => {
		const bodies: string[] = [];
		const write = post({ hook_event: "PreToolUse", tool_name: "Write", tool_input: { file_path: "src/a.ts", content: "export const x = 1;\n" } });
		schedulePreToolSecretShadow(write, ON, { fetchImpl: fetchSpy(0.5, bodies), resolveKey });
		await drainDecisionShadows();
		expect(bodies).toHaveLength(0);
	});
});
