// ===========================================
// Metacoder — LLM client
// ===========================================
// Routes the metacoder call to the right transport based on `ctx.client`:
//
//   - claude: spawn `claude -p` with Opus 4.7 + maximum reasoning effort.
//             Uses the user's Claude Code subscription via the CLI's own
//             auth — no Anthropic API key required.
//   - codex:  spawn `codex exec` with gpt-5.5 + `model_reasoning_effort=xhigh`.
//             Uses the user's Codex CLI subscription via `codex login` —
//             no OpenAI API key required.
//   - other:  skipped — runners outside the v1 scope.
//
// Both paths set `INTERLINKED_METACODER_SUBPROCESS=1` in the spawned
// process env so the recursion guard short-circuits any nested
// UserPromptSubmit the subprocess fires (plan §2.5).
//
// `callMetacoder` is the orchestrator. Transports are dependency-injected
// so tests can supply fakes without spawning real subprocesses. Default
// transports are built by `buildDefaultTransport(client)`.

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import type { AgentSource } from "../types.js";
import type {
	MetacoderConfig,
	MetacoderInputContext,
	OverlayRulesEmission,
	SkippedReason,
} from "./types.js";

// ============================================================================
// Named string literals (replace magic strings in conditionals)
// ============================================================================

const KIND_OK = "ok" as const;
const KIND_SKIPPED = "skipped" as const;
const KIND_FAILED = "failed" as const;

const CLIENT_CLAUDE: AgentSource = "claude";
const CLIENT_CODEX: AgentSource = "codex";

const ENOENT_CODE = "ENOENT" as const;

/** Type returned by `spawn` when `stdio: ["ignore", "pipe", "pipe"]`. */
type SpawnedSubprocess = ChildProcessByStdio<null, Readable, Readable>;

// ============================================================================
// System prompt (constant)
// ============================================================================

/** Public API — also asserted by the metacoder-client test, so changes here
 *  show up in `git diff` review. Plan §6: the contract the LLM must follow
 *  when emitting an overlay. */
export const METACODER_SYSTEM_PROMPT = `You are a session-scoped policy author for an AI coding agent.

You receive: a user prompt (possibly with PII redacted as <LABEL> placeholders),
project AGENTS.md/CLAUDE.md guidance, current floor rule ids, a project graph
summary, and \`overlay_prefix\` — the EXACT string every overlay rule id must
start with.

You emit JSON matching the OverlayRulesFile schema. You may ONLY:
1. Add new GuardRule entries whose \`id\` starts with the literal value of
   \`overlay_prefix\` from your input. Copy it byte-for-byte; do not
   re-derive it from \`session_id\`. Example: if
   \`overlay_prefix\` is \`overlay:abc12345-def:\`, then valid ids are
   \`overlay:abc12345-def:0\`, \`overlay:abc12345-def:1\`, etc.
2. Use action: "block" on every rule (other actions are rejected by the loader)
3. Express exceptions using \`negate: true\` patterns inside your own rule's
   \`patterns\` array
4. Add a free-form system_prompt_addendum (≤2000 chars)

Regex patterns you emit must:
- Be ≤200 chars long
- Use only flags i, m, s (no g, y, u)
- Avoid nested unbounded quantifiers like (a+)+ or (a*)*

You MUST NOT:
- Reference, disable, or modify any floor rule id (provided in input)
- Author a rule with any action other than "block"
- Emit top-level extra_exceptions or additional_patterns fields
- Create rules that loosen anything
- Invent your own prefix — use \`overlay_prefix\` verbatim

If the prompt warrants no extra constraints, return {"version":1,"rules":[]}.
Respond with JSON only, no preamble, no markdown fences.`;

// ============================================================================
// Transport contract
// ============================================================================

/** Transport's view of a single call. The transport returns the model's raw
 *  text output (which `callMetacoder` then parses), or surfaces a skipped /
 *  failed state without raising. */
export type TransportResult =
	| { kind: typeof KIND_OK; raw: string }
	| { kind: typeof KIND_SKIPPED; reason: SkippedReason }
	| { kind: typeof KIND_FAILED; reason: string };

/** Transport interface — single method. Injected into `callMetacoder` so the
 *  orchestrator is testable without spawning real subprocesses or hitting
 *  the network. */
export interface MetacoderTransport {
	call(systemPrompt: string, userMessage: string, config: MetacoderConfig): Promise<TransportResult>;
}

/** Result of `callMetacoder`. On `ok`, `emission` is the parsed JSON
 *  matching `OverlayRulesEmission`. The overlay-loader is what validates
 *  the emission against the tighten-only invariant — the client only
 *  enforces that the output is JSON of the right shape at the top level. */
export type MetacoderCallResult =
	| { kind: typeof KIND_OK; emission: OverlayRulesEmission; warnings: string[] }
	| { kind: typeof KIND_SKIPPED; reason: SkippedReason; warnings: string[] }
	| { kind: typeof KIND_FAILED; reason: string; warnings: string[] };

// ============================================================================
// Orchestrator
// ============================================================================

/** Public API — consumed by `runMetacoderForPrompt` in the barrel.
 *  Sends the system prompt + JSON-stringified context to the transport,
 *  parses the response, returns a structured result. Never throws. */
export async function callMetacoder(
	ctx: MetacoderInputContext,
	config: MetacoderConfig,
	transport: MetacoderTransport,
): Promise<MetacoderCallResult> {
	const userMessage = JSON.stringify(ctx);
	const warnings: string[] = [];

	let raw: TransportResult;
	try {
		raw = await transport.call(METACODER_SYSTEM_PROMPT, userMessage, config);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { kind: KIND_FAILED, reason: `transport threw: ${message}`, warnings };
	}

	if (raw.kind === KIND_SKIPPED) return { kind: KIND_SKIPPED, reason: raw.reason, warnings };
	if (raw.kind === KIND_FAILED) return { kind: KIND_FAILED, reason: raw.reason, warnings };

	const parsed = tryParseEmissionJson(raw.raw);
	if (parsed === null) {
		return { kind: KIND_FAILED, reason: "metacoder output was not parseable JSON", warnings };
	}
	return { kind: KIND_OK, emission: parsed, warnings };
}

// ============================================================================
// JSON parsing
// ============================================================================

function tryParseEmissionJson(text: string): OverlayRulesEmission | null {
	if (typeof text !== "string") return null;
	const cleaned = stripMarkdownFences(text.trim());
	if (cleaned.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned);
	} catch (err) {
		void err;
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	return parsed as OverlayRulesEmission;
}

/** Strip ```json … ``` fences only when the ENTIRE trimmed response is
 *  one fenced block. Anchored with ^ + $ so a valid JSON response whose
 *  `system_prompt_addendum` field contains a nested Markdown fence (e.g.
 *  instructions containing ```bash …```) is not mangled into just the
 *  inner fence body. Plan §reviewer-P4 (round 6). */
function stripMarkdownFences(text: string): string {
	const trimmed = text.trim();
	const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
	return fence ? fence[1].trim() : trimmed;
}

// ============================================================================
// Default transports
// ============================================================================

/** Public API — consumed by `runMetacoderForPrompt`. Build the default
 *  transport for a given runner. Both Claude and Codex paths use the
 *  user's existing CLI subscription — NO API keys required. Plan §2.1. */
export function buildDefaultTransport(client: AgentSource): MetacoderTransport {
	if (client === CLIENT_CLAUDE) return buildClaudeSubprocessTransport();
	if (client === CLIENT_CODEX) return buildCodexSubprocessTransport();
	return buildDisabledTransport();
}

function buildDisabledTransport(): MetacoderTransport {
	return {
		call: async () => ({ kind: KIND_SKIPPED, reason: "disabled" }),
	};
}

// ============================================================================
// Claude subprocess transport
// ============================================================================
//
// Spawns `claude -p` against the user's Claude Code subscription. No API
// key required. Model identifiers below are referenced by plan §2.1
// "Metacoder model: same tier as the coding agent" — drift requires a
// coordinated update with the user-facing docs.

const CLAUDE_BINARY = "claude";
const CLAUDE_MODEL = "claude-opus-4-7";
const CLAUDE_EFFORT = "high";
const CLAUDE_DISALLOWED_TOOLS = "Bash,Edit,Write,Read,Glob,Grep,Agent,WebFetch,WebSearch";
const RECURSION_GUARD_ENV = "INTERLINKED_METACODER_SUBPROCESS";

function buildClaudeSubprocessTransport(): MetacoderTransport {
	return {
		call: (systemPrompt, userMessage, config) =>
			runClaudeSubprocess(systemPrompt, userMessage, config),
	};
}

function runClaudeSubprocess(
	systemPrompt: string,
	userMessage: string,
	config: MetacoderConfig,
): Promise<TransportResult> {
	return new Promise<TransportResult>((resolve) => {
		const child = spawn(
			CLAUDE_BINARY,
			[
				"-p",
				"--model",
				CLAUDE_MODEL,
				"--no-session-persistence",
				"--disallowed-tools",
				CLAUDE_DISALLOWED_TOOLS,
				"--effort",
				CLAUDE_EFFORT,
				"--output-format",
				"json",
				"--system-prompt",
				systemPrompt,
				userMessage,
			],
			{
				stdio: ["ignore", "pipe", "pipe"],
				timeout: config.timeout_ms,
				env: { ...process.env, [RECURSION_GUARD_ENV]: "1" },
			},
		);
		bindClaudeStreamHandlers(child, resolve);
	});
}

function bindClaudeStreamHandlers(
	child: SpawnedSubprocess,
	resolve: (r: TransportResult) => void,
): void {
	let stdout = "";
	child.stdout.on("data", (d: Buffer) => {
		stdout += d.toString();
	});
	child.on("close", (code) => {
		if (code !== 0) {
			resolve({ kind: KIND_FAILED, reason: `claude -p exit ${code}` });
			return;
		}
		resolve({ kind: KIND_OK, raw: extractClaudeResult(stdout.trim()) });
	});
	child.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === ENOENT_CODE) {
			resolve({ kind: KIND_SKIPPED, reason: "subprocess_not_found" });
			return;
		}
		resolve({ kind: KIND_FAILED, reason: `claude -p spawn: ${err.message}` });
	});
}

/** `claude -p --output-format json` wraps the model output in
 *  `{"result": "..."}`. Unwrap when present so the orchestrator's JSON
 *  parser sees the model's own response. Falls through to the raw stdout
 *  when the wrapper shape isn't there (older `claude` versions / errors). */
function extractClaudeResult(stdout: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (err) {
		void err;
		return stdout;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return stdout;
	const result = (parsed as { result?: unknown }).result;
	return typeof result === "string" ? result : stdout;
}

// ============================================================================
// Codex subprocess transport
// ============================================================================
//
// Spawns `codex exec` against the user's Codex CLI subscription
// (authenticated via `codex login`). NO OpenAI API key required — per the
// design intent that the metacoder reuses the developer's existing
// subscription rather than draw against a separate API account.
//
// reasoning_effort for GPT-5.5 is `none|low|medium|high|xhigh` per
// https://developers.openai.com/api/docs/models/gpt-5.5 (verified
// 2026-05). The user said "x-high" colloquially; this resolves to the
// API-correct `xhigh` (one word, no hyphen). Verified live by smoke-
// testing `codex exec -c model_reasoning_effort=xhigh` — the CLI's
// startup banner echoed back "reasoning effort: xhigh".

/** Public — pinned by tests so silent drift in model / effort / binary
 *  shows up in `git diff` review. Plan §2.1. */
export const CODEX_BINARY = "codex";
export const CODEX_MODEL = "gpt-5.5";
export const CODEX_REASONING_EFFORT = "xhigh";
/** Codex CLI config key for reasoning effort. Passed via `-c key=value`. */
export const CODEX_REASONING_EFFORT_KEY = "model_reasoning_effort";

function buildCodexSubprocessTransport(): MetacoderTransport {
	return {
		call: (systemPrompt, userMessage, config) =>
			runCodexSubprocess(systemPrompt, userMessage, config),
	};
}

/** Public — exposed for testability. Pure function. Returns the exact
 *  argv that gets passed to `spawn(CODEX_BINARY, args)`. Tests pin this
 *  so a refactor can't silently drop the model / effort / sandbox /
 *  ephemeral flags. */
export function buildCodexExecArgs(prompt: string, outputPath: string): string[] {
	return [
		"exec",
		"-m",
		CODEX_MODEL,
		"-c",
		`${CODEX_REASONING_EFFORT_KEY}=${CODEX_REASONING_EFFORT}`,
		"--skip-git-repo-check",
		"--ephemeral",
		// `--ignore-user-config` prevents the spawned subprocess from
		// loading `~/.codex/config.toml`, which could include MCP servers
		// or other side-effecty config that bleed into the metacoder run.
		"--ignore-user-config",
		// Metacoder never executes shell commands — it emits JSON.
		// `read-only` is the tightest sandbox the CLI offers.
		"--sandbox",
		"read-only",
		"-o",
		outputPath,
		prompt,
	];
}

/** Compose the single prompt string fed to `codex exec`. The CLI has no
 *  `--system-prompt` flag, so we prepend the metacoder system prompt to
 *  the user message with a `---` delimiter. The system prompt already
 *  starts with "You are a session-scoped policy author..." so the model
 *  has unambiguous role context. */
export function composeCodexPrompt(systemPrompt: string, userMessage: string): string {
	return `${systemPrompt}\n\n---\n\n${userMessage}`;
}

function runCodexSubprocess(
	systemPrompt: string,
	userMessage: string,
	config: MetacoderConfig,
): Promise<TransportResult> {
	return new Promise<TransportResult>((resolve) => {
		const outputPath = join(
			tmpdir(),
			`metacoder-codex-${process.pid}-${Date.now().toString(36)}.txt`,
		);
		const args = buildCodexExecArgs(composeCodexPrompt(systemPrompt, userMessage), outputPath);
		let stderrBuf = "";
		const child = spawn(CODEX_BINARY, args, {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: config.timeout_ms,
			env: { ...process.env, [RECURSION_GUARD_ENV]: "1" },
		});
		// codex exec streams progress events on stdout; we ignore them —
		// the final assistant message is written to `outputPath` via `-o`.
		// Draining the pipe so the child doesn't block on backpressure.
		child.stdout.on("data", () => undefined);
		child.stderr.on("data", (d: Buffer) => {
			stderrBuf += d.toString();
		});
		child.on("close", (code) => {
			if (code !== 0) {
				resolve({ kind: KIND_FAILED, reason: classifyCodexExitFailure(code, stderrBuf) });
				cleanupTempFile(outputPath);
				return;
			}
			if (!existsSync(outputPath)) {
				resolve({
					kind: KIND_FAILED,
					reason: "codex exec finished but no output file written",
				});
				return;
			}
			let raw: string;
			try {
				raw = readFileSync(outputPath, "utf-8");
			} catch (err) {
				resolve({
					kind: KIND_FAILED,
					reason: `codex output read: ${err instanceof Error ? err.message : String(err)}`,
				});
				cleanupTempFile(outputPath);
				return;
			}
			cleanupTempFile(outputPath);
			resolve({ kind: KIND_OK, raw });
		});
		child.on("error", (err: NodeJS.ErrnoException) => {
			cleanupTempFile(outputPath);
			if (err.code === ENOENT_CODE) {
				// CLI not installed — the user has Claude Code but no
				// Codex subscription, or vice versa. Fail-open: the agent
				// runs against floor rules only.
				resolve({ kind: KIND_SKIPPED, reason: "subprocess_not_found" });
				return;
			}
			resolve({ kind: KIND_FAILED, reason: `codex exec spawn: ${err.message}` });
		});
	});
}

/** Map a non-zero `codex exec` exit into a human-readable reason. The
 *  most common modes worth distinguishing:
 *    - hit subscription usage limit → user-visible / actionable
 *    - login expired / not signed in → also actionable
 *    - everything else → generic failure with stderr tail for forensics */
function classifyCodexExitFailure(code: number | null, stderr: string): string {
	const tail = stderr.slice(-400).trim();
	if (/usage limit/i.test(stderr)) {
		return `codex usage limit reached (subscription); upgrade or wait for reset: ${tail}`;
	}
	if (/not (logged|signed) in|run.*codex login/i.test(stderr)) {
		return `codex not logged in; run 'codex login' to authenticate the subscription`;
	}
	return `codex exec exit ${code}${tail ? `: ${tail}` : ""}`;
}

function cleanupTempFile(path: string): void {
	try {
		if (existsSync(path)) unlinkSync(path);
	} catch (err) {
		// best-effort; tmp files age out anyway
		void err;
	}
}
