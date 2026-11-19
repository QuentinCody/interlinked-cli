import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerBridge } from "./server-bridge.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("guard-event HTTP acknowledgement", () => {
	// test-contract: bug — a batch is delivered only after a successful HTTP acknowledgement.
	it.each([400, 401, 429, 500, 503])("retries HTTP %i without dropping or duplicating the batch", async status => {
		vi.useFakeTimers();
		const bodies: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input).endsWith("/health")) return new Response("ok");
			bodies.push(String(init?.body));
			return new Response("", { status: bodies.length === 1 ? status : 200 });
		}));
		const bridge = new ServerBridge({ serverUrl: "http://bridge.invalid" });
		try {
			await bridge.healthCheck();
			bridge.reportGuardEvent({ agent_name: "test", event_type: "guard_block", decision: "block", reason: "test rule", occurred_at: "2026-11-11T00:00:00Z" });
			await vi.advanceTimersByTimeAsync(10_000);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(bodies).toHaveLength(2);
			expect(bodies[1]).toBe(bodies[0]);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(bodies).toHaveLength(2);
		} finally { bridge.shutdown(); }
	});
});
