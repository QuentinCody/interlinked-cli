// ===========================================
// Metacoder — orchestrator entry point
// ===========================================
// Single function the harness server calls from its UserPromptSubmit
// handler. Composes the four metacoder pieces:
//
//   1. prompt-builder    → MetacoderInputContext (reads AGENTS.md etc.)
//   2. metacoder-client  → calls the LLM via injected transport
//   3. overlay-loader    → validates the emission against floor / tighten-only
//   4. metacoder-writer  → atomic persistence to .interlinked/sessions/<sid>/
//
// Every disk and network failure surfaces as a typed `MetacoderOutcome` so
// the server can fall back to floor-only without blowing up the prompt.

import { createHash } from "node:crypto";

import type { AgentSource } from "../types.js";
import { buildDefaultTransport, callMetacoder, type MetacoderTransport } from "./metacoder-client.js";
import { writeOverlayArtifacts } from "./metacoder-writer.js";
import { buildMetacoderContext } from "./prompt-builder.js";
import { validateOverlayEmission } from "./overlay-loader.js";
import type { MetacoderConfig, MetacoderOutcome, OverlayRulesFile } from "./types.js";

export interface RunMetacoderInput {
	cwd: string;
	sessionId: string;
	client: AgentSource;
	/** Prompt passed to the metacoder. Caller (server.ts) is responsible for
	 *  using the scanner-redacted version when the PII scanner fires; this
	 *  layer never sees the raw event.prompt. */
	prompt: string;
	floorRuleIds: string[];
	config: MetacoderConfig;
	/** Optional transport injection. Production callers omit this and get the
	 *  default routing per `ctx.client`. Tests supply fakes to avoid spawning
	 *  real subprocesses / hitting the network. */
	transport?: MetacoderTransport;
	/** Optional clock injection. Production callers omit this and get
	 *  `new Date().toISOString()`. Tests supply a deterministic stamp so
	 *  fixtures can pin `generated_at`. */
	now?: () => string;
}

/** Public API — consumed by `src/harness/server.ts` from its UserPromptSubmit
 *  branch. Runs the full pipeline and returns a typed outcome. Never throws.
 *
 *  Caller is responsible for:
 *    - Passing the PII-scanner-redacted prompt when the scanner fires
 *    - Bailing early on `event.metacoder_subprocess` to break recursion
 *    - Merging the overlay rules into the per-session rule cache and
 *      surfacing `outcome.overlay.system_prompt_addendum` as
 *      `decision.additional_context`. */
export async function runMetacoderForPrompt(input: RunMetacoderInput): Promise<MetacoderOutcome> {
	if (!input.prompt || input.prompt.length === 0) {
		return { kind: "skipped", reason: "no_prompt", warnings: [] };
	}
	if (!input.config.enabled) {
		return { kind: "skipped", reason: "disabled", warnings: [] };
	}

	const transport = input.transport ?? buildDefaultTransport(input.client);

	const ctx = buildMetacoderContext({
		prompt: input.prompt,
		client: input.client,
		sessionId: input.sessionId,
		cwd: input.cwd,
		floorRuleIds: input.floorRuleIds,
		config: input.config,
	});

	const callResult = await callMetacoder(ctx, input.config, transport);
	if (callResult.kind !== "ok") {
		// Propagate skipped / failed unchanged. The server is responsible for
		// surfacing the warnings on stderr when verbose logging is on.
		return callResult;
	}

	const validation = validateOverlayEmission(callResult.emission, {
		floorRuleIds: new Set(input.floorRuleIds),
		sessionId: input.sessionId,
		config: input.config,
	});
	const warnings = [...callResult.warnings, ...validation.warnings];

	if (validation.rules.length === 0 && (validation.addendum === undefined || validation.addendum.length === 0)) {
		// Nothing useful — the metacoder either had no constraints to add or
		// every emitted rule got dropped by the invariant. Surface as skipped
		// so the server can omit additional_context cleanly.
		return { kind: "skipped", reason: "empty_overlay", warnings };
	}

	const clock = input.now ?? defaultClock;
	const overlay: OverlayRulesFile = {
		version: 1,
		session_id: input.sessionId,
		generated_at: clock(),
		generated_by: "metacoder",
		source_prompt_sha256: hashPrompt(input.prompt),
		system_prompt_addendum: validation.addendum,
		rules: validation.rules,
	};

	try {
		writeOverlayArtifacts({ cwd: input.cwd, sessionId: input.sessionId }, overlay);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { kind: "failed", reason: `overlay write: ${message}`, warnings };
	}

	return { kind: "ok", overlay, warnings };
}

/** SHA-256 of the prompt, hex-encoded, full digest. Used by the harness's
 *  recurrence aggregator and audit logs to dedupe per-prompt overlays. */
function hashPrompt(prompt: string): string {
	return createHash("sha256").update(prompt).digest("hex");
}

function defaultClock(): string {
	return new Date().toISOString();
}
