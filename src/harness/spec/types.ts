// Spec-facts substrate: shared types.
//
// Design: docs/design/spec-audit-runtime-checks.md §3. Every shape here is
// JSON-serializable (arrays, no Maps) so per-file facts can be cached and
// merged into the cross-file ledger without a codec layer.

/** One ID in a namespace, e.g. "FG-INV-07" in namespace "FG-INV". */
export interface NamespaceId {
	id: string;
	/** Numeric component (7 for FG-INV-07). */
	num: number;
	/** Line numbers where the id appears (deduplicated, ascending). */
	sites: number[];
	/**
	 * Subset of sites that look like definitions: a definition-shaped line
	 * (heading / table row / list / blockquote / task item) where this id is the
	 * FIRST id on the line AND sits at the site's HEAD — the first table cell,
	 * or the start of the item/quote. Trailing ids on a registry row, later
	 * cells, and mid-sentence mentions inside a list item are references.
	 */
	defSites: number[];
	/** Distinct written forms merged into this entry ("FG-INV-1", "FG-INV-01"). */
	spellings: string[];
}

/** A clustered ID namespace: ≥N distinct ids sharing a prefix. */
export interface IdNamespace {
	/** Canonical prefix as written, e.g. "FG-INV" or "W". */
	prefix: string;
	/** "dashed" = FG-INV-07; "compact" = W4. */
	style: "dashed" | "compact";
	ids: NamespaceId[];
	min: number;
	max: number;
	uniqueCount: number;
	/**
	 * Numbers missing from [min..max], capped at 50 entries so a sparse
	 * namespace (A-1 + A-9999) cannot allocate an unbounded array.
	 */
	gaps: number[];
	/** True total of missing numbers in [min..max] (may exceed gaps.length). */
	gapCount: number;
}

/** A DEFINED id whose (style,prefix) group is below the per-file namespace
 *  threshold — a "fragment" of a registry split across files. The GLOBAL census
 *  folds these into a prefix that qualifies elsewhere (sol-max #1). */
export interface LooseId {
	style: "dashed" | "compact";
	prefix: string;
	num: number;
}

/** "six bets" / "28 invariants" — a stated count near a noun. */
export interface CountClaim {
	noun: string;
	/** Singular form of the noun (naive de-pluralization for binding). */
	nounSingular: string;
	value: number;
	raw: string;
	line: number;
}

/** "FG-INV-01 through FG-INV-20" — a stated ID range. */
export interface RangeClaim {
	prefix: string;
	/** Notation the claim was written in — a claim binds only to a namespace of
	 *  the SAME style (sol-max #10/#11): "A-1" (dashed) vs "A1" (compact). */
	style: "dashed" | "compact";
	from: number;
	to: number;
	/**
	 * Whether the upper endpoint repeated the prefix ("… through FG-INV-20")
	 * or was bare shorthand ("… through 20") — bare ranges are inferred and
	 * deserve lower-confidence diagnostics downstream.
	 */
	toExplicit: boolean;
	raw: string;
	line: number;
	/** 0-based column of `raw` on its EMPHASIS-STRIPPED line — the regex match
	 *  offset, so an endpoint that failed the range's leading boundary elsewhere on
	 *  the line can't steal this claim's span (sol-max #4). */
	col: number;
}

/** A markdown heading with its GitHub-style anchor slug. */
export interface HeadingInfo {
	line: number;
	level: number;
	text: string;
	/** GitHub anchor slug, deduplicated with -1/-2 suffixes. */
	slug: string;
	/** Leading section number if present ("7.3" in "### 7.3 Phantoms"). */
	sectionNumber?: string;
	/** Appendix letter if the heading is "Appendix X …". */
	appendixLetter?: string;
}

/** A prose reference to a section: "§7.3", "Section 7.3", "Appendix C". */
export interface SectionRef {
	line: number;
	kind: "section" | "appendix";
	/** "7.3" for sections, "C" for appendices. */
	ref: string;
	raw: string;
	/** 0-based column of `raw` on its line — the EXACT occurrence, so a ref that
	 *  is a textual prefix of another ("§8" inside "§8.1") resolves correctly. */
	col: number;
}

/** A markdown link to a same-file or cross-file anchor/path. */
export interface AnchorLink {
	line: number;
	/** Relative file target, if the link leaves the file (undefined = same file). */
	targetFile?: string;
	/** Anchor slug after '#', if any. */
	anchor?: string;
	raw: string;
}

/** Tense classification for a path reference. */
export type PathTense = "present" | "future" | "unknown";

/** A backticked repo-relative path mentioned in prose. */
export interface PathRef {
	line: number;
	path: string;
	tense: PathTense;
	raw: string;
}

/** A declared fact marker: <!-- fact:NAME -->value<!-- /fact:NAME -->. */
export interface DeclaredFact {
	name: string;
	value: string;
	line: number;
}

/** A fenced code block span (inclusive lines of the fence markers). */
export interface FencedBlock {
	startLine: number;
	endLine: number;
	lang: string;
}

/** A guarantee-verb sentence, and whether it carries a [claim: …] tag. */
export interface ClaimSentence {
	line: number;
	verb: string;
	tagged: boolean;
	text: string;
}

/** Everything extracted from one file. */
export interface SpecFacts {
	filePath: string;
	lineCount: number;
	namespaces: IdNamespace[];
	/** Sub-threshold DEFINED ids the global census folds into qualifying prefixes. */
	looseDefinedIds: LooseId[];
	countClaims: CountClaim[];
	rangeClaims: RangeClaim[];
	headings: HeadingInfo[];
	sectionRefs: SectionRef[];
	anchorLinks: AnchorLink[];
	pathRefs: PathRef[];
	declaredFacts: DeclaredFact[];
	fencedBlocks: FencedBlock[];
	claimSentences: ClaimSentence[];
}

/** File extensions the spec substrate applies to. */
const SPEC_EXTS = new Set([".md", ".mdx", ".markdown"]);

/** Whether the spec-facts extractors apply to this path. */
export function isSpecEligibleFile(filePath: string): boolean {
	const dot = filePath.lastIndexOf(".");
	if (dot < 0) return false;
	return SPEC_EXTS.has(filePath.slice(dot).toLowerCase());
}

/** Trim + cap a source line for display (InlineMatch convention). */
export function siteText(line: string): string {
	return line.trim().slice(0, 150);
}
