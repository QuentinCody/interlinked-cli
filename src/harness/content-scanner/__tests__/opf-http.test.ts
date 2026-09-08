import { describe, expect, it, vi } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { OpfHttpScanner } from "../opf-http.js";
import type { ContentScannerConfig } from "../types.js";

function makeConfig(overrides: Partial<ContentScannerConfig> = {}): ContentScannerConfig {
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
			sidecar_script: "/tmp/opf.py",
			startup_timeout_ms: 45_000,
			scan_timeout_ms: 1500,
			idle_shutdown_ms: 1_800_000,
			max_restarts: 3,
		},
		huggingface: {
			model: "openai/gpt-oss-safeguard-20b",
			api_key_env: "HF_TOKEN",
			timeout_ms: 4000,
		},
		custom_http: { endpoint: "", timeout_ms: 4000 },
		min_score: 0,
		max_scan_bytes: 100_000,
		...overrides,
	};
}

function okResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("OpfHttpScanner — huggingface runtime", () => {
	it("POSTs {inputs: text} to the HF Inference API and parses the response", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () =>
			okResponse([
				{ entity_group: "private_email", score: 0.99, word: "a@b.com", start: 0, end: 7 },
				{ entity_group: "secret", score: 0.95, word: "sk_live_abc", start: 12, end: 23 },
			]),
		);
		const scanner = new OpfHttpScanner(makeConfig(), {
			fetchFn,
			resolveEnv: (k) => (k === "HF_TOKEN" ? "hf_test_token" : undefined),
		});
		const findings = await scanner.scan({ text: "a@b.com is sk_live_abc", source: "Bash.command" });

		expect(findings).toEqual([
			{
				label: "private_email",
				start: 0,
				end: 7,
				text: "a@b.com",
				score: 0.99,
				source: "Bash.command",
			},
			{
				label: "secret",
				start: 12,
				end: 23,
				text: "sk_live_abc",
				score: 0.95,
				source: "Bash.command",
			},
		]);

		expect(fetchFn).toHaveBeenCalledOnce();
		const [url, init] = nonNull(fetchFn.mock.calls[0]);
		expect(url).toBe(
			"https://api-inference.huggingface.co/models/openai/gpt-oss-safeguard-20b",
		);
		expect(init?.method).toBe("POST");
		expect(init?.headers).toMatchObject({
			"Content-Type": "application/json",
			Authorization: "Bearer hf_test_token",
		});
		expect(init?.body).toBe(JSON.stringify({ inputs: "a@b.com is sk_live_abc" }));
	});

	it("returns [] on non-2xx (fail-open)", async () => {
		const fetchFn = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: "model loading" }), {
					status: 503,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const scanner = new OpfHttpScanner(makeConfig(), {
			fetchFn,
			resolveEnv: () => "tok",
		});
		const findings = await scanner.scan({ text: "x", source: "s" });
		expect(findings).toEqual([]);
	});

	it("returns [] when the response is not an array (e.g. HF returns an error object)", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => okResponse({ error: "something" }));
		const scanner = new OpfHttpScanner(makeConfig(), {
			fetchFn,
			resolveEnv: () => "tok",
		});
		const findings = await scanner.scan({ text: "x", source: "s" });
		expect(findings).toEqual([]);
	});

	it("returns [] on fetch rejection (network error)", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => {
			throw new Error("econnrefused");
		});
		const scanner = new OpfHttpScanner(makeConfig(), {
			fetchFn,
			resolveEnv: () => "tok",
		});
		const findings = await scanner.scan({ text: "x", source: "s" });
		expect(findings).toEqual([]);
	});

	it("drops malformed entries but keeps well-formed ones in the same response", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () =>
			okResponse([
				{ entity_group: "secret", score: 0.9, word: "sk", start: 0, end: 2 },
				{ entity_group: "private_email" /* missing fields */ },
				null,
				"not-an-object",
			]),
		);
		const scanner = new OpfHttpScanner(makeConfig(), {
			fetchFn,
			resolveEnv: () => "tok",
		});
		const findings = await scanner.scan({ text: "sk", source: "s" });
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).label).toBe("secret");
	});

	it("omits Authorization header when no API key is set", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => okResponse([]));
		const scanner = new OpfHttpScanner(makeConfig(), {
			fetchFn,
			resolveEnv: () => undefined,
		});
		await scanner.scan({ text: "x", source: "s" });
		const init = nonNull(fetchFn.mock.calls[0])[1];
		expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
		expect(new Headers(init?.headers).get("Authorization")).toBeNull();
	});
});

describe("OpfHttpScanner — custom_http runtime", () => {
	it("uses the custom endpoint and skips auth when api_key_env is unset", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => okResponse([]));
		const scanner = new OpfHttpScanner(
			makeConfig({
				runtime: "custom_http",
				custom_http: { endpoint: "https://my-tgi.internal/scan", timeout_ms: 2000 },
			}),
			{ fetchFn, resolveEnv: () => undefined },
		);
		await scanner.scan({ text: "x", source: "s" });
		const [url, init] = nonNull(fetchFn.mock.calls[0]);
		expect(url).toBe("https://my-tgi.internal/scan");
		expect(new Headers(init?.headers).get("Authorization")).toBeNull();
	});

	it("ready() returns false when endpoint is empty", async () => {
		const fetchFn = vi.fn<typeof fetch>();
		const scanner = new OpfHttpScanner(
			makeConfig({
				runtime: "custom_http",
				custom_http: { endpoint: "", timeout_ms: 2000 },
			}),
			{ fetchFn, resolveEnv: () => undefined },
		);
		expect(await scanner.ready()).toBe(false);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("sends the Authorization header when custom_http.api_key_env resolves", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => okResponse([]));
		const scanner = new OpfHttpScanner(
			makeConfig({
				runtime: "custom_http",
				custom_http: {
					endpoint: "https://my-tgi.internal/scan",
					api_key_env: "CUSTOM_TGI_TOKEN",
					timeout_ms: 2000,
				},
			}),
			{
				fetchFn,
				resolveEnv: (k) => (k === "CUSTOM_TGI_TOKEN" ? "custom-secret-123" : undefined),
			},
		);
		await scanner.scan({ text: "x", source: "s" });
		const init = nonNull(fetchFn.mock.calls[0])[1];
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			"Bearer custom-secret-123",
		);
	});

	it("exposes a name derived from the custom endpoint", () => {
		const fetchFn = vi.fn<typeof fetch>();
		const scanner = new OpfHttpScanner(
			makeConfig({
				runtime: "custom_http",
				custom_http: { endpoint: "https://my-tgi.internal/scan", timeout_ms: 2000 },
			}),
			{ fetchFn, resolveEnv: () => undefined },
		);
		expect(scanner.name).toBe("http:https://my-tgi.internal/scan");
	});

	it("names an empty custom endpoint <unset> rather than the empty string", () => {
		const fetchFn = vi.fn<typeof fetch>();
		const scanner = new OpfHttpScanner(
			makeConfig({
				runtime: "custom_http",
				custom_http: { endpoint: "", timeout_ms: 2000 },
			}),
			{ fetchFn, resolveEnv: () => undefined },
		);
		expect(scanner.name).toBe("http:<unset>");
	});
});

describe("OpfHttpScanner — ready() probe", () => {
	it("returns true when the endpoint answers 2xx with a parseable array", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => okResponse([]));
		const scanner = new OpfHttpScanner(makeConfig(), {
			fetchFn,
			resolveEnv: () => "tok",
		});
		expect(await scanner.ready()).toBe(true);
		// The probe sends an empty input — auth + routing exercised, ~zero cost.
		expect(fetchFn).toHaveBeenCalledOnce();
		expect(nonNull(fetchFn.mock.calls[0])[1]?.body).toBe(JSON.stringify({ inputs: "" }));
	});

	it("returns false when the endpoint answers non-2xx", async () => {
		const fetchFn = vi.fn<typeof fetch>(
			async () => new Response("nope", { status: 500 }),
		);
		const scanner = new OpfHttpScanner(makeConfig(), {
			fetchFn,
			resolveEnv: () => "tok",
		});
		expect(await scanner.ready()).toBe(false);
	});

	it("returns false when a 2xx body is not a parseable array", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => okResponse({ error: "x" }));
		const scanner = new OpfHttpScanner(makeConfig(), {
			fetchFn,
			resolveEnv: () => "tok",
		});
		expect(await scanner.ready()).toBe(false);
	});
});

describe("OpfHttpScanner — disabled runtime (neither huggingface nor custom_http)", () => {
	function disabledConfig(): ContentScannerConfig {
		return makeConfig({ runtime: "local" });
	}

	it("reports a <disabled> name", () => {
		const scanner = new OpfHttpScanner(disabledConfig(), {
			fetchFn: vi.fn<typeof fetch>(),
			resolveEnv: () => undefined,
		});
		expect(scanner.name).toBe("http:<disabled>");
	});

	it("scan() short-circuits to [] without ever calling fetch", async () => {
		const fetchFn = vi.fn<typeof fetch>();
		const scanner = new OpfHttpScanner(disabledConfig(), {
			fetchFn,
			resolveEnv: () => undefined,
		});
		const findings = await scanner.scan({ text: "a@b.com", source: "s" });
		expect(findings).toEqual([]);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("ready() returns false without calling fetch", async () => {
		const fetchFn = vi.fn<typeof fetch>();
		const scanner = new OpfHttpScanner(disabledConfig(), {
			fetchFn,
			resolveEnv: () => undefined,
		});
		expect(await scanner.ready()).toBe(false);
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

describe("OpfHttpScanner — lifecycle", () => {
	it("shutdown() resolves (stateless, nothing to clean up)", async () => {
		const scanner = new OpfHttpScanner(makeConfig(), {
			fetchFn: vi.fn<typeof fetch>(async () => okResponse([])),
			resolveEnv: () => "tok",
		});
		await expect(scanner.shutdown()).resolves.toBeUndefined();
	});

	it("reports the http runtime tag", () => {
		const scanner = new OpfHttpScanner(makeConfig(), {
			fetchFn: vi.fn<typeof fetch>(),
			resolveEnv: () => "tok",
		});
		expect(scanner.runtime).toBe("http");
	});
});

describe("OpfHttpScanner — default DI seams (no test hooks supplied)", () => {
	it("falls back to the global fetch when fetchFn is omitted", async () => {
		const original = globalThis.fetch;
		const stub = vi.fn<typeof fetch>(async () =>
			okResponse([
				{ entity_group: "secret", score: 0.9, word: "sk", start: 0, end: 2 },
			]),
		);
		globalThis.fetch = stub;
		try {
			// No fetchFn in opts → constructor uses globalThis.fetch.
			const scanner = new OpfHttpScanner(makeConfig(), {
				resolveEnv: () => "tok",
			});
			const findings = await scanner.scan({ text: "sk", source: "s" });
			expect(stub).toHaveBeenCalledOnce();
			expect(findings).toEqual([
				{ label: "secret", start: 0, end: 2, text: "sk", score: 0.9, source: "s" },
			]);
		} finally {
			globalThis.fetch = original;
		}
	});

	it("falls back to process.env when resolveEnv is omitted (var present)", async () => {
		const varName = "OPF_HTTP_TEST_TOKEN_PRESENT";
		const prior = process.env[varName];
		process.env[varName] = "env-token-from-process";
		const fetchFn = vi.fn<typeof fetch>(async () => okResponse([]));
		try {
			// No resolveEnv → defaultEnvResolver reads process.env[varName].
			const scanner = new OpfHttpScanner(
				makeConfig({
					huggingface: {
						model: "vendor-model-v6",
						api_key_env: varName,
						timeout_ms: 4000,
					},
				}),
				{ fetchFn },
			);
			await scanner.scan({ text: "x", source: "s" });
			const init = nonNull(fetchFn.mock.calls[0])[1];
			expect(new Headers(init?.headers).get("Authorization")).toBe(
				"Bearer env-token-from-process",
			);
		} finally {
			if (prior === undefined) delete process.env[varName];
			else process.env[varName] = prior;
		}
	});

	it("defaultEnvResolver returns undefined for an empty api_key_env name (no Authorization header)", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => okResponse([]));
		// Empty api_key_env exercises the `varName ? ... : undefined` false branch
		// inside defaultEnvResolver without touching process.env at all.
		const scanner = new OpfHttpScanner(
			makeConfig({
				huggingface: { model: "vendor-model-v6", api_key_env: "", timeout_ms: 4000 },
			}),
			{ fetchFn },
		);
		await scanner.scan({ text: "x", source: "s" });
		const init = nonNull(fetchFn.mock.calls[0])[1];
		expect(new Headers(init?.headers).get("Authorization")).toBeNull();
	});
});

describe("OpfHttpScanner — caller AbortSignal is merged into the request", () => {
	it("forwards an aborting caller signal through to the underlying fetch (AbortSignal.any path)", async () => {
		// The injected fetch inspects the signal it actually receives, proving the
		// caller's signal was merged in rather than dropped.
		let observed: AbortSignal | undefined;
		const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
			observed = init?.signal ?? undefined;
			return okResponse([]);
		});
		const scanner = new OpfHttpScanner(makeConfig(), {
			fetchFn,
			resolveEnv: () => "tok",
		});
		const caller = new AbortController();
		const findings = await scanner.scan({
			text: "x",
			source: "s",
			signal: caller.signal,
		});
		expect(findings).toEqual([]);
		expect(observed).toBeInstanceOf(AbortSignal);
		expect(observed?.aborted).toBe(false);
		// Aborting the caller after the request also flips the merged signal —
		// confirms the merge wired the caller through, not just the timeout.
		caller.abort();
		expect(observed?.aborted).toBe(true);
	});

	it("an already-aborted caller signal surfaces as an aborted merged signal (fail-open to [])", async () => {
		const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
			// Mimic a real fetch honoring the signal: reject when already aborted.
			if (init?.signal?.aborted) {
				throw new DOMException("Aborted", "AbortError");
			}
			return okResponse([
				{ entity_group: "secret", score: 0.9, word: "sk", start: 0, end: 2 },
			]);
		});
		const scanner = new OpfHttpScanner(makeConfig(), {
			fetchFn,
			resolveEnv: () => "tok",
		});
		const caller = new AbortController();
		caller.abort();
		const findings = await scanner.scan({
			text: "sk",
			source: "s",
			signal: caller.signal,
		});
		// rawScan catches the abort error and fail-opens to undefined → [].
		expect(findings).toEqual([]);
	});

	it("fires the timeout abort when fetch outlasts timeout_ms (fail-open to [])", async () => {
		// fetch hangs until *its* signal aborts; the only thing that aborts it is
		// the internal timeout firing controller.abort() after timeout_ms. So this
		// drives the setTimeout callback and the timeout-driven fail-open path.
		const fetchFn = vi.fn<typeof fetch>(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					const sig = init?.signal;
					if (!sig) return; // never resolves → test would time out, signalling a bug
					if (sig.aborted) {
						reject(new DOMException("Aborted", "AbortError"));
						return;
					}
					sig.addEventListener(
						"abort",
						() => reject(new DOMException("Aborted", "AbortError")),
						{ once: true },
					);
				}),
		);
		const scanner = new OpfHttpScanner(
			makeConfig({
				huggingface: { model: "vendor-model-v6", api_key_env: "HF_TOKEN", timeout_ms: 5 },
			}),
			{ fetchFn, resolveEnv: () => "tok" },
		);
		const findings = await scanner.scan({ text: "x", source: "s" });
		expect(findings).toEqual([]);
		expect(fetchFn).toHaveBeenCalledOnce();
		// The signal handed to fetch must have been aborted by the timeout.
		expect(nonNull(fetchFn.mock.calls[0])[1]?.signal?.aborted).toBe(true);
	});

	it("merges via the hand-rolled fallback when AbortSignal.any is unavailable (older runtimes)", async () => {
		const original = AbortSignal.any;
		// Simulate a runtime without AbortSignal.any to drive the fallback listener
		// branch (the `forward` closure + manual AbortController).
		Reflect.set(AbortSignal, "any", undefined);
		let observed: AbortSignal | undefined;
		const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
			observed = init?.signal ?? undefined;
			return okResponse([]);
		});
		try {
			const scanner = new OpfHttpScanner(makeConfig(), {
				fetchFn,
				resolveEnv: () => "tok",
			});
			const caller = new AbortController();
			await scanner.scan({ text: "x", source: "s", signal: caller.signal });
			expect(observed).toBeInstanceOf(AbortSignal);
			expect(observed?.aborted).toBe(false);
			// Aborting the caller propagates through the fallback's `forward` listener.
			caller.abort();
			expect(observed?.aborted).toBe(true);
		} finally {
			Reflect.set(AbortSignal, "any", original);
		}
	});
});
