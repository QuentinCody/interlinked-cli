// Instruction packets — consent, rendering and the secret gate (design §6, R3).
//
// Three independent gates stand between an event and a Jev call, each enough
// to refuse: (1) explicit consent for the DERIVED evidence kind
// (`packets.evidence_consent.kinds`), separate from the collection row's
// `allowed_for_cloud_upload`, which is false on every row and governs raw-row
// upload, not sanitized evidence; (2) privacy denial by path on its own —
// a path packet needs a consented glob, repo-relative, and a path outside the
// repo is never consented; (3) a residual secret signature in the RENDERED
// text (after `redactE20` + `maskCredentialAssignments`) refuses the call.
// Pure functions; the evaluator wires them.

import { isAbsolute, relative, resolve } from "node:path";
import { matchesAnyGlob } from "../../lib/path-glob.js";
import { maskCredentialAssignments, redactE20, residualSecretMatches } from "../jev/decision-shadow-redact.js";
import type { JevEntry } from "../jev/types.js";
import type { TriggerView } from "./trigger.js";
import type { ConsentKind, EvidenceKind, Packet } from "./types.js";

export interface EvidenceConsent {
	kinds: ConsentKind[];
	/** Repo-relative globs a path-bearing packet's path must match. */
	paths: string[];
}

export interface RenderBounds {
	commandChars: number;
	hunkChars: number;
	maxHunks: number;
}

export type ConsentGate = "no_consent" | "privacy";
export type ConsentResult = { ok: true } | { ok: false; gate: ConsentGate };
export type RenderResult = { ok: true; evidence: JevEntry } | { ok: false; gate: "secret" };

/** Version stamps a calibration binds to (design §8, R5). */
export const EVIDENCE_RENDERER = "evidence-v1";
export const EVIDENCE_REDACTION = "e20-v3";

const PATH_KINDS: ReadonlySet<EvidenceKind> = new Set(["hunks", "file"]);

function repoRelative(path: string, cwd: string): string | null {
	const abs = isAbsolute(path) ? path : resolve(cwd, path);
	const rel = relative(cwd, abs).replace(/\\/g, "/");
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel;
}

export function consentDecision(consent: EvidenceConsent | undefined, kind: EvidenceKind, view: TriggerView, cwd: string): ConsentResult {
	if (!consent || !consent.kinds.includes(kind)) return { ok: false, gate: "no_consent" };
	if (!PATH_KINDS.has(kind)) return { ok: true };
	const rel = view.path === null ? null : repoRelative(view.path, cwd);
	if (rel === null || consent.paths.length === 0 || !matchesAnyGlob(rel, consent.paths)) return { ok: false, gate: "privacy" };
	return { ok: true };
}

function sanitize(text: string, cap: number): string {
	const red = maskCredentialAssignments(redactE20(text));
	return red.length > cap ? `${red.slice(0, Math.max(0, cap - 20))} …[truncated]` : red;
}

/** The evidence a packet kind presents, sanitized and bounded; refused when a secret signature survives. */
export function renderEvidence(kind: EvidenceKind, view: TriggerView, bounds: RenderBounds, scan: (text: string) => number = residualSecretMatches): RenderResult {
	let evidence: JevEntry;
	if (kind === "command") {
		evidence = { command: sanitize(view.command ?? "", bounds.commandChars) };
	} else {
		evidence = {
			path: view.path,
			hunks: view.hunks.slice(0, bounds.maxHunks).map((h) => ({ old: sanitize(h.old, bounds.hunkChars), new: sanitize(h.new, bounds.hunkChars) })),
			hunks_total: view.hunks.length,
		};
	}
	if (scan(JSON.stringify(evidence)) > 0) return { ok: false, gate: "secret" };
	return { ok: true, evidence };
}

/** One Jev state for every packet of an event: the evidence once, each rule by id. */
export function renderState(tool: string, evidence: JevEntry, packets: readonly Packet[]): JevEntry {
	const rules: Record<string, JevEntry> = {};
	for (const p of packets) rules[p.id] = { instruction: p.source.quote, from: p.source.file };
	return { tool, evidence, rules };
}
