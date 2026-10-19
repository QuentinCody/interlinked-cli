import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import {
	CLEF_FLASH_MODEL,
	CLOUDFLARE_ACCOUNT_ENV,
	CLOUDFLARE_TOKEN_ENV,
	DECISION_SHADOW_LEDGER,
	decisionShadowCounters,
	describeDecisionShadowStatus,
	resetDecisionShadowState,
	runShadowAsk,
	type ShadowRequest,
} from "./decision-shadow.js";
import type { DecisionShadowConfig } from "./types.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "decision-shadow-"));
	mkdirSync(join(dir, ".interlinked"));
	resetDecisionShadowState();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CREDS: Record<string, string> = {
	[CLOUDFLARE_TOKEN_ENV]: "test-token-value",
	[CLOUDFLARE_ACCOUNT_ENV]: "acct123",
	TYPESAFE_API_KEY: "ts-key",
};
const resolveKey = (name: string): string | undefined => CREDS[name];

function rules(shadow?: DecisionShadowConfig, jevEnabled = false): GuardRulesConfig {
	return { decision_shadow: shadow, jev: { enabled: jevEnabled } } as unknown as GuardRulesConfig;
}
function event(over: Partial<HarnessEvent> = {}): HarnessEvent {
	return { hook_event: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_use_id: "tu1", cwd: dir, ...over } as HarnessEvent;
}
function request(over: Partial<ShadowRequest> = {}): ShadowRequest {
	return {
		event: event(),
		surface: "guard_block",
		ruleId: "builtin-rm-rf",
		tool: "Bash",
		state: { command: "rm -rf build" },
		question: { type: "noul", instructions: "q", criteria: { true: "t", false: "f" } },
		threshold: 0.5,
		verdicts: { below: "would_release", atOrAbove: "would_hold" },
		...over,
	};
}
interface Call {
	url: string;
	body: string;
	auth: string | null;
}
function fakeFetch(p: number | null, status = 200, calls: Call[] = []) {
	return async (url: string, init: RequestInit): Promise<Response> => {
		calls.push({ url, body: String(init.body), auth: new Headers(init.headers).get("authorization") });
		const answers = p === null ? {} : { q1: { type: "noul", noul: p } };
		const payload = url.includes("cloudflare")
			? { result: { model: "clef-flash", answers, usage: { input_tokens: 10, output_tokens: 0 } }, success: true }
			: { model: "jev-1", answers, usage: { input_tokens: 10, output_tokens: 0 } };
		return new Response(JSON.stringify(payload), { status });
	};
}
const ledgerRows = (): Record<string, unknown>[] => {
	try {
		return readFileSync(join(dir, ".interlinked", DECISION_SHADOW_LEDGER), "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Record<string, unknown>);
	} catch {
		return [];
	}
};

describe("decision-shadow — positive (must fire)", () => {
	it("P1: clef_flash posts the System One body to the Workers AI route and logs one row", async () => {
		const calls: Call[] = [];
		const row = await runShadowAsk(rules({ enabled: true }), request(), { fetchImpl: fakeFetch(0.2, 200, calls), resolveKey });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/cloudflare/clef-flash");
		expect(calls[0]?.auth).toBe("Bearer test-token-value");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			model: CLEF_FLASH_MODEL,
			state: { command: "rm -rf build" },
			questions: { q1: { type: "noul", instructions: "q", criteria: { true: "t", false: "f" } } },
		});
		expect(row).toMatchObject({ surface: "guard_block", rule_id: "builtin-rm-rf", p: 0.2, verdict: "would_release", backend: "clef_flash", dry_run: false });
		expect(ledgerRows()).toHaveLength(1);
	});

	it("P2: p at or above the threshold takes the atOrAbove verdict", async () => {
		const row = await runShadowAsk(rules({ enabled: true }), request(), { fetchImpl: fakeFetch(0.5), resolveKey });
		expect(row?.verdict).toBe("would_hold");
		expect(row?.threshold_used).toBe(0.5);
	});

	it("P3: the jev backend uses the Jev client when jev.enabled is true", async () => {
		const calls: Call[] = [];
		const row = await runShadowAsk(rules({ enabled: true, backend: "jev" }, true), request(), { fetchImpl: fakeFetch(0.9, 200, calls), resolveKey });
		expect(calls[0]?.url).toContain("typesafe");
		expect(row).toMatchObject({ backend: "jev", model: "jev-1", p: 0.9 });
	});

	it("P4: the row carries a sha256 of the state and no credential", async () => {
		const row = await runShadowAsk(rules({ enabled: true }), request(), { fetchImpl: fakeFetch(0.1), resolveKey });
		expect(row?.state_sha256).toMatch(/^[0-9a-f]{64}$/);
		const text = readFileSync(join(dir, ".interlinked", DECISION_SHADOW_LEDGER), "utf-8");
		expect(text).not.toContain("test-token-value");
		expect(text).not.toContain("acct123");
	});

	it("P5: status reports an unconfigured clef_flash backend by name", () => {
		const s = describeDecisionShadowStatus(rules({ enabled: true }), () => undefined);
		expect(s.configured).toBe(false);
		expect(s.line).toContain("unconfigured");
		expect(s.line).toContain(CLOUDFLARE_TOKEN_ENV);
	});
});

describe("decision-shadow — negative (must not fire)", () => {
	it("N1: disabled config makes zero calls and writes nothing", async () => {
		const calls: Call[] = [];
		for (const cfg of [undefined, { enabled: false }, { enabled: true, surfaces: { guard_block: false } }]) {
			expect(await runShadowAsk(rules(cfg), request(), { fetchImpl: fakeFetch(0.2, 200, calls), resolveKey })).toBeNull();
		}
		expect(calls).toHaveLength(0);
		expect(ledgerRows()).toHaveLength(0);
	});

	it("N2: a dry_run event makes no call and logs nothing", async () => {
		const calls: Call[] = [];
		const row = await runShadowAsk(rules({ enabled: true }), request({ event: event({ dry_run: true }) }), { fetchImpl: fakeFetch(0.2, 200, calls), resolveKey });
		expect(row).toBeNull();
		expect(calls).toHaveLength(0);
		expect(ledgerRows()).toHaveLength(0);
	});

	it("N3: an HTTP error, a missing answer and a throwing fetch log nothing and count a failure", async () => {
		const throwing = async (): Promise<Response> => {
			throw new Error("boom");
		};
		const cfg = rules({ enabled: true });
		await expect(runShadowAsk(cfg, request({ event: event({ tool_use_id: "a" }) }), { fetchImpl: fakeFetch(0.2, 500), resolveKey })).resolves.toBeNull();
		await expect(runShadowAsk(cfg, request({ event: event({ tool_use_id: "b" }) }), { fetchImpl: fakeFetch(null), resolveKey })).resolves.toBeNull();
		await expect(runShadowAsk(cfg, request({ event: event({ tool_use_id: "c" }) }), { fetchImpl: throwing, resolveKey })).resolves.toBeNull();
		expect(ledgerRows()).toHaveLength(0);
		expect(decisionShadowCounters().failures).toBe(3);
	});

	it("N4: missing credentials make no call and count as unconfigured", async () => {
		const calls: Call[] = [];
		const row = await runShadowAsk(rules({ enabled: true }), request(), { fetchImpl: fakeFetch(0.2, 200, calls), resolveKey: () => undefined });
		expect(row).toBeNull();
		expect(calls).toHaveLength(0);
		expect(decisionShadowCounters().unconfigured).toBe(1);
	});

	it("N5: the jev backend stays silent while jev.enabled is false", async () => {
		const calls: Call[] = [];
		const row = await runShadowAsk(rules({ enabled: true, backend: "jev" }, false), request(), { fetchImpl: fakeFetch(0.2, 200, calls), resolveKey });
		expect(row).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it("N6: a repeated delivery of the same tool call is asked once", async () => {
		const calls: Call[] = [];
		const cfg = rules({ enabled: true });
		await runShadowAsk(cfg, request(), { fetchImpl: fakeFetch(0.2, 200, calls), resolveKey });
		await runShadowAsk(cfg, request(), { fetchImpl: fakeFetch(0.2, 200, calls), resolveKey });
		expect(calls).toHaveLength(1);
		expect(ledgerRows()).toHaveLength(1);
	});

	it("N7: an out-of-range probability is a failure, not a row", async () => {
		const row = await runShadowAsk(rules({ enabled: true }), request(), { fetchImpl: fakeFetch(1.5), resolveKey });
		expect(row).toBeNull();
		expect(ledgerRows()).toHaveLength(0);
	});
});
