// Check Evidence Contract — the independent adversarial pass.
//
// Spec: docs/design/verification-density-program.md (Phase 4).
//
// The detector's author writes the detector AND its negative cases, so both
// come from one mental model and share one blind spot. This dimension records a
// pass whose only job is the opposite of the author's: find code this detector
// wrongly flags. The repo already runs refute-by-default verifiers elsewhere;
// this points that discipline at check authoring, where the blind spot is most
// structural.
//
// Two properties make the record trustworthy rather than ceremonial:
//
//   1. It is BOUND TO THE SOURCE. The record carries a hash of the detector's
//      text at review time. Rewrite the detector and the pass goes stale
//      automatically — a review of code that no longer exists proves nothing,
//      and without this the record would be a one-time sticker that outlives
//      every change it was supposed to scrutinize.
//
//   2. It NAMES A REVIEWER distinct from the author. Identity cannot be
//      verified deterministically, but recording both makes a self-review
//      visible in the diff instead of invisible in someone's head.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One recorded adversarial pass over a detector. */
export interface AdversarialRecord {
	/** Who (or what) performed the FP hunt. */
	reviewer: string;
	/** Who wrote the detector, when known — used to reject a self-review. */
	author?: string;
	/** sha256 of the detector source at review time. */
	detector_sha256: string;
	/**
	 * Candidate false positives the pass turned up. Each one is expected to
	 * become a negative test case; an empty list is a legitimate outcome but a
	 * weaker signal than a list that found something.
	 */
	findings: string[];
	/** Free-text context for a human reading the record. */
	note?: string;
}

/** The committed adversarial store. */
interface AdversarialStore {
	version: 1;
	checks: Record<string, AdversarialRecord>;
}

/** Repo-relative path of the committed store. */
export const CHECK_ADVERSARIAL_PATH = ".interlinked/check-adversarial.json";

/** An empty store, returned for a missing or malformed file. */
export const EMPTY_ADVERSARIAL: AdversarialStore = { version: 1, checks: {} };

/** Hash detector source the same way records do. */
export function detectorHash(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}

/** Why an adversarial record does not satisfy the obligation. */
export type AdversarialGap = "missing" | "stale_source" | "self_review" | "no_reviewer";

/**
 * Check one record against the detector's CURRENT source.
 *
 * Returns null when the obligation is met, otherwise the reason it is not.
 * A record for source that has since changed is `stale_source`, not a pass:
 * the whole point of binding to the hash is that edits re-open the question.
 */
export function adversarialGap(
	record: AdversarialRecord | undefined,
	currentSource: string | undefined,
): AdversarialGap | null {
	if (!record) return "missing";
	if (!record.reviewer.trim()) return "no_reviewer";
	if (record.author && record.author.trim() === record.reviewer.trim()) return "self_review";
	// No current source means the detector could not be read; the record cannot
	// be confirmed fresh, so it does not count.
	if (!currentSource) return "stale_source";
	return record.detector_sha256 === detectorHash(currentSource) ? null : "stale_source";
}

/** Human-readable explanation of a gap, for the pin's failure message. */
export function describeAdversarialGap(gap: AdversarialGap): string {
	switch (gap) {
		case "missing":
			return "no independent adversarial pass recorded — the detector's author is currently its only adversary";
		case "stale_source":
			return "the recorded adversarial pass covers an older version of the detector — re-run it against the current source";
		case "self_review":
			return "the recorded adversarial pass names the detector's own author as reviewer — it must be independent";
		case "no_reviewer":
			return "the recorded adversarial pass names no reviewer";
	}
}

/** Narrow unknown JSON to one record, or null when malformed. */
function parseRecord(raw: unknown): AdversarialRecord | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.reviewer !== "string" || typeof o.detector_sha256 !== "string") return null;
	const findings = Array.isArray(o.findings)
		? o.findings.filter((f): f is string => typeof f === "string")
		: [];
	return {
		reviewer: o.reviewer,
		detector_sha256: o.detector_sha256,
		findings,
		...(typeof o.author === "string" ? { author: o.author } : {}),
		...(typeof o.note === "string" ? { note: o.note } : {}),
	};
}

/** Load the committed store, failing closed to an empty one. */
export function loadAdversarialStore(repoRoot: string): AdversarialStore {
	const path = join(repoRoot, CHECK_ADVERSARIAL_PATH);
	if (!existsSync(path)) return EMPTY_ADVERSARIAL;
	try {
		return parseAdversarialStore(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return EMPTY_ADVERSARIAL;
	}
}

/** Narrow unknown JSON to the store, failing closed to an empty one. */
export function parseAdversarialStore(raw: unknown): AdversarialStore {
	if (!raw || typeof raw !== "object") return EMPTY_ADVERSARIAL;
	const checks = (raw as { checks?: unknown }).checks;
	if (!checks || typeof checks !== "object") return EMPTY_ADVERSARIAL;
	const out: Record<string, AdversarialRecord> = {};
	for (const [id, value] of Object.entries(checks as Record<string, unknown>)) {
		const record = parseRecord(value);
		if (record) out[id] = record;
	}
	return { version: 1, checks: out };
}
