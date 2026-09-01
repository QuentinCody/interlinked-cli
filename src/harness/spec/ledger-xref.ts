// Cross-file link (xref) drift for SpecLedger — split out of ledger.ts for the
// per-file line cap. Anchor-existence and file-existence checks over the loaded
// file map, with the exact filesystem predicate as the ground truth for
// existence (sol-max #16): a truncated or depth-bounded walk never short-circuits
// a missing-file verdict, because `fileExists` — not "did we walk it" — decides.

import { join } from "node:path";
import type { SpecDriftFinding } from "./ledger-drift.js";
import type { SpecFacts } from "./types.js";

/** Normalize a link target relative to its source file into repo-relative form. */
export function resolveRelativeTarget(
	sourceRel: string,
	target: string,
): string | null {
	const sourceDir = sourceRel.includes("/")
		? sourceRel.slice(0, sourceRel.lastIndexOf("/"))
		: "";
	// Strip URL query/fragment and decode %-escapes — they're link metadata, not
	// part of the local filename (sol-max #15): "guide.md?view=1#intro" → "guide.md".
	const stripped = target.replace(/[?#].*$/, "");
	let cleanTarget = stripped;
	try {
		cleanTarget = decodeURIComponent(stripped);
	} catch {
		cleanTarget = stripped;
	}
	const raw = cleanTarget.startsWith("./") ? cleanTarget.slice(2) : cleanTarget;
	const parts = (sourceDir ? `${sourceDir}/${raw}` : raw).split("/");
	const out: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (out.length === 0) return null; // escapes the repo root
			out.pop();
		} else {
			out.push(part);
		}
	}
	return out.join("/");
}

type AnchorLink = SpecFacts["anchorLinks"][number];

/** Everything the xref pass reads off the ledger — bundled so the helpers stay
 *  low-arity and isTruncated is deliberately absent (existence is fileExists). */
export interface XrefContext {
	files: Map<string, SpecFacts>;
	skippedPaths: Set<string>;
	fileExists: (absPath: string) => boolean;
	repoRoot: string;
	/** When set, only links FROM this file or TO this file are examined — an xref
	 *  finding involves the scoped file only as its source or its target
	 *  (sol-max #19), so the rest of the link graph is skipped. */
	scope?: string | undefined;
}

/** Whether a link (file → resolved) can produce a finding involving `scope`. */
function linkInvolvesScope(
	scope: string | undefined,
	file: string,
	resolved: string,
): boolean {
	return !scope || file === scope || resolved === scope;
}

/** Anchor + linked-file drift across all loaded files. */
export function computeXrefDrift(ctx: XrefContext): SpecDriftFinding[] {
	const out: SpecDriftFinding[] = [];
	const slugCache = new Map<string, Set<string>>();
	for (const [file, facts] of ctx.files) {
		for (const link of facts.anchorLinks) {
			if (!link.targetFile) continue;
			const resolved = resolveRelativeTarget(file, link.targetFile);
			if (!resolved) continue;
			if (!linkInvolvesScope(ctx.scope, file, resolved)) continue;
			appendXrefFinding(ctx, out, file, link, resolved, slugCache);
		}
	}
	return out;
}

function appendXrefFinding(
	ctx: XrefContext,
	out: SpecDriftFinding[],
	file: string,
	link: AnchorLink,
	resolved: string,
	slugCache: Map<string, Set<string>>,
): void {
	const target = ctx.files.get(resolved);
	if (target) {
		if (!link.anchor) return;
		let slugs = slugCache.get(resolved);
		if (!slugs) {
			slugs = new Set(target.headings.map((h) => h.slug));
			slugCache.set(resolved, slugs);
		}
		if (!slugs.has(link.anchor)) {
			out.push({
				kind: "xref_missing_anchor",
				file,
				line: link.line,
				message: `${link.raw} — ${resolved} has no heading with slug "${link.anchor}" (renamed or removed?)`,
				relatedFiles: [resolved],
			});
		}
		return;
	}
	// Target not in the ledger. A path skipped for size/readability EXISTS —
	// never report it missing. Otherwise ask the filesystem directly (round-2
	// #18 / sol-max #16): the walk excludes dirs, depth-skips, caps at MAX_FILES,
	// and won't follow symlinks, so "absent from the map" ≠ "absent from disk".
	// fileExists is ground truth for existence; only the anchor check above needs
	// the file to have been walked.
	if (ctx.skippedPaths.has(resolved)) return;
	if (!ctx.fileExists(join(ctx.repoRoot, resolved))) {
		out.push({
			kind: "xref_missing_file",
			file,
			line: link.line,
			message: `${link.raw} — linked file ${resolved} does not exist`,
			relatedFiles: [resolved],
		});
	}
}
