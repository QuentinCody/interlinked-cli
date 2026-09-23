// Internal transcript evaluation only; never invoked by the public harness.

import { readFileSync, statSync } from "node:fs";
import { evidenceFromTranscript, formatClaimEvidenceWarning, scoreClaims } from "./claim-evidence.js";
import type { JevClient } from "./client.js";
import type { HarnessEvent } from "../types.js";

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
export async function buildJevClaimWarning(client: JevClient | null, event: Pick<HarnessEvent, "dry_run" | "last_assistant_message" | "transcript_path">): Promise<string | null> {
	if (!client || event.dry_run) return null;
	const finalMessage = event.last_assistant_message;
	if (!finalMessage || !event.transcript_path) return null;
	const transcript = readTranscriptTail(event.transcript_path);
	if (transcript === null) return null;
	const evidence = evidenceFromTranscript(transcript);
	if (evidence.length === 0) return null;
	return formatClaimEvidenceWarning(await scoreClaims(client, finalMessage, evidence));
}
