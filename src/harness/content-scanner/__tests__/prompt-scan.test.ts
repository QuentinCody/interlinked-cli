import { describe, expect, it } from "vitest";
import { scanUserPrompt } from "../prompt-scan.js";
import type { ContentScanner, ContentScannerConfig, ScanFinding } from "../types.js";

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
		huggingface: { model: "m", api_key_env: "HF_TOKEN", timeout_ms: 4000 },
		custom_http: { endpoint: "", timeout_ms: 4000 },
		min_score: 0,
		max_scan_bytes: 100_000,
		...overrides,
	};
}

function makeRules(cfg: ContentScannerConfig): Parameters<typeof scanUserPrompt>[1] {
	return { content_scanner: cfg };
}

function makeScanner(findings: ScanFinding[]): ContentScanner {
	return {
		name: "stub",
		runtime: "local",
		ready: async () => true,
		scan: async () => findings,
		shutdown: async () => {},
	};
}

describe("scanUserPrompt", () => {
	it("returns undefined when scanner is undefined", async () => {
		const rules = makeRules(makeConfig());
		const result = await scanUserPrompt("hello world", rules, undefined);
		expect(result).toBeUndefined();
	});

	it("returns undefined when content_scanner.enabled is false", async () => {
		const rules = makeRules(makeConfig({ enabled: false }));
		const scanner = makeScanner([]);
		const result = await scanUserPrompt("hello world", rules, scanner);
		expect(result).toBeUndefined();
	});

	it("returns undefined when scan_points.user_prompt is false", async () => {
		const cfg = makeConfig();
		cfg.scan_points.user_prompt = false;
		const scanner = makeScanner([
			{ label: "private_email", start: 6, end: 23, text: "a@example.com", source: "x" },
		]);
		const result = await scanUserPrompt("email a@example.com", makeRules(cfg), scanner);
		expect(result).toBeUndefined();
	});

	it("returns undefined when prompt is empty", async () => {
		const scanner = makeScanner([
			{ label: "private_email", start: 0, end: 10, text: "x", source: "x" },
		]);
		const result = await scanUserPrompt("", makeRules(makeConfig()), scanner);
		expect(result).toBeUndefined();
	});

	it("returns undefined when scanner emits no findings", async () => {
		const scanner = makeScanner([]);
		const result = await scanUserPrompt("just a normal prompt", makeRules(makeConfig()), scanner);
		expect(result).toBeUndefined();
	});

	it("masks detected spans with <LABEL> placeholders", async () => {
		const prompt = "email me at quentin@example.com please";
		const scanner = makeScanner([
			{
				label: "private_email",
				start: 12,
				end: 31,
				text: "quentin@example.com",
				source: "UserPromptSubmit.prompt",
			},
		]);
		const result = await scanUserPrompt(prompt, makeRules(makeConfig()), scanner);
		expect(result).toBeDefined();
		expect(result?.redacted).toBe("email me at <PRIVATE_EMAIL> please");
		expect(result?.findings).toHaveLength(1);
	});

	it("masks multiple spans without corrupting earlier indices", async () => {
		const prompt = "alice@example.com and bob@example.com";
		const scanner = makeScanner([
			{ label: "private_email", start: 0, end: 17, text: "alice@example.com", source: "x" },
			{ label: "private_email", start: 22, end: 37, text: "bob@example.com", source: "x" },
		]);
		const result = await scanUserPrompt(prompt, makeRules(makeConfig()), scanner);
		expect(result?.redacted).toBe("<PRIVATE_EMAIL> and <PRIVATE_EMAIL>");
	});

	it("fails open when scanner.scan throws", async () => {
		const scanner: ContentScanner = {
			name: "explosive",
			runtime: "local",
			ready: async () => true,
			scan: async () => {
				throw new Error("sidecar crash");
			},
			shutdown: async () => {},
		};
		const result = await scanUserPrompt("anything", makeRules(makeConfig()), scanner);
		expect(result).toBeUndefined();
	});

	it("drops findings that fall below min_score", async () => {
		const scanner = makeScanner([
			{ label: "private_email", start: 0, end: 5, text: "abcde", source: "x", score: 0.1 },
		]);
		const cfg = makeConfig({ min_score: 0.5 });
		const result = await scanUserPrompt("abcde more", makeRules(cfg), scanner);
		expect(result).toBeUndefined();
	});

	it("does not mask spans past max_scan_bytes (tail remains unmasked)", async () => {
		const prompt = "x".repeat(50) + "secret@example.com" + "y".repeat(50);
		const cfg = makeConfig({ max_scan_bytes: 40 });
		const scanner = makeScanner([]);
		const result = await scanUserPrompt(prompt, makeRules(cfg), scanner);
		expect(result).toBeUndefined();
	});
});
