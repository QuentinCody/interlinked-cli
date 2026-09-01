// ===========================================
// Findings anchor liveness — LG-6 (docs/design/edit-contract-hardening.md)
// ===========================================
//
// A finding ingested at `file:line` decays as the tree moves: edits above it
// shift the true location, edits at it change the content. omp's snapshot-tag
// idea, applied to the audit ledger: capture a small content anchor (span
// hash + verbatim context lines) at ingest, then re-verify deterministically:
//
//   live    — the span at the recorded line still hashes to the anchor
//   moved   — the context re-locates UNIQUELY elsewhere (report the new line)
//   drifted — content at/around the anchor changed, or relocation is
//             ambiguous → the finding needs re-review, not silent survival
//   gone    — the file no longer exists
//   unverified — legacy rows with no anchor captured (fail open)
//
// Deliberate asymmetry with omp: they remap in order to apply an edit anyway;
// we remap only to keep the ledger true. Nothing here closes a finding —
// closure stays an edit or an explicit ack (reconciliation).

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Finding } from "./corpus.js";

/** Context lines captured on each side of the anchored line. */
const ANCHOR_CONTEXT_RADIUS = 1;

type AnchorState = "live" | "moved"| "drifted" | "gone" | "unverified";

interface AnchorVerdict {
	state: AnchorState;
	/** 1-based current line of the anchor when state is "moved". */
	newLine?: number | undefined;
}

/** Trailing-whitespace-immune hash of a span (omp's tag normalization). */
function hashSpan(lines: string[]): string {
	const normalized = lines.map((l) => l.replace(/[ \t\r]+$/, "")).join("\n");
	return createHash("sha256").update(normalized).digest("hex");
}

/** The clamped context window around 1-based `line` (radius fixed, so the
 *  anchor's offset inside the window is derivable at verify time). */
function contextWindow(lines: string[], line: number): string[] {
	const start = Math.max(0, line - 1 - ANCHOR_CONTEXT_RADIUS);
	const end = Math.min(lines.length - 1, line - 1 + ANCHOR_CONTEXT_RADIUS);
	return lines.slice(start, end + 1);
}

/** The anchor line's 0-based offset inside its context window. */
function offsetInWindow(line: number): number {
	return Math.min(ANCHOR_CONTEXT_RADIUS, line - 1);
}

function resolveFindingPath(finding: Finding, cwd: string): string {
	return isAbsolute(finding.file) ? finding.file : join(cwd, finding.file);
}

/** Best-effort tree stamp for provenance: `<sha>` or `<sha>+dirty`. */
function treeStamp(cwd: string): string | undefined {
	try {
		const sha = execSync("git rev-parse HEAD", { cwd, stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
		const dirty = execSync("git status --porcelain", {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim();
		return dirty ? `${sha}+dirty` : sha;
	} catch {
		return undefined;
	}
}

/**
 * Enrich a freshly-made finding with its content anchor from the live tree.
 * No-op (returns the finding unchanged) for unanchored findings or unreadable
 * files — every consumer of the fields fails open.
 */
export function captureAnchor(finding: Finding, cwd: string): Finding {
	if (!finding.file || finding.line < 1) return finding;
	const abs = resolveFindingPath(finding, cwd);
	let content: string;
	try {
		if (!existsSync(abs)) return finding;
		content = readFileSync(abs, "utf-8");
	} catch {
		return finding;
	}
	const lines = content.split("\n");
	if (finding.line > lines.length) return finding;
	const context = contextWindow(lines, finding.line);
	return {
		...finding,
		anchor_span_sha256: hashSpan(context),
		anchor_context: context,
		anchor_tree: treeStamp(cwd),
	};
}

/** All 0-based start indexes where `context` appears in `lines` under `eq`. */
function findContextMatches(
	lines: string[],
	context: string[],
	eq: (a: string, b: string) => boolean,
): number[] {
	const matches: number[] = [];
	outer: for (let i = 0; i + context.length <= lines.length; i++) {
		for (let j = 0; j < context.length; j++) {
			// SAFETY: loop bounds guarantee both indexes are in range.
			if (!eq(lines[i + j] as string, context[j] as string)) continue outer;
		}
		matches.push(i);
	}
	return matches;
}

const exactEq = (a: string, b: string): boolean => a === b;
const trimmedEq = (a: string, b: string): boolean => a.trim() === b.trim();

/** Unique relocation of the context, exact first then whitespace-normalized.
 *  Returns the anchor's new 1-based line, or null (absent or ambiguous). */
function relocate(lines: string[], context: string[], originalLine: number): number | null {
	for (const eq of [exactEq, trimmedEq]) {
		const matches = findContextMatches(lines, context, eq);
		if (matches.length === 1) {
			// SAFETY: length===1 checked on the line above.
			return (matches[0] as number) + offsetInWindow(originalLine) + 1;
		}
		if (matches.length > 1) return null; // ambiguous — conservative
	}
	return null;
}

/**
 * Re-verify one finding's anchor against the working tree. Pure read — no
 * corpus writes, no reconciliation writes; the caller decides what to do
 * with a verdict (e.g. `findings verify --write` re-anchors `moved` rows).
 */
export function classifyAnchor(finding: Finding, cwd: string): AnchorVerdict {
	if (!finding.anchor_span_sha256 || !finding.anchor_context || !finding.file) {
		return { state: "unverified" };
	}
	const abs = resolveFindingPath(finding, cwd);
	let content: string;
	try {
		if (!existsSync(abs)) return { state: "gone" };
		content = readFileSync(abs, "utf-8");
	} catch {
		return { state: "unverified" };
	}
	const lines = content.split("\n");
	if (finding.line >= 1 && finding.line <= lines.length) {
		const current = contextWindow(lines, finding.line);
		if (hashSpan(current) === finding.anchor_span_sha256) return { state: "live" };
	}
	const relocated = relocate(lines, finding.anchor_context, finding.line);
	if (relocated === null) return { state: "drifted" };
	return relocated === finding.line ? { state: "live" } : { state: "moved", newLine: relocated };
}
