// Cross-file spec fact ledger (docs/design/spec-audit-runtime-checks.md
// §3.2, spike 2). Holds per-file SpecFacts for every markdown file under a
// repo root and answers the cross-file drift questions the single-file
// checks structurally cannot: "six bets" in README vs the B1..B7 census in
// the plan (Sol D-1), "FG-INV-01 … FG-INV-20" vs a FG-INV-28 census (D-2),
// declared-fact disagreement, and cross-file anchor integrity.
//
// Derived, rebuildable state (the trigram-index doctrine): the working tree
// stays canonical; the ledger refreshes per edit via refreshFile and is
// rebuilt on daemon restart. Deterministic only — counting and set algebra.
// Nothing here is silent: bounded walks record skips and truncation. The
// drift append helpers live in ledger-drift.ts (line-cap split).

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { localNounBindings } from "./binding.js";
import { extractSpecFacts } from "./extract-facts.js";
import {
	appendCountDrift,
	appendRangeDrift,
	foldLooseDefinedIds,
	type GlobalNamespace,
	type SpecDriftFinding,
} from "./ledger-drift.js";
import {
	computeXrefDrift,
	resolveRelativeTarget as xrefResolveTarget,
} from "./ledger-xref.js";
import type { IdNamespace, SpecFacts } from "./types.js";
import { isSpecEligibleFile } from "./types.js";

// Public API stability: consumers import the finding type from here.
export type { SpecDriftFinding } from "./ledger-drift.js";
// resolveRelativeTarget moved to ledger-xref.ts; re-exported for back-compat.
export { resolveRelativeTarget } from "./ledger-xref.js";

const EXCLUDED_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	"coverage",
	".interlinked",
	"vendor",
	"third_party",
	".next",
]);
const MAX_FILES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 8;
/** Caps on declared-fact-drift output — bound the O(sites²) string blowup
 *  (round-2 #3): at most this many sites quoted in a summary, and at most
 *  this many findings emitted per disagreeing fact name. */
const FACT_SUMMARY_CAP = 8;
const FACT_FINDING_CAP = 10;

type FactSite = { file: string; line: number; value: string };
/** Representative slices for bounded declared-fact-drift output (sol-max #5):
 *  `summary` is one site per DISTINCT VALUE (so every contradicting value shows);
 *  `findings` lists those value-representative files FIRST, then fills with other
 *  disagreeing files up to `findingCap` — so the contradictory value/file always
 *  survives the cap even behind a long run of an agreeing value, while still
 *  emitting one finding per involved file when they fit. */
function representativeSites(
	list: FactSite[],
	findingCap: number,
	pinFile?: string,
): { summary: FactSite[]; findings: FactSite[] } {
	const perValue = new Map<string, FactSite>();
	for (const s of list) {
		if (!perValue.has(s.value)) perValue.set(s.value, s);
	}
	const summary = [...perValue.values()];
	const findings: FactSite[] = [];
	const seen = new Set<string>();
	const take = (s: FactSite | undefined): void => {
		if (s && !seen.has(s.file) && findings.length < findingCap) {
			seen.add(s.file);
			findings.push(s);
		}
	};
	// scoped file first so a scoped query never drops it (sol-max #6); then one per
	// distinct VALUE; then fill by file — all bounded by findingCap (sol-max #12).
	if (pinFile) take(list.find((s) => s.file === pinFile));
	for (const s of summary) take(s);
	for (const s of list) take(s);
	return { summary, findings };
}

/** Whether any count/range claim in `facts` binds to a namespace key in `keys`
 *  — the test for whether a file can contribute a count/range finding involving
 *  the scoped file (sol-max #19). Range keys are direct; count keys come through
 *  the merged noun→namespace bindings (covers the D-1 no-local-ids case). */
function claimsTouchKeys(
	facts: SpecFacts,
	bindings: Map<string, Set<string>>,
	keys: Set<string>,
): boolean {
	for (const c of facts.rangeClaims) {
		if (keys.has(`${c.style} ${c.prefix}`)) return true;
	}
	for (const c of facts.countClaims) {
		const bound = bindings.get(c.nounSingular);
		if (bound) {
			for (const k of bound) if (keys.has(k)) return true;
		}
	}
	return false;
}

export class SpecLedger {
	private files = new Map<string, SpecFacts>();
	/** Content hash per loaded file — lets refreshFile no-op on unchanged content,
	 *  so a redundant post-prerefresh refresh doesn't invalidate the memos (#15). */
	private fileHashes = new Map<string, string>();
	private truncated = false;
	private skipped = 0;
	/** Repo-relative paths skipped for size/readability — absence from the
	 *  ledger must not read as absence from the filesystem (round-4 #2). */
	private skippedPaths = new Set<string>();
	/** Mutation counter — invalidates the census/bindings memos below, keeping the
	 *  PreToolUse preview path off the O(all files) recompute (round-5 #4). */
	private version = 0;
	private censusMemo: { version: number; value: Map<string, GlobalNamespace> } | null =
		null;
	private bindingsMemo: { version: number; value: Map<string, Set<string>> } | null =
		null;

	constructor(
		readonly repoRoot: string,
		private readonly fileExists: (absPath: string) => boolean = existsSync,
	) {}

	/** Build from a directory walk (bounded; see caps above). */
	static build(
		repoRoot: string,
		fileExists?: (absPath: string) => boolean,
	): SpecLedger {
		const ledger = new SpecLedger(repoRoot, fileExists);
		ledger.walk(repoRoot, "", 0);
		return ledger;
	}

	/** Build directly from contents — tests and fixture corpora. */
	static fromContents(
		repoRoot: string,
		contents: Record<string, string>,
		fileExists?: (absPath: string) => boolean,
	): SpecLedger {
		const ledger = new SpecLedger(repoRoot, fileExists);
		for (const [rel, content] of Object.entries(contents)) {
			ledger.refreshFile(rel, content);
		}
		return ledger;
	}

	private walk(absDir: string, relDir: string, depth: number): void {
		if (this.truncated) return;
		// A subtree past the depth cap is OMITTED — record it (sol-max #24) so the
		// omission is not silent; xref existence consults the filesystem predicate
		// directly, so a deep target is never mis-reported as missing.
		if (depth > MAX_DEPTH) {
			this.skipped++;
			return;
		}
		let entries: import("node:fs").Dirent[] = [];
		try {
			entries = readdirSync(absDir, { withFileTypes: true });
		} catch {
			// Unreadable directory in an advisory walker: record and move on.
			this.skipped++;
			return;
		}
		// Deterministic order so the MAX_FILES cap is machine-independent (sol-max #22).
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			// Read through the public getter, not the bare field: `loadFile`/`walk`
			// calls inside this loop can flip `truncated` mid-iteration (a prior
			// entry hitting MAX_FILES), and the type checker's narrowing of a
			// private field doesn't survive that — the getter call keeps this a
			// live re-read every iteration, which is the actual required behavior.
			if (this.wasTruncated) return;
			const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
				this.walk(join(absDir, entry.name), rel, depth + 1);
			} else if (entry.isFile() && isSpecEligibleFile(entry.name)) {
				this.loadFile(join(absDir, entry.name), rel);
			}
		}
	}

	private loadFile(absPath: string, rel: string): void {
		if (this.files.size >= MAX_FILES) {
			this.truncated = true;
			return;
		}
		try {
			if (statSync(absPath).size > MAX_FILE_BYTES) {
				this.skipped++;
				this.skippedPaths.add(rel);
				return;
			}
			this.setFacts(rel, readFileSync(absPath, "utf8"));
		} catch {
			// Unreadable file in an advisory walker: record and move on.
			this.skipped++;
			this.skippedPaths.add(rel);
		}
	}

	/** Extract and store one file's facts, bumping the version ONLY when the
	 *  content actually changed (round-2 #15). A repeated refresh with
	 *  identical content is a true no-op: it neither re-extracts nor
	 *  invalidates the census/binding memos, so the redundant per-file refresh
	 *  after a multi-file prerefresh costs O(1), not a full-ledger recompute. */
	private setFacts(relPath: string, content: string): void {
		const hash = createHash("sha256").update(content).digest("hex");
		if (this.files.has(relPath) && this.fileHashes.get(relPath) === hash) return;
		this.files.set(relPath, extractSpecFacts(content, relPath));
		this.fileHashes.set(relPath, hash);
		this.version++;
	}

	/** Re-extract one file after an edit (the in-session dirty layer). */
	refreshFile(relPath: string, content: string): void {
		if (!isSpecEligibleFile(relPath)) return;
		this.skippedPaths.delete(relPath); // content in hand → no longer skipped (sol-max #7)
		this.setFacts(relPath, content);
	}

	removeFile(relPath: string): void {
		this.files.delete(relPath);
		this.fileHashes.delete(relPath);
		this.skippedPaths.delete(relPath); // removed ≠ skipped-but-present (sol-max #7)
		this.version++;
	}

	/** Test seam: the mutation counter. A same-content refresh must leave this
	 *  unchanged (round-2 #15) so the memos survive. */
	versionForTesting(): number {
		return this.version;
	}

	/**
	 * A hypothetical ledger with one file's content replaced — the
	 * PreToolUse preview. Shallow-copies the facts map (SpecFacts are
	 * immutable once extracted); the real ledger is untouched, so a denied
	 * write never contaminates state.
	 */
	previewWithFile(relPath: string, content: string): SpecLedger {
		const preview = new SpecLedger(this.repoRoot, this.fileExists);
		preview.files = new Map(this.files);
		preview.fileHashes = new Map(this.fileHashes);
		preview.truncated = this.truncated;
		preview.skipped = this.skipped;
		preview.skippedPaths = new Set(this.skippedPaths);
		preview.refreshFile(relPath, content);
		return preview;
	}

	get fileCount(): number {
		return this.files.size;
	}

	/** Files/directories skipped for size or readability — never silent. */
	get skippedCount(): number {
		return this.skipped;
	}

	get wasTruncated(): boolean {
		return this.truncated;
	}

	factsOf(relPath: string): SpecFacts | undefined {
		return this.files.get(relPath);
	}

	/** Repo-relative paths of every file in the ledger (agenda/CLI surface). */
	fileList(): string[] {
		return [...this.files.keys()];
	}

	/** Names of declared fact markers currently in cross-file disagreement.
	 *  Pre-gates diff this set between live and preview ledgers to detect an
	 *  INTRODUCED disagreement (the only pre_block-grade spec event). */
	declaredFactNamesInDisagreement(): Set<string> {
		const values = new Map<string, Set<string>>();
		for (const facts of this.files.values()) {
			for (const fact of facts.declaredFacts) {
				const set = values.get(fact.name);
				if (set) set.add(fact.value);
				else values.set(fact.name, new Set([fact.value]));
			}
		}
		const out = new Set<string>();
		for (const [name, vals] of values) {
			if (vals.size > 1) out.add(name);
		}
		return out;
	}

	/** Values a declared fact holds in files OTHER than `excludeFile` — the
	 *  marker pre-gate's evidence base (round-5 #2). */
	declaredFactValuesElsewhere(name: string, excludeFile: string): Set<string> {
		const out = new Set<string>();
		for (const [file, facts] of this.files) {
			if (file === excludeFile) continue;
			for (const fact of facts.declaredFacts) {
				if (fact.name === name) out.add(fact.value);
			}
		}
		return out;
	}

	/** Sites in OTHER files whose links target `relPath` at one of `slugs` —
	 *  the anchor-deletion pre-warn's referrer list. */
	externalReferrersTo(
		relPath: string,
		slugs: Set<string>,
	): Array<{ file: string; line: number; anchor: string }> {
		const out: Array<{ file: string; line: number; anchor: string }> = [];
		for (const [file, facts] of this.files) {
			if (file === relPath) continue;
			for (const link of facts.anchorLinks) {
				if (!link.targetFile || !link.anchor || !slugs.has(link.anchor)) continue;
				if (xrefResolveTarget(file, link.targetFile) !== relPath) continue;
				out.push({ file, line: link.line, anchor: link.anchor });
			}
		}
		return out;
	}

	/** Merge per-file censuses into global namespaces, keyed "style prefix".
	 *  Memoized per ledger version (the Pre hot path calls this repeatedly). */
	private globalCensus(): Map<string, GlobalNamespace> {
		if (this.censusMemo?.version === this.version) return this.censusMemo.value;
		const global = this.computeGlobalCensus();
		this.censusMemo = { version: this.version, value: global };
		return global;
	}

	private computeGlobalCensus(): Map<string, GlobalNamespace> {
		const global = new Map<string, GlobalNamespace>();
		for (const [file, facts] of this.files) {
			for (const ns of facts.namespaces) {
				const key = `${ns.style} ${ns.prefix}`;
				let g = global.get(key);
				if (!g) {
					g = {
						prefix: ns.prefix,
						style: ns.style,
						nums: new Set<number>(),
						max: 0,
						files: [],
						definingFiles: [],
					};
					global.set(key, g);
				}
				for (const id of ns.ids) g.nums.add(id.num);
				g.max = Math.max(g.max, ns.max);
				g.files.push(file);
				if (ns.ids.some((i) => i.defSites.length > 0)) g.definingFiles.push(file);
			}
		}
		foldLooseDefinedIds(global, this.files); // sub-threshold fragments (sol-max #1)
		return global;
	}

	/** Noun→namespace bindings merged across all files. Memoized per version. */
	private mergedBindings(): Map<string, Set<string>> {
		if (this.bindingsMemo?.version === this.version) return this.bindingsMemo.value;
		const merged = this.computeMergedBindings();
		this.bindingsMemo = { version: this.version, value: merged };
		return merged;
	}

	private computeMergedBindings(): Map<string, Set<string>> {
		const merged = new Map<string, Set<string>>();
		for (const facts of this.files.values()) {
			for (const [noun, keys] of localNounBindings(facts)) {
				const set = merged.get(noun);
				if (set) for (const k of keys) set.add(k);
				else merged.set(noun, new Set(keys));
			}
		}
		return merged;
	}

	/** Style-qualified namespace keys the file participates in. */
	private namespaceKeysOf(rel: string): Set<string> {
		const facts = this.files.get(rel);
		return new Set(facts ? facts.namespaces.map((n) => `${n.style} ${n.prefix}`) : []);
	}

	/** Declared-fact names the file declares. */
	private declaredFactNamesOf(rel: string): Set<string> {
		const facts = this.files.get(rel);
		return new Set(facts ? facts.declaredFacts.map((f) => f.name) : []);
	}

	/** A non-scope file with no claim binding to a scope namespace cannot produce
	 *  a scope-relevant count/range finding (sol-max #19), so it is skipped. */
	private outsideCountScope(
		file: string,
		facts: SpecFacts,
		scope: string | undefined,
		scopeKeys: Set<string> | null,
		bindings: Map<string, Set<string>>,
	): boolean {
		if (!scopeKeys || file === scope) return false;
		return !claimsTouchKeys(facts, bindings, scopeKeys);
	}

	/**
	 * All cross-file findings, optionally scoped to those involving one file
	 * (as anchor or as a related site) — the per-edit query.
	 */
	computeDrift(scopeRelPath?: string): SpecDriftFinding[] {
		const findings = [
			...this.countAndRangeDrift(scopeRelPath),
			...this.declaredFactDrift(scopeRelPath),
			...this.xrefDrift(scopeRelPath),
		];
		if (!scopeRelPath) return findings;
		return findings.filter(
			(f) => f.file === scopeRelPath || f.relatedFiles.includes(scopeRelPath),
		);
	}

	private countAndRangeDrift(scope?: string): SpecDriftFinding[] {
		const out: SpecDriftFinding[] = [];
		const global = this.globalCensus();
		const bindings = this.mergedBindings();
		const scopeKeys = scope ? this.namespaceKeysOf(scope) : null;
		for (const [file, facts] of this.files) {
			if (this.outsideCountScope(file, facts, scope, scopeKeys, bindings)) continue;
			const localByKey = new Map<string, IdNamespace>(
				facts.namespaces.map((n) => [`${n.style} ${n.prefix}`, n]),
			);
			appendCountDrift(out, file, facts, global, bindings, localByKey);
			appendRangeDrift(out, file, facts, global, localByKey);
		}
		return out;
	}

	private declaredFactDrift(scope?: string): SpecDriftFinding[] {
		const sites = new Map<
			string,
			Array<{ file: string; line: number; value: string }>
		>();
		for (const [file, facts] of this.files) {
			for (const fact of facts.declaredFacts) {
				const arr = sites.get(fact.name);
				const site = { file, line: fact.line, value: fact.value };
				if (arr) arr.push(site);
				else sites.set(fact.name, [site]);
			}
		}
		// Only fact NAMES the scoped file declares can involve scope (sol-max #19:
		// every such site is at/related to a same-name site).
		const scopeNames = scope === undefined ? null : this.declaredFactNamesOf(scope);
		const out: SpecDriftFinding[] = [];
		for (const [name, list] of sites) {
			if (scopeNames?.has(name) === false) continue;
			const values = new Set(list.map((s) => s.value));
			if (values.size < 2) continue;
			// REPRESENTATIVE + bounded (sol-max #5 / round-broaden #5): slicing raw
			// sites let a leading run of one value hide the contradictory value
			// and its file. Show one site per distinct VALUE; emit one finding per
			// distinct FILE (so a scoped computeDrift on the disagreeing file is
			// covered). Both are capped.
			const { summary: byValue, findings } = representativeSites(list, FACT_FINDING_CAP, scope);
			const shown = byValue.slice(0, FACT_SUMMARY_CAP);
			const overflow = byValue.length - shown.length;
			const summary =
				shown.map((s) => `${s.file}:${s.line}=${s.value}`).join(", ") +
				(overflow > 0 ? ` (+${overflow} more value(s))` : "");
			const relatedCapped = findings.slice(0, FACT_SUMMARY_CAP).map((s) => s.file);
			for (const site of findings) {
				out.push({
					kind: "declared_fact_drift",
					file: site.file,
					line: site.line,
					message: `declared fact "${name}" disagrees across files: ${summary}. One value is stale — find the source of truth and update the others.`,
					relatedFiles: relatedCapped.filter((f) => f !== site.file),
				});
			}
		}
		return out;
	}

	private xrefDrift(scope?: string): SpecDriftFinding[] {
		return computeXrefDrift({
			files: this.files,
			skippedPaths: this.skippedPaths,
			fileExists: this.fileExists,
			repoRoot: this.repoRoot,
			scope,
		});
	}
}
