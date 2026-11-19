// Instruction packets — the daemon's fallback proposer (design §9): which released texts are not live here.
//
// Loads the packet file with the SAME hash check the evaluator uses, resolves the key the same way, and asks
// `fallback.ts` which released packets are not live for this runner — statically (config, key, sources,
// status, binding, support, consent) and right now (spend cap reached, Jev failed at its last call:
// `runtimeNonLiveReason`). A stale set disables every packet; a file the strict parser refuses disables them
// too and is read leniently for its releases. Never throws. Whether a proposed line reached the model is
// recorded by the hook after encoding (`fallback-ledger.ts`); callers filter out ids already received.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JEV_API_KEY_ENV } from "../jev/client.js";
import { resolveApiKey } from "../policy-classifier.js";
import type { GuardRulesConfig } from "../types.js";
import { loadPacketFile, runtimeNonLiveReason } from "./evaluator.js";
import { type FallbackEntry, lenientReleasedEntries, releasedFallbackEntries } from "./fallback.js";
import { parsePacketFile } from "./schema.js";
import { PACKET_FILE_BASENAME } from "./types.js";

const RELEASE_KEY = /"release"\s*:\s*\{/;

/** Cheap pre-check for the per-call path: does the packet file hold any release at all? */
export function hasRelease(cwd: string): boolean {
	const path = join(cwd, ".interlinked", PACKET_FILE_BASENAME);
	try {
		return existsSync(path) && RELEASE_KEY.test(readFileSync(path, "utf8"));
	} catch {
		return false;
	}
}

/** One entry per released packet that is not live here now; empty when nothing is released. */
export function startFallbackEntries(cwd: string, rules: GuardRulesConfig, runnerSource: string, resolveKey: () => string | undefined = () => resolveApiKey(JEV_API_KEY_ENV)): FallbackEntry[] {
	const path = join(cwd, ".interlinked", PACKET_FILE_BASENAME);
	if (!existsSync(path)) return [];
	try {
		const ctx = { rules, runner: runnerSource, hasKey: resolveKey() !== undefined, sourcesOk: true };
		const loaded = loadPacketFile(cwd, path);
		if (loaded.ok) return releasedFallbackEntries(loaded.file, ctx, runtimeNonLiveReason(rules));
		const text = readFileSync(path, "utf8");
		if (loaded.gate === "packets_invalid") return lenientReleasedEntries(text, "packet set disabled");
		// Stale sources: the set is disabled, so every released packet falls back.
		const parsed = parsePacketFile(text);
		return parsed.ok ? releasedFallbackEntries(parsed.value, { ...ctx, sourcesOk: false }) : [];
	} catch {
		return [];
	}
}

/** The lines of `startFallbackEntries` (SessionStart: every not-live release, whatever was delivered before). */
export function startFallbackLines(cwd: string, rules: GuardRulesConfig, runnerSource: string, resolveKey?: () => string | undefined): string[] {
	return startFallbackEntries(cwd, rules, runnerSource, resolveKey).map((e) => e.line);
}
