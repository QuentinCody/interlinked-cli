import { expect, it } from "vitest";
import { DEFAULT_COWORK_POLICY, parseCoworkPolicy } from "./policy.js";

const bridge = (timeoutMs: number) => ({ url: "https://bridge.example.com/hook", tokenEnv: "COWORK_TOKEN", workspace: "project", timeoutMs });

// test-contract: boundary — the bridge timeout is capped at 10000 ms; a longer value must be refused
it("refuses a bridge timeout above 10000 ms", () => {
	expect(() => parseCoworkPolicy({ ...DEFAULT_COWORK_POLICY, bridge: bridge(10001) })).toThrow("Bridge timeout must be 100–10000 ms");
});

// test-contract: boundary — exactly 10000 ms is the largest accepted timeout
it("accepts a bridge timeout of exactly 10000 ms", () => {
	expect(parseCoworkPolicy({ ...DEFAULT_COWORK_POLICY, bridge: bridge(10000) }).bridge?.timeoutMs).toBe(10000);
});
