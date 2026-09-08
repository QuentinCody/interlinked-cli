// ===========================================
// Registry tests — backend factory + disabled-labels wrapper
// ===========================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { createScanner, wrapWithDisabledLabels } from "../registry.js";
import type {
	ContentScanner,
	ContentScannerConfig,
	ScanFinding,
	ScannerStatus,
} from "../types.js";

function makeConfig(overrides: Partial<ContentScannerConfig> = {}): ContentScannerConfig {
	return {
		enabled: true,
		runtime: "local",
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
		huggingface: { model: "x", api_key_env: "HF_TOKEN", timeout_ms: 4000 },
		custom_http: { endpoint: "", timeout_ms: 4000 },
		min_score: 0,
		max_scan_bytes: 100_000,
		...overrides,
	};
}

/** A 200 JSON response in the HF token-classification shape, for stubbing the
 *  global `fetch` that createScanner's HTTP backend reaches for (it has no DI
 *  seam — only OpfHttpScanner's direct constructor does). */
function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function makeFakeBackend(spans: ScanFinding[]): {
	backend: ContentScanner;
	scan: ReturnType<typeof vi.fn>;
} {
	const scan = vi.fn().mockResolvedValue(spans);
	// Hardcoded ISO timestamp — tests must be deterministic; real Date.now()
	// would make this fixture flake under snapshot diffs and fake-timer setups.
	const status: ScannerStatus = { state: "ready", sinceIso: "2026-04-25T00:00:00.000Z" };
	const backend: ContentScanner = {
		name: "fake",
		runtime: "local",
		ready: vi.fn().mockResolvedValue(true),
		scan,
		shutdown: vi.fn().mockResolvedValue(undefined),
		getStatus: () => status,
		onStatusChange: vi.fn(),
	};
	return { backend, scan };
}

describe("createScanner", () => {
	afterEach(() => {
		// Restore the real global fetch after any test that stubbed it, so a
		// stubbed fetch can't leak into sibling tests running in this file.
		vi.unstubAllGlobals();
	});

	it("returns undefined when content scanning is disabled", () => {
		expect(createScanner(makeConfig({ enabled: false }))).toBeUndefined();
	});

	it("returns undefined for an unknown runtime", () => {
		const bad = { ...makeConfig(), runtime: "made_up" };
		expect(createScanner(bad)).toBeUndefined();
	});

	it("builds the local sidecar backend for runtime 'local'", async () => {
		// runtime: "local" routes through the OpfLocalScanner branch. The pool /
		// SidecarManager spawn lazily, so constructing the scanner does NOT start
		// a Python child — only .scan()/.ready() would. We assert on the static
		// identity that distinguishes the backend, then shut it down (a no-op when
		// nothing was ever spawned).
		const scanner = createScanner(makeConfig({ runtime: "local" }));
		expect(scanner).toBeDefined();
		expect(scanner?.name).toBe("opf-local");
		expect(scanner?.runtime).toBe("local");
		await scanner?.shutdown();
	});

	it("builds the HF HTTP backend for runtime 'huggingface'", () => {
		// runtime: "huggingface" routes through the OpfHttpScanner branch and
		// names itself "hf:<model>". No network call happens at construction.
		const scanner = createScanner(
			makeConfig({
				runtime: "huggingface",
				huggingface: {
					model: "vendor-model-v6",
					api_key_env: "SYNTH_TOKEN_ENV",
					timeout_ms: 4000,
				},
			}),
		);
		expect(scanner).toBeDefined();
		expect(scanner?.name).toBe("hf:vendor-model-v6");
		expect(scanner?.runtime).toBe("http");
	});

	it("builds the custom HTTP backend for runtime 'custom_http'", () => {
		// runtime: "custom_http" also routes through OpfHttpScanner but names
		// itself "http:<endpoint>".
		const scanner = createScanner(
			makeConfig({
				runtime: "custom_http",
				custom_http: { endpoint: "https://synthetic.invalid/classify", timeout_ms: 4000 },
			}),
		);
		expect(scanner).toBeDefined();
		expect(scanner?.name).toBe("http:https://synthetic.invalid/classify");
		expect(scanner?.runtime).toBe("http");
	});

	it("returns the bare backend (no wrapper) when disabled_labels is unset", async () => {
		// disabled_labels unset → createScanner returns the backend verbatim
		// (wrapWithDisabledLabels short-circuits). End-to-end behavioral proof
		// via a real scan: findings pass through unfiltered.
		const fetchFn = vi.fn<typeof fetch>(async () =>
			jsonResponse([
				{ entity_group: "private_email", score: 0.99, word: "x@y.com", start: 0, end: 7 },
				{ entity_group: "private_url", score: 0.9, word: "src/foo.ts", start: 9, end: 19 },
			]),
		);
		vi.stubGlobal("fetch", fetchFn);
		const scanner = createScanner(
			makeConfig({
				runtime: "custom_http",
				custom_http: { endpoint: "https://synthetic.invalid/classify", timeout_ms: 4000 },
			}),
		);
		const out = await scanner?.scan({ text: "x@y.com src/foo.ts", source: "Write.content" });
		expect(out?.map((f) => f.label)).toEqual(["private_email", "private_url"]);
		expect(fetchFn).toHaveBeenCalledOnce();
	});

	it("applies the disabled_labels wrapper end-to-end through createScanner", async () => {
		// disabled_labels set → createScanner returns a wrapped backend. A real
		// scan must drop the disabled category while keeping the rest, proving the
		// factory wired the filter (registry.ts line: wrapWithDisabledLabels call).
		const fetchFn = vi.fn<typeof fetch>(async () =>
			jsonResponse([
				{ entity_group: "private_email", score: 0.99, word: "x@y.com", start: 0, end: 7 },
				{ entity_group: "private_url", score: 0.9, word: "src/foo.ts", start: 9, end: 19 },
			]),
		);
		vi.stubGlobal("fetch", fetchFn);
		const scanner = createScanner(
			makeConfig({
				runtime: "custom_http",
				custom_http: { endpoint: "https://synthetic.invalid/classify", timeout_ms: 4000 },
				disabled_labels: ["private_url"],
			}),
		);
		const out = await scanner?.scan({ text: "x@y.com src/foo.ts", source: "Write.content" });
		expect(out?.map((f) => f.label)).toEqual(["private_email"]);
	});
});

describe("wrapWithDisabledLabels", () => {
	const findings: ScanFinding[] = [
		{ label: "private_email", start: 0, end: 7, text: "a@b.com", source: "Write.content" },
		{ label: "private_url", start: 10, end: 25, text: "src/foo/bar.ts", source: "Write.content" },
		{
			label: "private_person",
			start: 30,
			end: 35,
			text: "Alice",
			source: "Write.content",
		},
	];

	it("returns the backend unchanged when disabledLabels is undefined", async () => {
		const { backend, scan } = makeFakeBackend(findings);
		const wrapped = wrapWithDisabledLabels(backend, undefined);
		// Identity: no wrapping work was done.
		expect(wrapped).toBe(backend);
		await wrapped.scan({ text: "x", source: "Write.content" });
		expect(scan).toHaveBeenCalledOnce();
	});

	it("returns the backend unchanged when disabledLabels is empty", async () => {
		const { backend } = makeFakeBackend(findings);
		const wrapped = wrapWithDisabledLabels(backend, []);
		expect(wrapped).toBe(backend);
	});

	it("drops findings whose label is in disabledLabels", async () => {
		const { backend } = makeFakeBackend(findings);
		const wrapped = wrapWithDisabledLabels(backend, ["private_url"]);
		const out = await wrapped.scan({ text: "x", source: "Write.content" });
		expect(out.map((f) => f.label)).toEqual(["private_email", "private_person"]);
	});

	it("drops multiple categories at once", async () => {
		const { backend } = makeFakeBackend(findings);
		const wrapped = wrapWithDisabledLabels(backend, ["private_url", "private_email"]);
		const out = await wrapped.scan({ text: "x", source: "Write.content" });
		expect(out.map((f) => f.label)).toEqual(["private_person"]);
	});

	it("preserves backend identity for ready / shutdown / status hooks", async () => {
		const { backend } = makeFakeBackend(findings);
		const wrapped = wrapWithDisabledLabels(backend, ["private_url"]);
		expect(wrapped.name).toBe(backend.name);
		expect(wrapped.runtime).toBe(backend.runtime);
		await expect(wrapped.ready()).resolves.toBe(true);
		await wrapped.shutdown();
		expect(backend.shutdown).toHaveBeenCalledOnce();
		// getStatus should pass through.
		const status = wrapped.getStatus?.();
		expect(status?.state).toBe("ready");
	});

	it("returns an empty array when every finding is disabled", async () => {
		const { backend } = makeFakeBackend(findings);
		const wrapped = wrapWithDisabledLabels(backend, [
			"private_email",
			"private_url",
			"private_person",
		]);
		const out = await wrapped.scan({ text: "x", source: "Write.content" });
		expect(out).toEqual([]);
	});
});
