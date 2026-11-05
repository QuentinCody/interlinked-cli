// ===========================================
// Kill proof — receipts and freshness
// ===========================================
// Store, parsing, ids and the index (freshness lives in receipt-freshness.ts).
// A receipt lives at `.interlinked/test-runs/kill-proofs/<id>.json`; `index.json`
// beside it is REBUILT from the receipt files on every write (never read-modify-
// write, review R12) and is only a LOCATOR: every decision (Stop check, nudge,
// `--verify`) reads the receipt FILE and never trusts an index row's verdict or
// `killedTests` (review K2). A receipt carries a `digest` over all its other
// fields, so an edited outcome no longer matches (review K3); `id` stays the
// idempotence key over the inputs. A receipt certifies ONLY the test files in
// `killedTests` (review R2), per file: the source bytes, THAT test file's bytes
// and the runtime (review K13), plus every helper in that file's local import
// closure (`boundImports`, review K11: a changed helper stales the tests that
// import it, and only those). It is tamper-EVIDENT, not tamper-PROOF: the
// digest is unkeyed, so a receipt rewritten from scratch with recomputed hashes
// passes; receipts are evidence of execution on this machine, not a security
// boundary (CLAUDE.md: local checks are not a trust boundary).

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withFileMutationLock } from "../../lib/file-mutation-lock.js";
import { isJsonObject } from "../../lib/json-types.js";
import { bindVitestConfig, CONFIG_NAMES, normalizeRel } from "./config-binding.js";
import type { BoundImport, CaseOutcome, HashedFile, KillProofReceipt, ProofEnvironment, ResolvedMutant } from "./types.js";

export const KILL_PROOFS_DIR = ".interlinked/test-runs/kill-proofs";
const INDEX_FILE = "index.json";
const ID_RE = /^[0-9a-f]{16}$/;
const VERDICTS = new Set<KillProofReceipt["verdict"]>(["killed", "survived", "inconclusive"]);
const CASE_VERDICTS = new Set<CaseOutcome["verdict"]>(["killed", "survived", "inconclusive"]);
const MUTANT_SOURCES = new Set<ResolvedMutant["source"]>(["manifest", "explicit"]);

/** One index row: a locator plus display fields. Decisions never read `verdict` or `killedTests` from here. */
export interface KillProofIndexRow {
	id: string;
	verdict: KillProofReceipt["verdict"];
	provedAt: string;
	source: HashedFile;
	tests: HashedFile[];
	killedTests: string[];
	mutant: string;
	/** Review M8: the id of the NEWEST receipt with the same proof key (`proofKey`); this row is history and is never evidence. */
	supersededBy?: string;
}

export interface KillProofIndex { version: 1; receipts: KillProofIndexRow[]; }

export function killProofsDir(root: string): string {
	return join(root, KILL_PROOFS_DIR);
}

/**
 * The proof a receipt is one attempt at: the source file, the mutant's identity (manifest
 * id, or for an explicit fault its file, lexeme and replacement — an explicit `--find`
 * occurs exactly once, so the offset is not part of the identity and a proof renewed
 * after an edit above the fault is the same proof) and the named test set. The newest
 * receipt (`provedAt`) for a key is the proof's current state; every older one is
 * SUPERSEDED (review M8): kept on disk as history, marked in the index, skipped by every
 * evidence reader and never a `--verify` failure.
 */
export function proofKey(receipt: Pick<KillProofReceipt, "source" | "mutant" | "tests">): string {
	const mutant = receipt.mutant.mutantId !== undefined ? `manifest:${receipt.mutant.mutantId}` : `explicit:${receipt.mutant.file}\u0000${receipt.mutant.originalLexeme}\u0000${receipt.mutant.replacement}`;
	return [receipt.source.path, mutant, ...receipt.tests.map(test => test.path).sort()].join("\u0001");
}

export function sha256Text(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function hashFile(root: string, path: string): HashedFile | null {
	const abs = join(root, path);
	if (!existsSync(abs)) return null;
	return { path, sha256: createHash("sha256").update(readFileSync(abs)).digest("hex") };
}

/** The `--config <file>` a project's `scripts.test` passes to vitest, repo-relative and normalized (`./x` is `x`, round-4 A6); null when none (review N5). */
export function declaredVitestConfig(root: string): string | null {
	try {
		const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const script = isJsonObject(pkg) && isJsonObject(pkg.scripts) ? pkg.scripts.test : undefined;
		if (typeof script !== "string" || !/\bvitest\b/.test(script)) return null;
		const match = /(?:^|\s)(?:--config|-c)(?:=|\s+)(["']?)([^\s"']+)\1/.exec(script);
		const file = match?.[2];
		return file !== undefined && existsSync(join(root, file)) ? normalizeRel(file) : null;
	} catch {
		return null;
	}
}

/** The vitest config in use, as vitest resolves it: an explicit one, else the one `scripts.test` declares, else `vitest.config.*` then `vite.config.*` (`CONFIG_NAMES` order). */
export function resolveVitestConfig(root: string, explicit?: string): string | null {
	if (explicit !== undefined) return normalizeRel(explicit);
	return declaredVitestConfig(root) ?? CONFIG_NAMES.find(name => existsSync(join(root, name))) ?? null;
}

/** The `setupFiles` / `globalSetup` paths the config (and every config it reaches) declares, repo-relative (review N9; `config-binding.ts`). */
export function configDeclaredInputs(root: string, configPath: string | null): string[] {
	return bindVitestConfig(root, configPath).setupFiles;
}

const hashAll = (root: string, paths: readonly string[]): HashedFile[] => paths.map(path => hashFile(root, path)).filter((h): h is HashedFile => h !== null);

/** Node, vitest (resolved from the project), platform, the hashed vitest/vite config, the other config files it loads and the inputs they declare. */
export function captureEnvironment(root: string, configPath?: string): ProofEnvironment {
	let vitest: string | null = null;
	try {
		const require = createRequire(join(root, "package.json"));
		const pkg: unknown = require("vitest/package.json");
		if (isJsonObject(pkg) && typeof pkg.version === "string") vitest = pkg.version;
	} catch {
		vitest = null;
	}
	const config = resolveVitestConfig(root, configPath);
	const binding = bindVitestConfig(root, config);
	return { node: process.version, vitest, platform: `${process.platform}-${process.arch}`, config: config ? hashFile(root, config) : null, setupFiles: hashAll(root, binding.setupFiles), configFiles: hashAll(root, binding.configFiles), unresolvable: binding.unresolvable };
}

/** A quoted snippet cut to `max` characters, with an ellipsis when cut so a clipped label never reads as the full text. */
const clipQuoted = (text: string, max: number): string => {
	const quoted = JSON.stringify(text);
	return quoted.length <= max ? quoted : `${quoted.slice(0, max - 1)}…`;
};

export function mutantLabel(mutant: ResolvedMutant): string {
	const head = mutant.source === "manifest" ? `${mutant.mutantId} ${mutant.mutator} in ${mutant.qualifiedName}` : "explicit fault";
	return `${head} @ ${mutant.file}:${mutant.line} ${clipQuoted(mutant.originalLexeme, 60)} → ${clipQuoted(mutant.replacement, 40)}`;
}

/** Same bytes, same mutant, same runtime ⇒ same id; a re-run overwrites rather than duplicates. */
export function receiptId(parts: { source: HashedFile; mutant: ResolvedMutant; tests: HashedFile[]; boundImports: readonly BoundImport[]; boundImportsTruncated?: true; environment: ProofEnvironment }): string {
	const binding = [
		parts.source.path, parts.source.sha256,
		parts.mutant.file, String(parts.mutant.offset), parts.mutant.originalLexeme, parts.mutant.replacement, parts.mutant.mutantId ?? "",
		...parts.tests.map(test => `${test.path}=${test.sha256}`),
		...parts.boundImports.map(file => `helper:${file.path}=${file.sha256}<${file.importedBy.join(",")}`),
		...(parts.boundImportsTruncated === true ? ["helpers:truncated"] : []),
		parts.environment.node, parts.environment.vitest ?? "", parts.environment.platform, parts.environment.config?.sha256 ?? "",
		...parts.environment.setupFiles.map(file => `${file.path}=${file.sha256}`),
		...parts.environment.configFiles.map(file => `config:${file.path}=${file.sha256}`),
		...parts.environment.unresolvable.map(what => `unresolvable:${what}`),
	].join("\u0000");
	return sha256Text(binding).slice(0, 16);
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isJsonObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
	return JSON.stringify(value);
}

/** The digest over every field but `digest` itself (canonical JSON, sorted keys). */
export function receiptDigest(receipt: KillProofReceipt): string {
	const { digest: _digest, ...rest } = receipt;
	return sha256Text(canonical(rest));
}

export function sealReceipt(receipt: KillProofReceipt): KillProofReceipt {
	return { ...receipt, digest: receiptDigest(receipt) };
}

function writeAtomic(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

// ---- parsing (constructing parsers: a mismatch is null, never partially trusted) ----

function parseHashed(value: unknown): HashedFile | null {
	if (!isJsonObject(value) || typeof value.path !== "string" || typeof value.sha256 !== "string") return null;
	return { path: value.path, sha256: value.sha256 };
}

function parseHashedList(value: unknown): HashedFile[] | null {
	if (!Array.isArray(value)) return null;
	const out: HashedFile[] = [];
	for (const item of value) {
		const parsed = parseHashed(item);
		if (parsed === null) return null;
		out.push(parsed);
	}
	return out;
}

function parseBoundImports(value: unknown): BoundImport[] | null {
	if (!Array.isArray(value)) return null;
	const out: BoundImport[] = [];
	for (const item of value) {
		const hashed = parseHashed(item);
		const importedBy = isJsonObject(item) ? parseStringList(item.importedBy) : null;
		if (hashed === null || importedBy === null) return null;
		out.push({ ...hashed, importedBy });
	}
	return out;
}

function parseStringList(value: unknown): string[] | null {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? (value as string[]) : null;
}

function parseMutant(value: unknown): ResolvedMutant | null {
	if (!isJsonObject(value) || typeof value.file !== "string" || typeof value.offset !== "number" || typeof value.line !== "number") return null;
	if (typeof value.originalLexeme !== "string" || typeof value.replacement !== "string") return null;
	if (typeof value.source !== "string" || !MUTANT_SOURCES.has(value.source as ResolvedMutant["source"])) return null;
	const mutant: ResolvedMutant = { file: value.file, offset: value.offset, originalLexeme: value.originalLexeme, replacement: value.replacement, line: value.line, source: value.source as ResolvedMutant["source"] };
	for (const key of ["mutantId", "siteId", "symbolId", "qualifiedName", "mutator", "manifestStatus", "lineText"] as const) {
		if (typeof value[key] === "string") mutant[key] = value[key] as string;
	}
	for (const key of ["ordinalWithinSymbol", "manifestGeneration"] as const) {
		if (typeof value[key] === "number") mutant[key] = value[key] as number;
	}
	return mutant;
}

function parseCases(value: unknown): CaseOutcome[] | null {
	if (!Array.isArray(value)) return null;
	const out: CaseOutcome[] = [];
	for (const item of value) {
		if (!isJsonObject(item) || typeof item.test !== "string" || typeof item.verdict !== "string" || !CASE_VERDICTS.has(item.verdict as CaseOutcome["verdict"])) return null;
		out.push({ test: item.test, verdict: item.verdict as CaseOutcome["verdict"], ...(typeof item.reason === "string" ? { reason: item.reason } : {}) });
	}
	return out;
}

function parseEnvironment(value: unknown): ProofEnvironment | null {
	if (!isJsonObject(value) || typeof value.node !== "string" || typeof value.platform !== "string") return null;
	if (value.vitest !== null && typeof value.vitest !== "string") return null;
	const config = value.config === null ? null : parseHashed(value.config);
	if (value.config !== null && config === null) return null;
	// No default for an absent `configFiles` / `unresolvable`: a receipt that does not bind the configs vitest loads is not a receipt (unreleased field, as `boundImports`).
	const setupFiles = parseHashedList(value.setupFiles), configFiles = parseHashedList(value.configFiles), unresolvable = parseStringList(value.unresolvable);
	if (setupFiles === null || configFiles === null || unresolvable === null) return null;
	return { node: value.node, vitest: value.vitest, platform: value.platform, config, setupFiles, configFiles, unresolvable };
}

export function parseKillProof(value: unknown): KillProofReceipt | null {
	if (!isJsonObject(value) || value.version !== 1 || typeof value.id !== "string" || !ID_RE.test(value.id)) return null;
	if (typeof value.digest !== "string" || typeof value.provedAt !== "string" || typeof value.root !== "string") return null;
	if (typeof value.verdict !== "string" || !VERDICTS.has(value.verdict as KillProofReceipt["verdict"])) return null;
	const reasons = parseStringList(value.reasons), killedTests = parseStringList(value.killedTests);
	const source = parseHashed(value.source), mutant = parseMutant(value.mutant), tests = parseHashedList(value.tests), environment = parseEnvironment(value.environment);
	// No default for an absent `boundImports`: a receipt that does not bind its helpers is not a receipt (unreleased field).
	const boundImports = parseBoundImports(value.boundImports);
	if (reasons === null || killedTests === null || source === null || mutant === null || tests === null || boundImports === null || environment === null) return null;
	// The truncation flag is either absent or exactly `true` (round 5, R5-3); any other value is not a receipt.
	if (value.boundImportsTruncated !== undefined && value.boundImportsTruncated !== true) return null;
	const { baseline, underMutant } = value;
	if (!isJsonObject(baseline) || typeof baseline.cases !== "number" || typeof baseline.durationMs !== "number") return null;
	if (!isJsonObject(underMutant) || typeof underMutant.durationMs !== "number" || typeof underMutant.timedOut !== "boolean") return null;
	const cases = parseCases(underMutant.cases);
	if (cases === null) return null;
	return {
		version: 1, id: value.id, digest: value.digest, verdict: value.verdict as KillProofReceipt["verdict"], reasons, provedAt: value.provedAt, root: value.root,
		source, mutant, tests, boundImports, ...(value.boundImportsTruncated === true ? { boundImportsTruncated: true as const } : {}), killedTests, baseline: { cases: baseline.cases, durationMs: baseline.durationMs },
		underMutant: { durationMs: underMutant.durationMs, timedOut: underMutant.timedOut, cases, ...(typeof underMutant.error === "string" ? { error: underMutant.error } : {}) },
		environment,
	};
}

export function parseKillProofIndex(value: unknown): KillProofIndex | null {
	if (!isJsonObject(value) || value.version !== 1 || !Array.isArray(value.receipts)) return null;
	const receipts: KillProofIndexRow[] = [];
	for (const row of value.receipts) {
		if (!isJsonObject(row) || typeof row.id !== "string" || !ID_RE.test(row.id) || typeof row.verdict !== "string" || !VERDICTS.has(row.verdict as KillProofReceipt["verdict"])) return null;
		if (typeof row.provedAt !== "string" || typeof row.mutant !== "string") return null;
		if (row.supersededBy !== undefined && (typeof row.supersededBy !== "string" || !ID_RE.test(row.supersededBy))) return null;
		const source = parseHashed(row.source), tests = parseHashedList(row.tests), killedTests = parseStringList(row.killedTests);
		if (source === null || tests === null || killedTests === null) return null;
		receipts.push({ id: row.id, verdict: row.verdict as KillProofReceipt["verdict"], provedAt: row.provedAt, source, tests, killedTests, mutant: row.mutant, ...(typeof row.supersededBy === "string" ? { supersededBy: row.supersededBy } : {}) });
	}
	return { version: 1, receipts };
}

// ---- store ----

function readReceiptAt(dir: string, id: string): KillProofReceipt | null {
	if (!ID_RE.test(id)) return null;
	const path = join(dir, `${id}.json`);
	if (!existsSync(path)) return null;
	try {
		const receipt = parseKillProof(JSON.parse(readFileSync(path, "utf8")));
		return receipt !== null && receipt.id === id ? receipt : null;
	} catch {
		return null;
	}
}

/** The receipt at `<id>.json`, only when it says it IS `id` (review M11: a copied file is not a second receipt). */
export function readKillProof(root: string, id: string): KillProofReceipt | null {
	return readReceiptAt(killProofsDir(root), id);
}

export function listKillProofIds(root: string): string[] {
	const dir = killProofsDir(root);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter(name => /^[0-9a-f]{16}\.json$/.test(name)).map(name => name.slice(0, 16)).sort();
}

/** The newest receipt per proof key (review M8); the receipts to judge a proof by. */
export function newestPerProofKey<T extends Pick<KillProofReceipt, "id" | "provedAt" | "source" | "mutant" | "tests">>(receipts: readonly T[]): Map<string, T> {
	const newest = new Map<string, T>();
	for (const receipt of receipts) {
		const key = proofKey(receipt), known = newest.get(key);
		if (known === undefined || receipt.provedAt > known.provedAt || (receipt.provedAt === known.provedAt && receipt.id < known.id)) newest.set(key, receipt);
	}
	return newest;
}

function indexRow(receipt: KillProofReceipt): KillProofIndexRow {
	return { id: receipt.id, verdict: receipt.verdict, provedAt: receipt.provedAt, source: receipt.source, tests: receipt.tests, killedTests: receipt.killedTests, mutant: mutantLabel(receipt.mutant) };
}

/** The index is a projection of the receipt FILES: rebuilt, never patched, so a concurrent writer loses nothing. */
export function rebuildKillProofIndex(root: string): KillProofIndex {
	const receipts = listKillProofIds(root).map(id => readKillProof(root, id)).filter((r): r is KillProofReceipt => r !== null);
	const newest = newestPerProofKey(receipts);
	return {
		version: 1,
		receipts: receipts.map(receipt => {
			const current = newest.get(proofKey(receipt));
			return current !== undefined && current.id !== receipt.id ? { ...indexRow(receipt), supersededBy: current.id } : indexRow(receipt);
		}),
	};
}

export function readKillProofIndex(root: string): KillProofIndex {
	const path = join(killProofsDir(root), INDEX_FILE);
	if (!existsSync(path)) return { version: 1, receipts: [] };
	try {
		return parseKillProofIndex(JSON.parse(readFileSync(path, "utf8"))) ?? { version: 1, receipts: [] };
	} catch {
		return { version: 1, receipts: [] };
	}
}

/** Index rebuild lock budget: short, a few retries; contention leaves the index to the next writer. */
const INDEX_LOCK = { waitMs: 250, retryMs: 25 } as const;

/**
 * Write the receipt, then rebuild the index from the files on disk (temp → rename, both).
 * The list-and-rename runs under an exclusive lock (review K12: without it, a writer that
 * listed before another's receipt landed could rename its older index over the newer one).
 * On lock failure the receipt is written and the index is left for the next writer — it is
 * only a locator, so nothing throws. Returns the receipt path.
 */
export function writeKillProof(root: string, receipt: KillProofReceipt): string {
	const dir = killProofsDir(root);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${receipt.id}.json`);
	writeAtomic(path, `${JSON.stringify(receipt, null, 1)}\n`);
	const indexPath = join(dir, INDEX_FILE);
	try {
		// The rebuild also marks every older receipt of this receipt's proof key as superseded (review M8).
		withFileMutationLock(indexPath, () => writeAtomic(indexPath, `${JSON.stringify(rebuildKillProofIndex(root), null, 1)}\n`), INDEX_LOCK);
	} catch {
		// Contended or unlockable: the next writer rebuilds the index from every receipt file, this one included.
	}
	return path;
}
