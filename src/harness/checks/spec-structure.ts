// Spec-structure checks: single-file markdown consistency over the
// spec-facts substrate (docs/design/spec-audit-runtime-checks.md §3.3,
// spikes 1+3). Cross-file variants live in the spec ledger, not here —
// the inline contract is (content, filePath) only.

import { claimBindsToNamespace, defLineSet } from "../spec/binding.js";
import { extractSpecFacts } from "../spec/extract-facts.js";
import { extractFencedBlocks, fencedLineSet } from "../spec/extract-misc.js";
import { githubSlug } from "../spec/extract-refs.js";
import type { SectionRef, SpecFacts } from "../spec/types.js";
import { isSpecEligibleFile, siteText } from "../spec/types.js";
import type { InlineMatch } from "./shared.js";

/** Max findings reported per file per check. */
const MAX_MATCHES = 20;

// The three registered checks run back-to-back on the same content at
// PostToolUse — a one-slot memo makes extraction effectively free for the
// second and third caller without a cache layer. Binding rules
// (idLineSet / claimBindsToNamespace) are imported from ../spec/binding.ts,
// shared with the cross-file ledger so single-file and ledger checks can
// never drift on what "bound" means.
let lastFacts: { content: string; filePath: string; facts: SpecFacts } | null =
	null;

function factsFor(content: string, filePath: string): SpecFacts {
	if (lastFacts && lastFacts.content === content && lastFacts.filePath === filePath) {
		return lastFacts.facts;
	}
	const facts = extractSpecFacts(content, filePath);
	lastFacts = { content, filePath, facts };
	return facts;
}

/** A §-ref matches only a heading with that EXACT number. A child ("7.3")
 *  must not satisfy "§7" — the missing parent heading is renumber residue,
 *  exactly the class this check exists to catch (Codex round-4 #6). */
function sectionExists(ref: string, sectionNumbers: Set<string>): boolean {
	return sectionNumbers.has(ref);
}

/** Whether a §-ref on `line` is qualified as pointing at ANOTHER document
 *  ("§7.3 of the plan", "§7.3 in RFC 6330", "the spec's §7.3") — external, not
 *  same-file dangling (round-2 #24). */
/** Citation of another document (RFC / "the <X> doc/spec/plan"). `\d+` so a
 *  multi-digit RFC number ("RFC 6330") matches, not just a single digit. */
const EXTERNAL_DOC_RE = /\b(?:RFC\s+\d+|the\s+\w+\s+(?:doc|spec|paper|plan))\b/i;
/** The same citation anchored at the END of the pre-ref text ("RFC 6330 §8"). */
const PRECEDING_DOC_RE = /(?:RFC\s+\d+|the\s+\w+\s+(?:doc|spec|paper|plan))\s*$/i;

/** The next section/appendix ref of ANY kind after this one's raw text, used to
 *  bound a citation to THIS ref's clause so it can't leak to a later ref. */
const NEXT_REF_RE = /§|\bSection\s|\bAppendix\s/i;

/** Whether a section/appendix ref is qualified as pointing at ANOTHER document —
 *  decided OCCURRENCE-LOCALLY at the ref's exact column (sol-max #8/#9/#10). A
 *  citation bound to a different ref on the line can't suppress this one, and a
 *  ref that is a textual prefix of another ("§8" inside "§8.1") resolves at its
 *  own column. Three local forms, kind-agnostic (works for §, Section, Appendix):
 *  "<ref> of/in <doc>" trailing, "<doc> <ref>" immediately preceding, or a
 *  citation inside this ref's clause (up to the next ref). Cross-file target
 *  validity is the ledger's job, not this single-file check's. */
function isRefExternallyQualified(line: string, ref: SectionRef): boolean {
	const fromRef = line.slice(ref.col);
	const beforeRef = line.slice(0, ref.col);
	const afterRaw = fromRef.slice(ref.raw.length);
	if (/^\s+(?:of|in)\s+\S/i.test(afterRaw)) return true;
	if (PRECEDING_DOC_RE.test(beforeRef)) return true;
	const nextRef = afterRaw.search(NEXT_REF_RE);
	const clause = nextRef === -1 ? fromRef : fromRef.slice(0, ref.raw.length + nextRef);
	return EXTERNAL_DOC_RE.test(clause);
}

/** Minimum numbered headings before §-refs are treated as same-file refs. */
const MIN_NUMBERED_HEADINGS = 3;

/**
 * Dangling same-file references: anchor links to no heading slug, §/Section
 * refs to no numbered heading (only in section-numbered docs — a doc without
 * numbered headings may cite another doc's sections), and Appendix refs to
 * no appendix heading (only in docs that have appendices).
 */
export function checkSpecDanglingAnchor(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!isSpecEligibleFile(filePath)) return [];
	const facts = factsFor(content, filePath);
	const out: InlineMatch[] = [];
	const slugs = new Set(facts.headings.map((h) => h.slug));
	for (const link of facts.anchorLinks) {
		if (out.length >= MAX_MATCHES) break;
		if (link.targetFile || !link.anchor) continue;
		if (!slugs.has(link.anchor)) {
			out.push({
				line: link.line,
				text: siteText(`${link.raw} — no heading with slug "${link.anchor}"`),
			});
		}
	}
	const sectionNumbersList = facts.headings
		.map((h) => h.sectionNumber)
		.filter((n): n is string => Boolean(n));
	const sectionNumbers = new Set(sectionNumbersList);
	const appendixLetters = new Set(
		facts.headings.map((h) => h.appendixLetter).filter(Boolean),
	);
	const contentLines = content.split("\n");
	for (const ref of facts.sectionRefs) {
		if (out.length >= MAX_MATCHES) break;
		// Skip refs qualified as pointing at another document (round-2 #24),
		// evaluated per-ref (round-broaden sol #4).
		if (isRefExternallyQualified(contentLines[ref.line - 1] ?? "", ref)) continue;
		if (ref.kind === "section") {
			if (sectionNumbersList.length < MIN_NUMBERED_HEADINGS) continue;
			if (!sectionExists(ref.ref, sectionNumbers)) {
				out.push({
					line: ref.line,
					text: siteText(`${ref.raw} — no §${ref.ref} heading in this file`),
				});
			}
		} else {
			if (appendixLetters.size === 0) continue;
			if (!appendixLetters.has(ref.ref)) {
				out.push({
					line: ref.line,
					text: siteText(`${ref.raw} — no Appendix ${ref.ref} heading in this file`),
				});
			}
		}
	}
	return out;
}

/** Gap report threshold: a registry missing MORE than this many rows is
 *  probably not a contiguous registry at all (avoid firing on id samples). */
const MAX_REPORTED_GAPS = 10;

/**
 * Registry numbering defects: an id defined on two definition lines
 * (duplicate row — the stable-ID rule says rename the newer one, never
 * renumber), and small gaps in a definition registry (renumber residue).
 * Gaps are computed over DEFINITION sites only: prose that cites a sparse
 * subset of ids never fires.
 */
export function checkSpecNumbering(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!isSpecEligibleFile(filePath)) return [];
	const facts = factsFor(content, filePath);
	const out: InlineMatch[] = [];
	for (const ns of facts.namespaces) {
		for (const id of ns.ids) {
			if (out.length >= MAX_MATCHES) return out;
			if (id.defSites.length >= 2) {
				out.push({
					line: id.defSites[1] ?? id.defSites[0] ?? 0,
					text: siteText(
						`${id.id} defined again (first definition at line ${id.defSites[0]})`,
					),
				});
			}
		}
		appendRegistryGapFinding(ns.prefix, ns.ids, out);
	}
	appendDuplicateHeadingFindings(facts, out);
	return out;
}

/** Duplicate heading slugs — the design-promised renumber-residue branch
 *  (round-2 #37): two "## Setup" headings anchor as setup / setup-1, so a
 *  link to #setup is ambiguous. */
function appendDuplicateHeadingFindings(facts: SpecFacts, out: InlineMatch[]): void {
	// Compare the PRE-DEDUP slug of the heading TEXT (round-broaden sol #3).
	// facts.headings[].slug already carries GitHub's "-1"/"-2" disambiguation, so
	// stripping a trailing "-<n>" from it conflated a legitimately distinct
	// heading ("Setup 1" → "setup-1") with "Setup" ("setup"). Re-slugging the
	// raw text recovers the collision: two "Setup" headings both slug to
	// "setup"; "Setup" and "Setup 1" do not.
	const firstBySlug = new Map<string, number>();
	const countBySlug = new Map<string, number>();
	for (const h of facts.headings) {
		if (out.length >= MAX_MATCHES) return;
		const raw = githubSlug(h.text);
		const first = firstBySlug.get(raw);
		if (first === undefined) {
			firstBySlug.set(raw, h.line);
			countBySlug.set(raw, 1);
		} else {
			// GitHub appends -1 to the SECOND collision, -2 to the third, … — the
			// suffix is (prior occurrences), not a hard-coded -1 (sol-max #23).
			const priorCount = countBySlug.get(raw) ?? 1;
			countBySlug.set(raw, priorCount + 1);
			out.push({
				line: h.line,
				text: siteText(
					`duplicate heading "${h.text}" (first at line ${first}) — both slug to #${raw}; GitHub disambiguates this one to #${raw}-${priorCount}, so a bare link to #${raw} is ambiguous. Rename one.`,
				),
			});
		}
	}
}

/** One finding per namespace when its definition registry has small gaps. */
function appendRegistryGapFinding(
	prefix: string,
	ids: SpecFacts["namespaces"][number]["ids"],
	out: InlineMatch[],
): void {
	const defIds = ids.filter((i) => i.defSites.length > 0);
	if (defIds.length < 3 || out.length >= MAX_MATCHES) return;
	const nums = defIds.map((i) => i.num);
	const present = new Set(nums);
	const min = Math.min(...nums);
	const max = Math.max(...nums);
	const missing: number[] = [];
	for (let n = min; n <= max && missing.length <= MAX_REPORTED_GAPS; n++) {
		if (!present.has(n)) missing.push(n);
	}
	if (missing.length === 0 || missing.length > MAX_REPORTED_GAPS) return;
	out.push({
		line: defIds[0]?.defSites[0] ?? 0,
		text: siteText(
			`${prefix} registry gap: defined ${prefix}${prefix.endsWith("-") ? "" : "-"}${min}..${max} is missing ${missing
				.map((n) => `${n}`)
				.join(", ")} — renumber residue, or rows were dropped`,
		),
	});
}

/**
 * Same-file count/range claims vs the id census (the D-1/D-2 class within
 * one file): "six bets" while B1..B7 are enumerated; "FG-INV-01 through
 * FG-INV-20" while the census reaches FG-INV-28. Claims that bind to no
 * namespace are inert by design — binding requires co-occurrence evidence,
 * so ordinary prose quantities never fire.
 */
export function checkSpecCountClaim(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!isSpecEligibleFile(filePath)) return [];
	const facts = factsFor(content, filePath);
	const out: InlineMatch[] = [];
	for (const ns of facts.namespaces) {
		if (ns.uniqueCount < 2 || out.length >= MAX_MATCHES) continue;
		const defLines = defLineSet(ns);
		// Format ids in the namespace's own notation (sol-max #26): a compact
		// "B7" census must not be reported as dashed "B-7".
		const fmtId = (n: number): string =>
			ns.style === "compact" ? `${ns.prefix}${n}` : `${ns.prefix}-${n}`;
		for (const claim of facts.countClaims) {
			if (out.length >= MAX_MATCHES) break;
			if (claim.value === ns.uniqueCount) continue;
			if (!claimBindsToNamespace(claim, facts, ns, defLines)) continue;
			out.push({
				line: claim.line,
				text: siteText(
					`"${claim.raw}" vs ${ns.prefix} census: ${ns.uniqueCount} distinct ids (${fmtId(ns.min)}..${fmtId(ns.max)}). Either the claim is stale or the extra ids are vestigial.`,
				),
			});
		}
	}
	for (const claim of facts.rangeClaims) {
		if (out.length >= MAX_MATCHES) break;
		// Match the claim's OWN notation (sol-max #11): a compact "A1..A3" must
		// resolve to the compact A namespace, not a dashed A-… one.
		const ns = facts.namespaces.find(
			(n) => n.prefix === claim.prefix && n.style === claim.style,
		);
		if (!ns || ns.uniqueCount < 2) continue;
		// A claim starting ABOVE the census min is an intentional sub-range (a
		// slice like "FG-INV-05 through FG-INV-10", round-2 #20). One starting AT
		// or BELOW the min asserts the whole extent — below it overclaims ids that
		// do not exist (sol-max #14). Fire when such a claim's endpoint misses max.
		if (claim.from <= ns.min && claim.to !== ns.max) {
			out.push({
				line: claim.line,
				text: siteText(
					`"${claim.raw}" but the ${ns.prefix} census reaches ${ns.prefix}-${ns.max} (${ns.uniqueCount} ids). Update the range or the registry.`,
				),
			});
		}
	}
	return out;
}

// Stage-ordering defects (memo §8.1, Sol WS class): a numbered stage that
// depends on a LATER stage of the same namespace, or a later stage that
// changes/rewrites what an EARLIER stage already fixed. Single-line,
// same-prefix, id-to-id only — the crisp deterministic core of the class.
const FORWARD_DEP_RE =
	/\b([WG])(\d{1,2})\b[^.;\n]{0,80}\b(?:depends on|requires|needs|builds on|blocked by)\b[^.;\n]{0,80}\b\1(\d{1,2})\b/i;
const BACKWARD_CONSTRAIN_RE =
	/\b([WG])(\d{1,2})\b[^.;\n]{0,80}\b(?:changes|rewrites|modifies|invalidates|reworks|replaces)\b[^.;\n]{0,80}\b\1(\d{1,2})\b/i;

/**
 * Workstream/gate sequencing defects: "W4 depends on W7" (forward
 * dependency — W4 runs first but needs W7's output) and "W8 rewrites W2's
 * cursors" (backward constraint — a late stage changes what an early stage
 * froze). Fires only on W/G compact namespaces with ≥3 defined stages.
 */
export function checkSpecStageOrder(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!isSpecEligibleFile(filePath)) return [];
	const facts = factsFor(content, filePath);
	// Gate on ≥3 DEFINED stages, not incidental mentions (sol-max #13): a doc
	// that merely cites W1/W2/W3 from another plan has no local stage registry,
	// so "W4 depends on W8" is not a same-file sequencing defect.
	const hasStages = facts.namespaces.some(
		(n) =>
			n.style === "compact" &&
			(n.prefix === "W" || n.prefix === "G") &&
			n.ids.filter((i) => i.defSites.length > 0).length >= 3,
	);
	if (!hasStages) return [];
	const out: InlineMatch[] = [];
	const lines = content.split("\n");
	// Skip fenced code/examples (sol-max #18): a documented "bad example" of an
	// invalid dependency is illustration, not operative doctrine.
	const fenced = fencedLineSet(extractFencedBlocks(lines));
	for (let i = 0; i < lines.length && out.length < MAX_MATCHES; i++) {
		if (fenced.has(i + 1)) continue;
		const line = lines[i] ?? "";
		const fwd = FORWARD_DEP_RE.exec(line);
		if (fwd && Number(fwd[3]) > Number(fwd[2])) {
			out.push({
				line: i + 1,
				text: siteText(
					`${fwd[1]}${fwd[2]} depends on later ${fwd[1]}${fwd[3]} — either resequence or split the dependency`,
				),
			});
			continue;
		}
		const back = BACKWARD_CONSTRAIN_RE.exec(line);
		if (back && Number(back[3]) < Number(back[2])) {
			out.push({
				line: i + 1,
				text: siteText(
					`${back[1]}${back[2]} changes what ${back[1]}${back[3]} already fixed — the earlier stage's output isn't stable until the later one lands`,
				),
			});
		}
	}
	return out;
}

/**
 * Present-tense path claims vs the working tree. Verify-battery check (the
 * 3-arg resolver pattern — the inline registry contract has no filesystem):
 * "the full `invariants.toml` exists in-repo" when it does not (Sol D-3).
 * Future-tense and unknown-tense mentions never fire.
 */
export function checkSpecPathRef(
	content: string,
	filePath: string,
	pathExists: (relPath: string) => boolean,
): InlineMatch[] {
	if (!isSpecEligibleFile(filePath)) return [];
	const facts = factsFor(content, filePath);
	const out: InlineMatch[] = [];
	for (const ref of facts.pathRefs) {
		if (out.length >= MAX_MATCHES) break;
		if (ref.tense !== "present") continue;
		if (pathExists(ref.path)) continue;
		out.push({
			line: ref.line,
			text: siteText(
				`\`${ref.path}\` is referenced as existing but is not in the tree`,
			),
		});
	}
	return out;
}
