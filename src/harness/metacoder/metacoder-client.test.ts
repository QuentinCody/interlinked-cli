import { describe, expect, it } from "vitest";

import {
	buildCodexExecArgs,
	callMetacoder,
	CODEX_BINARY,
	CODEX_MODEL,
	CODEX_REASONING_EFFORT,
	CODEX_REASONING_EFFORT_KEY,
	composeCodexPrompt,
	METACODER_SYSTEM_PROMPT,
	type MetacoderTransport,
	type TransportResult,
} from "./metacoder-client.js";
import type { MetacoderInputContext } from "./types.js";
import { DEFAULT_METACODER_CONFIG } from "./types.js";

const CTX: MetacoderInputContext = {
	prompt: "Refactor the payment service.",
	// "claude" here is the AgentSource runner id (not a model identifier);
	// the freshness-sensitive-reference heuristic flags it but it's stable
	// (defined in src/harness/types.ts).
	client: "claude",
	session_id: "abc12345",
	cwd: "/tmp/fake",
	overlay_prefix: "overlay:abc12345:",
	project_instructions: "# AGENTS.md\nUse TypeScript.",
	floor_rule_ids: ["block_rm_rf", "no_force_push"],
	project_graph_summary: "387 files indexed",
};

function makeFakeTransport(result: TransportResult): MetacoderTransport {
	return { call: async () => result };
}

describe("callMetacoder — successful path", () => {
	it("parses a clean JSON response", async () => {
		const transport = makeFakeTransport({
			kind: "ok",
			raw: '{"version":1,"rules":[],"system_prompt_addendum":"Stay focused."}',
		});
		const result = await callMetacoder(CTX, DEFAULT_METACODER_CONFIG, transport);
		expect(result).toEqual({
			kind: "ok",
			emission: {
				version: 1,
				rules: [],
				system_prompt_addendum: "Stay focused.",
			},
			warnings: [],
		});
	});

	it("strips ```json fenced output before parsing", async () => {
		const transport = makeFakeTransport({
			kind: "ok",
			raw: '```json\n{"version":1,"rules":[]}\n```',
		});
		const result = await callMetacoder(CTX, DEFAULT_METACODER_CONFIG, transport);
		expect(result).toMatchObject({ kind: "ok" });
	});

	it("strips unlabeled fenced output before parsing", async () => {
		const transport = makeFakeTransport({
			kind: "ok",
			raw: '```\n{"version":1,"rules":[]}\n```',
		});
		const result = await callMetacoder(CTX, DEFAULT_METACODER_CONFIG, transport);
		expect(result).toMatchObject({ kind: "ok" });
	});

	it("trims surrounding whitespace before parsing", async () => {
		const transport = makeFakeTransport({
			kind: "ok",
			raw: '   {"version":1,"rules":[]}\n\n',
		});
		const result = await callMetacoder(CTX, DEFAULT_METACODER_CONFIG, transport);
		expect(result).toMatchObject({ kind: "ok" });
	});

	it("preserves a JSON response whose addendum contains a NESTED markdown fence (P4 round 6)", async () => {
		// Plan §reviewer-P4 (round 6): the fence-stripper is anchored
		// with ^...$ so a valid JSON response whose
		// `system_prompt_addendum` happens to include an instructional
		// code fence (`` ```bash ls ``` ``) is not mangled into just
		// the inner fence body. Before the fix, the unanchored regex
		// would replace the whole response with "bash\nls\n" and
		// JSON.parse would fail.
		const validJsonWithInnerFence = JSON.stringify({
			version: 1,
			rules: [],
			system_prompt_addendum:
				"When listing files, prefer:\n```bash\nls -la\n```\nNot `find .`.",
		});
		const transport = makeFakeTransport({ kind: "ok", raw: validJsonWithInnerFence });
		const result = await callMetacoder(CTX, DEFAULT_METACODER_CONFIG, transport);
		expect(result).toMatchObject({
			kind: "ok",
			emission: expect.objectContaining({
				system_prompt_addendum: expect.stringContaining("```bash"),
			}),
		});
	});

	it("still strips a response that is entirely wrapped in a fenced block", async () => {
		const transport = makeFakeTransport({
			kind: "ok",
			raw: '```json\n{"version":1,"rules":[]}\n```',
		});
		const result = await callMetacoder(CTX, DEFAULT_METACODER_CONFIG, transport);
		expect(result).toMatchObject({ kind: "ok" });
	});

	it("does not strip a fence that is followed by trailing prose", async () => {
		// A response shape like ```json\n{...}\n```\nextra text is NOT a
		// pure fenced block — anchored regex correctly leaves it alone,
		// and the JSON parser then rejects it (failed). Pinned so a future
		// refactor doesn't accidentally relax the anchor.
		const transport = makeFakeTransport({
			kind: "ok",
			raw: '```json\n{"version":1,"rules":[]}\n```\ntrailing prose',
		});
		const result = await callMetacoder(CTX, DEFAULT_METACODER_CONFIG, transport);
		expect(result).toMatchObject({ kind: "failed" });
	});
});

describe("callMetacoder — passthroughs", () => {
	it("passes through skipped results from the transport", async () => {
		const transport = makeFakeTransport({ kind: "skipped", reason: "no_api_key" });
		const result = await callMetacoder(CTX, DEFAULT_METACODER_CONFIG, transport);
		expect(result).toEqual({ kind: "skipped", reason: "no_api_key", warnings: [] });
	});

	it("passes through failed results from the transport", async () => {
		const transport = makeFakeTransport({ kind: "failed", reason: "http 503" });
		const result = await callMetacoder(CTX, DEFAULT_METACODER_CONFIG, transport);
		expect(result).toEqual({ kind: "failed", reason: "http 503", warnings: [] });
	});

	it("treats transport throws as a failed result rather than propagating", async () => {
		const transport: MetacoderTransport = {
			call: async () => {
				throw new Error("network exploded");
			},
		};
		const result = await callMetacoder(CTX, DEFAULT_METACODER_CONFIG, transport);
		expect(result).toMatchObject({
			kind: "failed",
			reason: expect.stringMatching(/network exploded/),
		});
	});
});

describe("callMetacoder — malformed JSON", () => {
	it("returns failed on completely unparseable output", async () => {
		const transport = makeFakeTransport({ kind: "ok", raw: "not even close to json" });
		const result = await callMetacoder(CTX, DEFAULT_METACODER_CONFIG, transport);
		expect(result).toMatchObject({ kind: "failed" });
	});

	it("returns failed on a non-object root", async () => {
		const transport = makeFakeTransport({ kind: "ok", raw: "[1,2,3]" });
		const result = await callMetacoder(CTX, DEFAULT_METACODER_CONFIG, transport);
		expect(result).toMatchObject({ kind: "failed" });
	});

	it("returns failed on an empty string", async () => {
		const transport = makeFakeTransport({ kind: "ok", raw: "" });
		const result = await callMetacoder(CTX, DEFAULT_METACODER_CONFIG, transport);
		expect(result).toMatchObject({ kind: "failed" });
	});

	it("returns failed on JSON null", async () => {
		const transport = makeFakeTransport({ kind: "ok", raw: "null" });
		const result = await callMetacoder(CTX, DEFAULT_METACODER_CONFIG, transport);
		expect(result).toMatchObject({ kind: "failed" });
	});
});

describe("callMetacoder — payload assembly", () => {
	it("sends METACODER_SYSTEM_PROMPT as the system message", async () => {
		const captured: { systemPrompt?: string; userMessage?: string } = {};
		const transport: MetacoderTransport = {
			call: async (systemPrompt: string, userMessage: string) => {
				captured.systemPrompt = systemPrompt;
				captured.userMessage = userMessage;
				return { kind: "ok", raw: '{"version":1,"rules":[]}' };
			},
		};
		await callMetacoder(CTX, DEFAULT_METACODER_CONFIG, transport);
		expect(captured.systemPrompt).toBe(METACODER_SYSTEM_PROMPT);
	});

	it("sends the full MetacoderInputContext as the JSON user message", async () => {
		const captured: { userMessage?: string } = {};
		const transport: MetacoderTransport = {
			call: async (_systemPrompt: string, userMessage: string) => {
				captured.userMessage = userMessage;
				return { kind: "ok", raw: '{"version":1,"rules":[]}' };
			},
		};
		await callMetacoder(CTX, DEFAULT_METACODER_CONFIG, transport);
		const parsed = JSON.parse(captured.userMessage ?? "{}");
		expect(parsed).toMatchObject({
			prompt: CTX.prompt,
			client: CTX.client,
			session_id: CTX.session_id,
			floor_rule_ids: CTX.floor_rule_ids,
		});
	});
});

describe("Codex subprocess transport — exact CLI invocation pinned", () => {
	// Plan §2.1 + user constraint: the metacoder uses the SAME tier as
	// the coding agent AND reuses the developer's Codex CLI
	// subscription (authenticated via `codex login`) — NO OpenAI API
	// key. The reasoning_effort API value is `xhigh` (one word, no
	// hyphen) per the OpenAI developer docs (verified 2026-05).
	// Verified live by smoke-test: the `codex exec` startup banner
	// echoed back "reasoning effort: xhigh", confirming the CLI accepts
	// the `-c model_reasoning_effort=xhigh` override.
	//
	// Why hardcoded model ids appear below: pinning the EXACT model
	// identifier is the contract under test. A silent drift to a
	// different model is a behavioral regression we want this test to
	// catch. Each line is marked `REAL_WORLD_VERSION_FIXTURE_OK` per
	// `software-version-fixtures-policy.test.ts`.

	it("targets the codex CLI binary, not an HTTP endpoint", () => {
		// Earlier versions of this transport went through
		// `https://api.openai.com/...` which required an OPENAI_API_KEY.
		// The user explicitly required the subscription-auth path (no
		// API keys). Pinned so a future refactor can't silently revert.
		expect(CODEX_BINARY).toBe("codex");
	});

	it("targets the documented CODEX_MODEL identifier", () => {
		// Pinning the exact model id is the behavior under test —
		// silent drift to another model is the regression we want to catch.
		// REAL_WORLD_VERSION_FIXTURE_OK: source = OpenAI developer docs.
		expect(CODEX_MODEL).toBe("gpt-5.5");
	});

	it("uses xhigh reasoning effort (maximum tier, not 'high')", () => {
		// The user's design intent is the maximum tier. `xhigh` is the
		// real API value; `high` would silently downgrade to the second-
		// highest tier and the metacoder would have less reasoning budget
		// than the coding agent.
		expect(CODEX_REASONING_EFFORT).toBe("xhigh");
		expect(CODEX_REASONING_EFFORT).not.toBe("high");
	});

	it("uses the model_reasoning_effort config key", () => {
		// `codex exec -c <key>=<value>` parses TOML. Key path verified
		// live (smoke-test printed "reasoning effort: xhigh" header).
		expect(CODEX_REASONING_EFFORT_KEY).toBe("model_reasoning_effort");
	});

	it("buildCodexExecArgs includes -m for the model and the xhigh effort override", () => {
		const args = buildCodexExecArgs("the prompt", "/tmp/out.txt");
		expect(args[0]).toBe("exec");
		const modelIdx = args.indexOf("-m");
		expect(modelIdx).toBeGreaterThan(-1);
		// REAL_WORLD_VERSION_FIXTURE_OK: model id is the contract under test.
		expect(args[modelIdx + 1]).toBe("gpt-5.5");
		expect(args).toContain("model_reasoning_effort=xhigh");
	});

	it("buildCodexExecArgs requests ephemeral, sandboxed, config-isolated execution", () => {
		// Plan §reviewer-P4 (round 5) + cross-process hygiene: the
		// metacoder subprocess must not pollute global state. `--ephemeral`
		// skips session persistence; `--ignore-user-config` skips loading
		// `~/.codex/config.toml` (which could pull in MCP servers); the
		// `read-only` sandbox bars shell command execution since the
		// metacoder only emits JSON.
		const args = buildCodexExecArgs("p", "/tmp/o.txt");
		expect(args).toContain("--ephemeral");
		expect(args).toContain("--ignore-user-config");
		expect(args).toContain("--skip-git-repo-check");
		const sandboxIdx = args.indexOf("--sandbox");
		expect(sandboxIdx).toBeGreaterThan(-1);
		expect(args[sandboxIdx + 1]).toBe("read-only");
	});

	it("buildCodexExecArgs writes the final assistant message to the given -o path", () => {
		const args = buildCodexExecArgs("p", "/tmp/out.txt");
		const outIdx = args.indexOf("-o");
		expect(outIdx).toBeGreaterThan(-1);
		expect(args[outIdx + 1]).toBe("/tmp/out.txt");
	});

	it("buildCodexExecArgs places the prompt as the final positional argument", () => {
		const args = buildCodexExecArgs("the prompt", "/tmp/o.txt");
		expect(args[args.length - 1]).toBe("the prompt");
	});

	it("composeCodexPrompt prepends the system prompt with a clear delimiter", () => {
		// `codex exec` has no `--system-prompt` flag, so the system
		// instructions are prepended to the user message. The metacoder
		// system prompt already starts with "You are a session-scoped
		// policy author..." so the model still gets unambiguous role
		// context.
		const composed = composeCodexPrompt(METACODER_SYSTEM_PROMPT, "the user prompt");
		expect(composed).toContain(METACODER_SYSTEM_PROMPT);
		expect(composed).toContain("the user prompt");
		expect(composed.indexOf(METACODER_SYSTEM_PROMPT)).toBeLessThan(
			composed.indexOf("the user prompt"),
		);
		expect(composed).toContain("\n\n---\n\n");
	});
});

describe("METACODER_SYSTEM_PROMPT", () => {
	it("communicates the action-block-only constraint", () => {
		expect(METACODER_SYSTEM_PROMPT).toMatch(/block/i);
	});

	it("communicates the overlay id prefix requirement", () => {
		expect(METACODER_SYSTEM_PROMPT).toMatch(/overlay:/);
	});

	it("forbids relaxing floor rules", () => {
		expect(METACODER_SYSTEM_PROMPT).toMatch(/disable|loosen|relax/i);
	});

	it("constrains regex flags", () => {
		expect(METACODER_SYSTEM_PROMPT).toMatch(/flag/i);
	});
});
