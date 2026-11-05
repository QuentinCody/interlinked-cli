// ===========================================
// Kill proof — receipts and freshness
// ===========================================
// A receipt lives at `.interlinked/test-runs/kill-proofs/<id>.json`; `index.json`
// beside it is REBUILT from the receipt files on every write (never read-modify-
// write, review R12) and is only a LOCATOR: every decision (Stop check, nudge,
// `--verify`) reads the receipt FILE and never trusts an index row's verdict or
// `killedTests` (review K2). A receipt carries a `digest` over all its other
// fields, so an edited outcome no longer matches (review K3); `id` stays the
// idempotence key over the inputs. A receipt certifies ONLY the test files in
// `killedTests` (review R2), per file: the source bytes, THAT test file's bytes
// and the runtime (review K13). It is tamper-EVIDENT, not tamper-PROOF: the
// digest is unkeyed, so a receipt rewritten from scratch with recomputed hashes
// passes; receipts are evidence of execution on this machine, not a security
// boundary (CLAUDE.md: local checks are not a trust boundary).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import { lineTextAt, relocate } from "./resolve.js";
import type { CaseOutcome, Freshness, HashedFile, KillProofReceipt, ProofEnvironment, ResolvedMutant } from "./types.js";

export const KILL_PROOFS_DIR = ".interlinked/test-runs/kill-proofs";
const INDEX_FILE = "index.json";
const ID_RE = /^[0-9a-f]{16}$/;
const VERDICTS = new Set<KillProofReceipt["verdict"]>(["killed", "survived", "inconclusive"]);
const CASE_VERDICTS = new Set<CaseOutcome["verdict"]>(["killed", "survived", "inconclusive"]);
const MUTANT_SOURCES = new Set<ResolvedMutant["source"]>(["manifest", "explicit"]);
const CONFIG_NAMES = ["vitest.config.ts", "vitest.config.mts", "vitest.config.cts", "vitest.config.js", "vitest.config.mjs", "vitest.config.cjs", "vite.config.ts", "vite.config.mts", "vite.config.cts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"];

/** One index row: a locator plus display fields. Decisions never read `verdict` or `killedTests` from here. */
export interface KillProofIndexRow {
	id: string;
	verdict: KillProofReceipt["verdict"];
	provedAt: string;
	source: HashedFile;
	tests: HashedFile[];
	killedTests: string[];
	mutant: string;
}

export interface KillProofIndex { version: 1; receipts: KillProofIndexRow[]; }

export function killProofsDir(root: string): string {
	return join(root, KILL_PROOFS_DIR);
}

export function sha256Text(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function hashFile(root: string, path: string): HashedFile | null {
	const abs = join(root, path);
	if (!existsSync(abs)) return null;
	return { path, sha256: createHash("sha256").update(readFileSync(abs)).digest("hex") };
}

/** The `--config <file>` a project's `scripts.test` passes to vitest, repo-relative; null when none (review N5). */
export function declaredVitestConfig(root: string): string | null {
	try {
		const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const script = isJsonObject(pkg) && isJsonObject(pkg.scripts) ? pkg.scripts.test : undefined;
		if (typeof script !== "string" || !/\bvitest\b/.test(script)) return null;
		const match = /(?:^|\s)(?:--config|-c)(?:=|\s+)(["']?)([^\s"']+)\1/.exec(script);
		const file = match?.[2];
		return file !== undefined && existsSync(join(root, file)) ? file.replace(/\\/g, "/") : null;
	} catch {
		return null;
	}
}

/** The vitest config in use: an explicit one, else the project's declared one, else the first default name present. */
export function resolveVitestConfig(root: string, explicit?: string): string | null {
	if (explicit !== undefined) return explicit;
	return declaredVitestConfig(root) ?? CONFIG_NAMES.find(name => existsSync(join(root, name))) ?? null;
}

/** String literals under `setupFiles:` / `globalSetup:` in the config text, repo-relative (review N9: their bytes must be bound). */
export function configDeclaredInputs(root: string, configPath: string | null): string[] {
	if (configPath === null || !existsSync(join(root, configPath))) return [];
	const text = readFileSync(join(root, configPath), "utf8");
	const out: string[] = [];
	for (const match of text.matchAll(/\b(?:setupFiles|globalSetup)\s*:\s*(\[[^\]]*\]|["'`][^"'`]+["'`])/g)) {
		for (const literal of (match[1] ?? "").matchAll(/["'`]([^"'`]+)["'`]/g)) {
			const raw = literal[1] ?? "";
			if (raw.length === 0) continue;
			const rel = (isAbsolute(raw) ? relative(root, raw) : relative(root, join(root, configPath, "..", raw))).replace(/\\/g, "/");
			if (!rel.startsWith("..") && existsSync(join(root, rel)) && !out.includes(rel)) out.push(rel);
		}
	}
	return out;
}

/** Node, vitest (resolved from the project), platform, the hashed vitest/vite config and the inputs it declares. */
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
	const setupFiles = configDeclaredInputs(root, config).map(path => hashFile(root, path)).filter((h): h is HashedFile => h !== null);
	return { node: process.version, vitest, platform: `${process.platform}-${process.arch}`, config: config ? hashFile(root, config) : null, setupFiles };
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
export function receiptId(parts: { source: HashedFile; mutant: ResolvedMutant; tests: HashedFile[]; environment: ProofEnvironment }): string {
	const binding = [
		parts.source.path, parts.source.sha256,
		parts.mutant.file, String(parts.mutant.offset), parts.mutant.originalLexeme, parts.mutant.replacement, parts.mutant.mutantId ?? "",
		...parts.tests.map(test => `${test.path}=${test.sha256}`),
		parts.environment.node, parts.environment.vitest ?? "", parts.environment.platform, parts.environment.config?.sha256 ?? "",
		...parts.environment.setupFiles.map(file => `${file.path}=${file.sha256}`),
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
	const setupFiles = parseHashedList(value.setupFiles);
	if (setupFiles === null) return null;
	return { node: value.node, vitest: value.vitest, platform: value.platform, config, setupFiles };
}

export function parseKillProof(value: unknown): KillProofReceipt | null {
	if (!isJsonObject(value) || value.version !== 1 || typeof value.id !== "string" || !ID_RE.test(value.id)) return null;
	if (typeof value.digest !== "string" || typeof value.provedAt !== "string" || typeof value.root !== "string") return null;
	if (typeof value.verdict !== "string" || !VERDICTS.has(value.verdict as KillProofReceipt["verdict"])) return null;
	const reasons = parseStringList(value.reasons), killedTests = parseStringList(value.killedTests);
	const source = parseHashed(value.source), mutant = parseMutant(value.mutant), tests = parseHashedList(value.tests), environment = parseEnvironment(value.environment);
	if (reasons === null || killedTests === null || source === null || mutant === null || tests === null || environment === null) return null;
	const { baseline, underMutant } = value;
	if (!isJsonObject(baseline) || typeof baseline.cases !== "number" || typeof baseline.durationMs !== "number") return null;
	if (!isJsonObject(underMutant) || typeof underMutant.durationMs !== "number" || typeof underMutant.timedOut !== "boolean") return null;
	const cases = parseCases(underMutant.cases);
	if (cases === null) return null;
	return {
		version: 1, id: value.id, digest: value.digest, verdict: value.verdict as KillProofReceipt["verdict"], reasons, provedAt: value.provedAt, root: value.root,
		source, mutant, tests, killedTests, baseline: { cases: baseline.cases, durationMs: baseline.durationMs },
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
		const source = parseHashed(row.source), tests = parseHashedList(row.tests), killedTests = parseStringList(row.killedTests);
		if (source === null || tests === null || killedTests === null) return null;
		receipts.push({ id: row.id, verdict: row.verdict as KillProofReceipt["verdict"], provedAt: row.provedAt, source, tests, killedTests, mutant: row.mutant });
	}
	return { version: 1, receipts };
}

// ---- store ----

export function readKillProof(root: string, id: string): KillProofReceipt | null {
	if (!ID_RE.test(id)) return null;
	const path = join(killProofsDir(root), `${id}.json`);
	if (!existsSync(path)) return null;
	try {
		return parseKillProof(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return null;
	}
}

export function listKillProofIds(root: string): string[] {
	const dir = killProofsDir(root);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter(name => /^[0-9a-f]{16}\.json$/.test(name)).map(name => name.slice(0, 16)).sort();
}

function indexRow(receipt: KillProofReceipt): KillProofIndexRow {
	return { id: receipt.id, verdict: receipt.verdict, provedAt: receipt.provedAt, source: receipt.source, tests: receipt.tests, killedTests: receipt.killedTests, mutant: mutantLabel(receipt.mutant) };
}

/** The index is a projection of the receipt FILES: rebuilt, never patched, so a concurrent writer loses nothing. */
export function rebuildKillProofIndex(root: string): KillProofIndex {
	const receipts = listKillProofIds(root).map(id => readKillProof(root, id)).filter((r): r is KillProofReceipt => r !== null).map(indexRow);
	return { version: 1, receipts };
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

/** Write the receipt, then rebuild the index from the files on disk (temp → rename, both). Returns the receipt path. */
export function writeKillProof(root: string, receipt: KillProofReceipt): string {
	const dir = killProofsDir(root);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${receipt.id}.json`);
	writeAtomic(path, `${JSON.stringify(receipt, null, 1)}\n`);
	writeAtomic(join(dir, INDEX_FILE), `${JSON.stringify(rebuildKillProofIndex(root), null, 1)}\n`);
	return path;
}

// ---- freshness ----

function hashMismatches(root: string, files: readonly HashedFile[], role: string): string[] {
	return files.flatMap(file => {
		const now = hashFile(root, file.path);
		if (now === null) return [`${role} ${file.path} no longer exists`];
		return now.sha256 === file.sha256 ? [] : [`${role} ${file.path} changed since the proof`];
	});
}

/** Bytes-only freshness: the source and every named test file. */
export function bytesFresh(root: string, row: Pick<KillProofIndexRow, "source" | "tests">): string[] {
	return [...hashMismatches(root, [row.source], "source"), ...hashMismatches(root, row.tests, "test")];
}

function environmentReasons(root: string, recorded: ProofEnvironment): string[] {
	const env = captureEnvironment(root, recorded.config?.path), reasons: string[] = [];
	reasons.push(...hashMismatches(root, recorded.setupFiles, "setup file"));
	for (const file of env.setupFiles) if (!recorded.setupFiles.some(known => known.path === file.path)) reasons.push(`setup file ${file.path} was added to the config since the proof`);
	if (env.node !== recorded.node) reasons.push(`node ${recorded.node} → ${env.node}`);
	if (env.vitest !== recorded.vitest) reasons.push(`vitest ${recorded.vitest ?? "unresolved"} → ${env.vitest ?? "unresolved"}`);
	if (env.platform !== recorded.platform) reasons.push(`platform ${recorded.platform} → ${env.platform}`);
	if ((env.config?.sha256 ?? null) !== (recorded.config?.sha256 ?? null)) reasons.push("vitest/vite config changed since the proof");
	return reasons;
}

/** The receipt's own consistency: digest and id re-derive, root matches, verdict agrees with its cases. */
export function integrityReasons(root: string, receipt: KillProofReceipt): string[] {
	const reasons: string[] = [];
	if (receiptDigest(receipt) !== receipt.digest) reasons.push("receipt digest does not match its contents (edited receipt)");
	if (receiptId(receipt) !== receipt.id) reasons.push("receipt id does not re-derive from its contents (edited or copied receipt)");
	if (receipt.root !== root) reasons.push(`receipt was produced for ${receipt.root}, not this project`);
	const killed = receipt.underMutant.cases.filter(row => row.verdict === "killed");
	if ((receipt.verdict === "killed") !== killed.length > 0) reasons.push("verdict disagrees with the recorded cases");
	const killedFiles = new Set(killed.map(row => row.test.slice(0, row.test.indexOf(" › "))));
	if (receipt.killedTests.length !== killedFiles.size || receipt.killedTests.some(file => !killedFiles.has(file))) reasons.push("killedTests disagrees with the recorded cases");
	return reasons;
}

/**
 * Cheap freshness for the hook path (no TypeScript, no manifest): integrity, bytes and
 * runtime. The receipt FILE is read, so a forged index row with no receipt is nothing.
 */
export function receiptFreshCheap(root: string, id: string): { receipt: KillProofReceipt; reasons: string[] } | null {
	const receipt = readKillProof(root, id);
	if (receipt === null) return null;
	return { receipt, reasons: [...integrityReasons(root, receipt), ...bytesFresh(root, receipt), ...environmentReasons(root, receipt.environment)] };
}

/** Full freshness: the cheap check plus the mutant still resolving at the recorded offset on the recorded line. */
export function verifyKillProof(root: string, receipt: KillProofReceipt): Freshness {
	const reasons = [...integrityReasons(root, receipt), ...bytesFresh(root, receipt), ...environmentReasons(root, receipt.environment)];
	if (reasons.length === 0) {
		const located = relocate(root, receipt.mutant);
		if (!located.ok) reasons.push(`mutant no longer resolves: ${located.reason}`);
		else if (located.mutant.offset !== receipt.mutant.offset) reasons.push(`mutant moved from offset ${receipt.mutant.offset} to ${located.mutant.offset}`);
		else if (receipt.mutant.lineText !== undefined) {
			const content = readFileSync(join(root, receipt.mutant.file), "utf8");
			if (lineTextAt(content, located.mutant.offset) !== receipt.mutant.lineText) reasons.push("the mutated line changed since the proof");
		}
	}
	return reasons.length === 0 ? { fresh: true } : { fresh: false, reasons };
}

/** Bound files whose work-tree bytes differ from HEAD or the index, or that are untracked (review N8). Empty outside git. */
export function uncommittedPaths(root: string, paths: readonly string[]): string[] {
	try {
		const out = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all", "--", ...paths], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return out.split("\n").filter(Boolean).map(line => line.slice(3).trim().replace(/^"|"$/g, ""));
	} catch {
		return [];
	}
}

/** The case titles (after ` › `) a receipt records as killed for one test file. */
export function killedCaseNames(receipt: KillProofReceipt, testPath: string): string[] {
	return receipt.underMutant.cases.filter(row => row.verdict === "killed" && row.test.startsWith(`${testPath} › `)).map(row => row.test.slice(testPath.length + 3));
}

export type Certification = { certified: true; receipt: KillProofReceipt } | { certified: false; receipt: KillProofReceipt | null; reasons: string[] };

/**
 * Does receipt `id` certify `testPath` NOW? Read from the receipt FILE: integrity,
 * verdict `killed` through this file, the source and THIS test file's bytes, the
 * runtime (review K2, K13). With `requireCases` (the Stop check's newly added case
 * titles), at least one of them must be a killed case — an old strong case does not
 * certify a new weak one (review K4).
 */
export function receiptCertifies(root: string, id: string, testPath: string, requireCases?: readonly string[]): Certification {
	const receipt = readKillProof(root, id);
	if (receipt === null) return { certified: false, receipt: null, reasons: ["receipt file missing or unreadable"] };
	const reasons = [...integrityReasons(root, receipt)];
	if (receipt.verdict !== "killed" || !receipt.killedTests.includes(testPath)) reasons.push(`receipt did not kill through ${testPath}`);
	const own = receipt.tests.filter(test => test.path === testPath);
	if (own.length === 0) reasons.push(`receipt does not name ${testPath}`);
	reasons.push(...hashMismatches(root, [receipt.source], "source"), ...hashMismatches(root, own, "test"), ...environmentReasons(root, receipt.environment));
	if (requireCases !== undefined && requireCases.length > 0) {
		const killed = killedCaseNames(receipt, testPath);
		if (!requireCases.some(title => killed.some(name => name.includes(title)))) reasons.push("none of the newly added cases is a killed case in this receipt");
	}
	return reasons.length === 0 ? { certified: true, receipt } : { certified: false, receipt, reasons };
}

/** Receipts that certify `testPath` now (see `receiptCertifies`). The Stop check's and the nudge's whole question. */
export function freshKillsForTest(root: string, testPath: string, requireCases?: readonly string[]): KillProofReceipt[] {
	return readKillProofIndex(root).receipts.flatMap(row => {
		const result = receiptCertifies(root, row.id, testPath, requireCases);
		return result.certified ? [result.receipt] : [];
	});
}
