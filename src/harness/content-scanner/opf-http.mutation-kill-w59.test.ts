import { nonNull } from "../../lib/non-null.js";
import { describe, expect, it, vi } from "vitest";
import { OpfHttpScanner } from "./opf-http.js";
import type { ContentScannerConfig } from "./types.js";

function baseConfig(overrides: Partial<ContentScannerConfig> = {}): ContentScannerConfig {
	return {
		enabled: true,
		runtime: "huggingface",
		scan_points: {
			write_edit: true,
			bash_command: true,
			external_egress: true,
			read_grep_taint: true,
			user_prompt: true,
		},
		local: {
			python_bin: "python3",
			sidecar_script: "/dev/null",
			startup_timeout_ms: 45000,
			scan_timeout_ms: 1500,
			idle_shutdown_ms: 1800000,
			max_restarts: 3,
		},
		huggingface: {
			model: "openai/gpt-oss-safeguard-20b",
			api_key_env: "HF_TOKEN",
			timeout_ms: 4000,
		},
		custom_http: {
			endpoint: "",
			timeout_ms: 4000,
		},
		min_score: 0,
		max_scan_bytes: 100000,
		...overrides,
	};
}

function jsonResponse(ok: boolean, body: unknown): Response {
	return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
}

function validEntity(overrides: Record<string, unknown> = {}) {
	return {
		entity_group: "private_email",
		score: 0.9,
		word: "a@b.com",
		start: 0,
		end: 7,
		...overrides,
	};
}

// --- mutantId 15057a86d4230ad5: name = `hf:${model}` (orig) vs `` (mutant) ---
describe("OpfHttpScanner — name for huggingface runtime", () => {
	it("P1: builds name from the configured model", () => {
		const scanner = new OpfHttpScanner(baseConfig(), { fetchFn: vi.fn() });
		expect(scanner.name).toBe("hf:openai/gpt-oss-safeguard-20b");
		expect(scanner.name).not.toBe("");
	});
});

// --- mutantId 8dc5cd9fb3677cc2: !this.endpoint (orig) vs false (mutant) in ready() ---
describe("OpfHttpScanner — ready() short-circuits on empty endpoint", () => {
	it("P1: returns false and never calls fetch when the scanner is disabled (no endpoint)", async () => {
		const fetchFn = vi.fn();
		const scanner = new OpfHttpScanner(baseConfig({ runtime: "local" }), {
			fetchFn,
		});
		expect(scanner.name).toBe("http:<disabled>");
		const result = await scanner.ready();
		expect(result).toBe(false);
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

// --- mutantId 82bee2352382f4ed: !resp.ok (orig) vs false (mutant) ---
describe("OpfHttpScanner — non-ok HTTP response yields empty findings", () => {
	it("P1: a 500 response is treated as failure even though the body parses as valid entities", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(false, [validEntity()]));
		const scanner = new OpfHttpScanner(baseConfig(), { fetchFn });
		const findings = await scanner.scan({ text: "hi", source: "test" });
		expect(findings).toEqual([]);
	});
});

// --- mutantId 330167bdc988ee2d: clearTimeout(timer) block body removed ---
describe("OpfHttpScanner — clears the abort timer after the request settles", () => {
	it("P1: calls clearTimeout with the timer handle from setTimeout", async () => {
		const clearSpy = vi.spyOn(global, "clearTimeout");
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(true, [validEntity()]));
		const scanner = new OpfHttpScanner(baseConfig(), { fetchFn });
		const findings = await scanner.scan({ text: "hi", source: "test" });
		expect(findings).toHaveLength(1);
		expect(clearSpy).toHaveBeenCalled();
		clearSpy.mockRestore();
	});
});

// --- mutantId 4dca612cbac9cbdd: "abort" (orig) vs "" (mutant) event name in mergeSignals fallback ---
describe("OpfHttpScanner — mergeSignals fallback listens for the abort event", () => {
	it("P1: an aborted caller signal aborts the request when AbortSignal.any is unavailable", async () => {
		const originalAny = AbortSignal.any;
		// Force the hand-rolled fallback path (mimics older runtimes).
		// @ts-expect-error — deliberately removing the fast-path for this test
		AbortSignal.any = undefined;
		try {
			const callerController = new AbortController();
			let observedSignal: AbortSignal | undefined;
			const fetchFn = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
				observedSignal = nonNull(init.signal);
				return new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => {
						reject(new DOMException("Aborted", "AbortError"));
					});
				});
			});
			const scanner = new OpfHttpScanner(baseConfig({ huggingface: { ...baseConfig().huggingface, timeout_ms: 60000 } }), {
				fetchFn,
			});
			const scanPromise = scanner.scan({ text: "hi", source: "test", signal: callerController.signal });
			callerController.abort();
			const findings = await scanPromise;
			expect(findings).toEqual([]);
			expect(observedSignal?.aborted).toBe(true);
		} finally {
			AbortSignal.any = originalAny;
		}
	});
});

// --- mutantId 2a6e38a12cb247a3: !Array.isArray(data) (orig) vs false (mutant) ---
describe("OpfHttpScanner — parseHfResponse rejects non-array payloads", () => {
	it("P1: an iterable-but-non-array payload (Set) yields no findings", async () => {
		const set = new Set([validEntity()]);
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(true, set));
		const scanner = new OpfHttpScanner(baseConfig(), { fetchFn });
		const findings = await scanner.scan({ text: "hi", source: "test" });
		expect(findings).toEqual([]);
	});
});

// --- mutantId 71bb0393a673aa28: typeof item !== "object" (orig) vs false (mutant) ---
describe("OpfHttpScanner — parseHfResponse skips non-object array items", () => {
	it("P1: a function-typed item carrying the right fields is still rejected (not an object)", async () => {
		function fakeEntity() {
			/* noop */
		}
		Object.assign(fakeEntity, validEntity());
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(true, [fakeEntity]));
		const scanner = new OpfHttpScanner(baseConfig(), { fetchFn });
		const findings = await scanner.scan({ text: "hi", source: "test" });
		expect(findings).toEqual([]);
	});
});

// --- parseHfResponse field-validation OR chain (symbol a576e6668713270d) ---
// Each case below leaves exactly one field invalid and the rest valid, so
// the correctly-implemented OR chain filters the entry out. A wide family of
// survivor mutants (short-circuit regroupings, subexpression->false, and
// per-field ConditionalExpression->false swaps) each fail to filter for at
// least one of these single-bad-field cases.
describe("OpfHttpScanner — parseHfResponse per-field type validation", () => {
	it("P1: entity_group of the wrong type is filtered out", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			jsonResponse(true, [validEntity({ entity_group: 123 })]),
		);
		const scanner = new OpfHttpScanner(baseConfig(), { fetchFn });
		const findings = await scanner.scan({ text: "hi", source: "test" });
		expect(findings).toEqual([]);
	});

	it("P2: score of the wrong type is filtered out", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			jsonResponse(true, [validEntity({ score: "high" })]),
		);
		const scanner = new OpfHttpScanner(baseConfig(), { fetchFn });
		const findings = await scanner.scan({ text: "hi", source: "test" });
		expect(findings).toEqual([]);
	});

	it("P3: word of the wrong type is filtered out", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			jsonResponse(true, [validEntity({ word: 42 })]),
		);
		const scanner = new OpfHttpScanner(baseConfig(), { fetchFn });
		const findings = await scanner.scan({ text: "hi", source: "test" });
		expect(findings).toEqual([]);
	});

	it("P4: start of the wrong type is filtered out", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			jsonResponse(true, [validEntity({ start: "0" })]),
		);
		const scanner = new OpfHttpScanner(baseConfig(), { fetchFn });
		const findings = await scanner.scan({ text: "hi", source: "test" });
		expect(findings).toEqual([]);
	});

	it("P5: end of the wrong type is filtered out", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			jsonResponse(true, [validEntity({ end: "7" })]),
		);
		const scanner = new OpfHttpScanner(baseConfig(), { fetchFn });
		const findings = await scanner.scan({ text: "hi", source: "test" });
		expect(findings).toEqual([]);
	});

	it("N1: an entirely valid entity passes through unfiltered", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(true, [validEntity()]));
		const scanner = new OpfHttpScanner(baseConfig(), { fetchFn });
		const findings = await scanner.scan({ text: "hi", source: "test" });
		expect(findings).toHaveLength(1);
		expect(findings[0]?.label).toBe("private_email");
	});
});
