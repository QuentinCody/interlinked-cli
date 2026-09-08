// ===========================================
// tsgo acceleration for Bash `tsc` calls
// ===========================================
// When the agent runs `tsc` via Bash and tsgo is available, transparently
// rewrite to `npx tsgo` and return the output via block-and-answer (so the
// agent sees the faster check without noticing the substitution). Extracted
// from the monolithic server.ts; no module-level state, so the helpers stay
// pure and are easy to test.

import { spawnSync } from "node:child_process";
import type { JsonObject } from "../lib/json-types.js";

let _tsgoAvailable: boolean | null = null;

/** Memoized availability check — probes `npx tsgo --version` once per
 *  process. Uses spawnSync to avoid a deferred microtask in the hot path. */
export function isTsgoAvailable(): boolean {
	if (_tsgoAvailable !== null) return _tsgoAvailable;
	try {
		const result = spawnSync("npx", ["tsgo", "--version"], {
			timeout: 5_000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		_tsgoAvailable = result.status === 0 && !result.error;
	} catch {
		_tsgoAvailable = false;
	}
	return _tsgoAvailable;
}

/** Reset the memoized availability (test hook only). */
export function _resetTsgoAvailabilityCache(): void {
	_tsgoAvailable = null;
}

/** Check if this is a Bash tool call that runs tsc for type-checking (safe
 *  for tsgo). Skips flags tsgo doesn't support (build, watch, etc.). */
export function isBashTsc(event: {
	tool_name?: string | undefined;
	tool_input?: JsonObject | undefined;
}): boolean {
	if (event.tool_name !== "Bash") return false;
	const command = event.tool_input?.command;
	if (typeof command !== "string") return false;
	const cmd = command.trim();
	if (/\btsgo\b/.test(cmd)) return false; // already using tsgo
	// Only match tsc as the primary command (not inside strings/echo)
	const isTscCommand = /^(npx\s+)?tsc\b/.test(cmd) || /[;&|]\s*(npx\s+)?tsc\b/.test(cmd);
	if (!isTscCommand) return false;
	// tsgo doesn't support all tsc flags — only rewrite for type-checking.
	// Skip: --build/-b, --watch/-w, --declaration/-d, --emitDeclarationOnly,
	// --incremental, --composite, --init, --generateTrace
	if (
		/\s(-[bwd]|--build|--watch|--declaration|--emitDeclarationOnly|--incremental|--composite|--init|--generateTrace)\b/.test(
			cmd,
		)
	)
		return false;
	return true;
}

/** Rewrite a tsc command to tsgo and run it via block-and-answer. Returns a
 *  `block` decision carrying the output, or null to fall through to tsc. */
export function tryTsgoRewrite(
	event: { tool_input?: JsonObject | undefined },
	cwd: string,
	log: (msg: string) => void,
): { decision: "block"; reason: string } | null {
	const cmd = event.tool_input?.command;
	if (typeof cmd !== "string") return null;
	if (!isTsgoAvailable()) return null;
	const rewritten = cmd.replace(/\b(npx\s+)?tsc\b/, "npx tsgo");
	log(`tsgo acceleration: ${cmd.trim().slice(0, 60)} → ${rewritten.trim().slice(0, 60)}`);

	try {
		const result = spawnSync("sh", ["-c", rewritten], {
			cwd,
			timeout: 120_000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		const output = ((result.stdout || "") + (result.stderr || "")).trim();
		const exitCode = result.status ?? 1;

		// Only use tsgo results when it exits clean (no errors).
		// When tsgo finds errors, fall back to tsc — tsgo may produce
		// false positives due to different type resolution behavior.
		if (exitCode !== 0) {
			log(`tsgo exited ${exitCode}, falling back to tsc`);
			return null;
		}

		return {
			decision: "block",
			reason: [
				"[interlinked:tsgo] Accelerated with tsgo (native TypeScript compiler)",
				`$ ${rewritten}`,
				...(output ? [output] : ["(no output)"]),
			].join("\n"),
		};
	} catch (err) {
		log(`tsgo acceleration failed: ${err instanceof Error ? err.message : String(err)}`);
		return null; // fall through to normal tsc
	}
}
