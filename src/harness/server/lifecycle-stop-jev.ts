// Stop-event nudge: are the final message's claims backed by this turn's tool calls?
//
// Thin glue between the Stop payload (`last_assistant_message`, `transcript_path`)
// and `jev/claim-evidence.ts`. Warn-only, fail-open, one Jev call per Stop, and
// nothing runs unless `jev.enabled` is on and a key resolves (client is null
// otherwise). Measurements and operating points live in the module header of
// claim-evidence.ts.

import { readFileSync, statSync } from "node:fs";
import { evidenceFromTranscript, formatClaimEvidenceWarning, scoreClaims } from "../jev/claim-evidence.js";
import { createJevClient, type JevClient } from "../jev/client.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";

/** One client (and one spend ledger) per loaded rules object; a hot-reload yields a fresh one. */
const clientsByRules = new WeakMap<GuardRulesConfig, JevClient | null>();

export function jevClientFor(rules: GuardRulesConfig): JevClient | null {
	const cached = clientsByRules.get(rules);
	if (cached !== undefined) return cached;
	const client = createJevClient(rules.jev);
	clientsByRules.set(rules, client);
	return client;
}

/** Bounded tail read: the last human turn is at the end of the transcript. */
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

function readTranscriptTail(path: string): string | null {
	try {
		const size = statSync(path).size;
		const text = readFileSync(path, "utf-8");
		return size > TRANSCRIPT_TAIL_BYTES ? text.slice(-TRANSCRIPT_TAIL_BYTES) : text;
	} catch {
		return null;
	}
}

/** `null` when disabled, dry-run, no final message, no readable transcript, no evidence, or nothing unbacked. */
export async function buildJevClaimWarning(client: JevClient | null, event: HarnessEvent): Promise<string | null> {
	if (!client || event.dry_run) return null;
	const finalMessage = event.last_assistant_message;
	if (!finalMessage || !event.transcript_path) return null;
	const transcript = readTranscriptTail(event.transcript_path);
	if (transcript === null) return null;
	const evidence = evidenceFromTranscript(transcript);
	if (evidence.length === 0) return null;
	return formatClaimEvidenceWarning(await scoreClaims(client, finalMessage, evidence));
}
