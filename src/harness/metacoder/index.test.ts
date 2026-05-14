import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMetacoderForPrompt } from "./index.js";
import type { MetacoderTransport, TransportResult } from "./metacoder-client.js";
import { overlayIdPrefix } from "./overlay-loader.js";
import { DEFAULT_METACODER_CONFIG, type OverlayRulesFile } from "./types.js";

const SESSION = "barrel-session-abc12345";
const FLOOR_RULE_IDS = ["block_rm_rf", "no_force_push"];
const FROZEN_NOW = "2026-05-13T14:00:00.000Z";
const frozenClock = (): string => FROZEN_NOW;

function makeTransport(result: TransportResult): MetacoderTransport {
	return { call: async () => result };
}

function emissionRule(): unknown {
	return {
		id: `${overlayIdPrefix(SESSION)}0`,
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Edit"],
		action: "block",
		patterns: [{ field: "file_path", regex: "src/legacy/" }],
		reason: "Out of scope.",
		severity: "high",
	};
}

function makeOverlayRawEmission(): string {
	return JSON.stringify({
		version: 1,
		rules: [emissionRule()],
		system_prompt_addendum: "Stay focused.",
	});
}

function readOverlay(cwd: string): OverlayRulesFile {
	const overlayPath = join(cwd, ".interlinked", "sessions", SESSION, "overlay-rules.json");
	return JSON.parse(readFileSync(overlayPath, "utf-8")) as OverlayRulesFile;
}

function freshCwd(): string {
	return mkdtempSync(join(tmpdir(), "metacoder-barrel-"));
}

describe("runMetacoderForPrompt — disk artifacts", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = freshCwd();
	});

	it("writes overlay-rules.json on the happy path", async () => {
		const transport = makeTransport({ kind: "ok", raw: makeOverlayRawEmission() });
		const result = await runMetacoderForPrompt({
			cwd,
			sessionId: SESSION,
			client: "claude",
			prompt: "Refactor the payment service.",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport,
		});
		expect(result).toMatchObject({ kind: "ok" });
		const overlayPath = join(cwd, ".interlinked", "sessions", SESSION, "overlay-rules.json");
		expect(existsSync(overlayPath)).toBe(true);
	});

	it("sets generated_by to 'metacoder' on the persisted overlay", async () => {
		const transport = makeTransport({ kind: "ok", raw: makeOverlayRawEmission() });
		await runMetacoderForPrompt({
			cwd,
			sessionId: SESSION,
			client: "claude",
			prompt: "p",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport,
		});
		expect(readOverlay(cwd).generated_by).toBe("metacoder");
	});

	it("uses the injected clock for generated_at", async () => {
		const transport = makeTransport({ kind: "ok", raw: makeOverlayRawEmission() });
		await runMetacoderForPrompt({
			cwd,
			sessionId: SESSION,
			client: "claude",
			prompt: "p",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport,
			now: frozenClock,
		});
		expect(readOverlay(cwd).generated_at).toBe(FROZEN_NOW);
	});

	it("stamps the session id on the persisted overlay", async () => {
		const transport = makeTransport({ kind: "ok", raw: makeOverlayRawEmission() });
		await runMetacoderForPrompt({
			cwd,
			sessionId: SESSION,
			client: "claude",
			prompt: "p",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport,
		});
		expect(readOverlay(cwd).session_id).toBe(SESSION);
	});

	it("propagates surviving overlay rules to disk", async () => {
		const transport = makeTransport({ kind: "ok", raw: makeOverlayRawEmission() });
		await runMetacoderForPrompt({
			cwd,
			sessionId: SESSION,
			client: "claude",
			prompt: "p",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport,
		});
		expect(readOverlay(cwd).rules).toHaveLength(1);
	});
});

describe("runMetacoderForPrompt — source_prompt_sha256", () => {
	it("hashes the prompt input as hex", async () => {
		const cwd = freshCwd();
		const transport = makeTransport({ kind: "ok", raw: makeOverlayRawEmission() });
		const result = await runMetacoderForPrompt({
			cwd,
			sessionId: SESSION,
			client: "claude",
			prompt: "Refactor.",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport,
		});
		expect(result).toMatchObject({
			kind: "ok",
			overlay: expect.objectContaining({
				source_prompt_sha256: expect.stringMatching(/^[0-9a-f]+$/),
			}),
		});
	});

	it("produces different hashes for different prompts", async () => {
		const transport = makeTransport({ kind: "ok", raw: makeOverlayRawEmission() });
		const a = await runMetacoderForPrompt({
			cwd: freshCwd(),
			sessionId: SESSION,
			client: "claude",
			prompt: "First prompt.",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport,
		});
		const b = await runMetacoderForPrompt({
			cwd: freshCwd(),
			sessionId: SESSION,
			client: "claude",
			prompt: "Second different prompt.",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport,
		});
		const okA = a as Extract<typeof a, { kind: "ok" }>;
		const okB = b as Extract<typeof b, { kind: "ok" }>;
		expect(okA.overlay.source_prompt_sha256).not.toBe(okB.overlay.source_prompt_sha256);
	});
});

describe("runMetacoderForPrompt — system_prompt_addendum on outcome", () => {
	it("returns the addendum on the ok outcome", async () => {
		const transport = makeTransport({
			kind: "ok",
			raw: JSON.stringify({
				version: 1,
				rules: [],
				system_prompt_addendum: "Stay focused.",
			}),
		});
		const result = await runMetacoderForPrompt({
			cwd: freshCwd(),
			sessionId: SESSION,
			client: "claude",
			prompt: "Refactor.",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport,
		});
		expect(result).toMatchObject({
			kind: "ok",
			overlay: expect.objectContaining({ system_prompt_addendum: "Stay focused." }),
		});
	});
});

describe("runMetacoderForPrompt — replace semantics (multi-prompt sessions)", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "metacoder-replace-"));
	});

	it("the second prompt's overlay file replaces the first prompt's", async () => {
		const transportFirst = makeTransport({
			kind: "ok",
			raw: JSON.stringify({
				version: 1,
				rules: [emissionRule()],
				system_prompt_addendum: "Focus on payments.",
			}),
		});
		const transportSecond = makeTransport({
			kind: "ok",
			raw: JSON.stringify({
				version: 1,
				rules: [],
				system_prompt_addendum: "Focus on auth.",
			}),
		});
		await runMetacoderForPrompt({
			cwd,
			sessionId: SESSION,
			client: "claude",
			prompt: "First.",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport: transportFirst,
		});
		await runMetacoderForPrompt({
			cwd,
			sessionId: SESSION,
			client: "claude",
			prompt: "Second.",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport: transportSecond,
		});
		expect(readOverlay(cwd).system_prompt_addendum).toBe("Focus on auth.");
	});

	it("the second prompt's rule set replaces the first prompt's", async () => {
		const transportFirst = makeTransport({
			kind: "ok",
			raw: JSON.stringify({ version: 1, rules: [emissionRule()] }),
		});
		const transportSecond = makeTransport({
			kind: "ok",
			raw: JSON.stringify({
				version: 1,
				rules: [],
				system_prompt_addendum: "no rules now",
			}),
		});
		await runMetacoderForPrompt({
			cwd,
			sessionId: SESSION,
			client: "claude",
			prompt: "First.",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport: transportFirst,
		});
		await runMetacoderForPrompt({
			cwd,
			sessionId: SESSION,
			client: "claude",
			prompt: "Second.",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport: transportSecond,
		});
		expect(readOverlay(cwd).rules).toHaveLength(0);
	});
});

describe("runMetacoderForPrompt — fail-open paths", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "metacoder-fail-"));
	});

	it("returns skipped when the transport reports no_api_key", async () => {
		const transport = makeTransport({ kind: "skipped", reason: "no_api_key" });
		const result = await runMetacoderForPrompt({
			cwd,
			sessionId: SESSION,
			client: "codex",
			prompt: "p",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport,
		});
		expect(result).toMatchObject({ kind: "skipped", reason: "no_api_key" });
	});

	it("does not write an overlay when the transport reports no_api_key", async () => {
		const transport = makeTransport({ kind: "skipped", reason: "no_api_key" });
		await runMetacoderForPrompt({
			cwd,
			sessionId: SESSION,
			client: "codex",
			prompt: "p",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport,
		});
		const overlayPath = join(cwd, ".interlinked", "sessions", SESSION, "overlay-rules.json");
		expect(existsSync(overlayPath)).toBe(false);
	});

	it("returns failed when the transport returns malformed JSON", async () => {
		const transport = makeTransport({ kind: "ok", raw: "not json at all" });
		const result = await runMetacoderForPrompt({
			cwd,
			sessionId: SESSION,
			client: "claude",
			prompt: "p",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport,
		});
		expect(result).toMatchObject({ kind: "failed" });
	});

	it("returns failed when the transport throws", async () => {
		const transport: MetacoderTransport = {
			call: async () => {
				throw new Error("simulated network outage");
			},
		};
		const result = await runMetacoderForPrompt({
			cwd,
			sessionId: SESSION,
			client: "claude",
			prompt: "p",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport,
		});
		expect(result).toMatchObject({ kind: "failed" });
	});

	it("returns skipped:empty_overlay when validation drops every rule and there is no addendum", async () => {
		const transport = makeTransport({
			kind: "ok",
			raw: JSON.stringify({ version: 1, rules: [] }),
		});
		const result = await runMetacoderForPrompt({
			cwd,
			sessionId: SESSION,
			client: "claude",
			prompt: "p",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport,
		});
		expect(result).toMatchObject({ kind: "skipped", reason: "empty_overlay" });
	});

	it("does not persist an empty overlay", async () => {
		const transport = makeTransport({
			kind: "ok",
			raw: JSON.stringify({ version: 1, rules: [] }),
		});
		await runMetacoderForPrompt({
			cwd,
			sessionId: SESSION,
			client: "claude",
			prompt: "p",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport,
		});
		const overlayPath = join(cwd, ".interlinked", "sessions", SESSION, "overlay-rules.json");
		expect(existsSync(overlayPath)).toBe(false);
	});

	it("returns skipped:no_prompt on an empty input prompt", async () => {
		const transport = makeTransport({ kind: "ok", raw: makeOverlayRawEmission() });
		const result = await runMetacoderForPrompt({
			cwd,
			sessionId: SESSION,
			client: "claude",
			prompt: "",
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
			transport,
		});
		expect(result).toMatchObject({ kind: "skipped", reason: "no_prompt" });
	});

	it("returns skipped:disabled when config.enabled is false", async () => {
		const transport = makeTransport({ kind: "ok", raw: makeOverlayRawEmission() });
		const result = await runMetacoderForPrompt({
			cwd,
			sessionId: SESSION,
			client: "claude",
			prompt: "p",
			floorRuleIds: FLOOR_RULE_IDS,
			config: { ...DEFAULT_METACODER_CONFIG, enabled: false },
			transport,
		});
		expect(result).toMatchObject({ kind: "skipped", reason: "disabled" });
	});
});
