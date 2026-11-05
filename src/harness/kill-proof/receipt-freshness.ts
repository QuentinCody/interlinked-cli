// ===========================================
// Kill proof — receipt freshness and certification
// ===========================================
// Split from receipt.ts (line cap). Everything here READS receipts and the tree and
// decides whether a receipt still applies: integrity (digest, id, root, verdict vs
// cases), bytes (source, tests, bound helpers), runtime (node, vitest, platform,
// config, setup files), the mutant location, the committed-ness of the proven
// bytes (review M9) and, for the Stop check and the nudge, whether every newly
// added case is covered (`source-cases.ts`). Nothing here writes.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captureEnvironment, hashFile, type KillProofIndexRow, readKillProof, readKillProofIndex, receiptDigest, receiptId } from "./receipt.js";
import { lineTextAt, relocate } from "./resolve.js";
import { type CaseRequirement, requirementCovered, requirementLabel } from "./source-cases.js";
import type { CaseOutcome, Freshness, HashedFile, KillProofReceipt, ProofEnvironment } from "./types.js";


function hashMismatches(root: string, files: readonly HashedFile[], role: string): string[] {
	return files.flatMap(file => {
		const now = hashFile(root, file.path);
		if (now === null) return [`${role} ${file.path} no longer exists`];
		return now.sha256 === file.sha256 ? [] : [`${role} ${file.path} changed since the proof`];
	});
}

/** Bytes-only freshness: the source, every named test file and (from a receipt) every bound helper. */
export function bytesFresh(root: string, row: Pick<KillProofIndexRow, "source" | "tests"> & { boundImports?: readonly HashedFile[] }): string[] {
	return [...hashMismatches(root, [row.source], "source"), ...hashMismatches(root, row.tests, "test"), ...hashMismatches(root, row.boundImports ?? [], "helper")];
}

/** Per-call memo of `captureEnvironment` by config path (review M10: one createRequire + config hash per call, not per receipt). */
export type EnvironmentCache = Map<string, ProofEnvironment>;

function currentEnvironment(root: string, configPath: string | undefined, cache: EnvironmentCache | undefined): ProofEnvironment {
	if (cache === undefined) return captureEnvironment(root, configPath);
	const key = configPath ?? "";
	const known = cache.get(key);
	if (known !== undefined) return known;
	const env = captureEnvironment(root, configPath);
	cache.set(key, env);
	return env;
}

function environmentReasons(root: string, recorded: ProofEnvironment, cache?: EnvironmentCache): string[] {
	const env = currentEnvironment(root, recorded.config?.path, cache), reasons: string[] = [];
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

/** sha256 of the blob git holds at `<rev>:<path>` (HEAD, or the index for `:`); null when there is none. */
function gitBlobSha256(root: string, rev: string, path: string): string | null {
	try {
		const bytes = execFileSync("git", ["-C", root, "show", `${rev}:${path}`], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
		return createHash("sha256").update(bytes).digest("hex");
	} catch {
		return null;
	}
}

/**
 * Bound files whose PROVEN bytes are not the committed ones: the receipt's recorded sha256
 * is compared with the sha256 of the HEAD blob and of the index blob (review N8, M9) — never
 * with `git status`, which hides a `--skip-worktree` / `--assume-unchanged` path. An untracked
 * or unstaged file is uncommitted. Empty outside git (nothing to compare against).
 */
export function uncommittedPaths(root: string, files: readonly HashedFile[]): string[] {
	try {
		execFileSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return [];
	}
	return files.filter(file => gitBlobSha256(root, "HEAD", file.path) !== file.sha256 || gitBlobSha256(root, "", file.path) !== file.sha256).map(file => file.path);
}

/** Every recorded case of one test file, name (after ` › `) and verdict, in report order; a duplicated full name yields one row per case. */
export function caseRowsForTest(receipt: KillProofReceipt, testPath: string): Array<{ name: string; verdict: CaseOutcome["verdict"] }> {
	const head = `${testPath} › `;
	return receipt.underMutant.cases.filter(row => row.test.startsWith(head)).map(row => ({ name: row.test.slice(head.length), verdict: row.verdict }));
}

export type Certification = { certified: true; receipt: KillProofReceipt } | { certified: false; receipt: KillProofReceipt | null; reasons: string[]; uncovered?: string[] };

/** A bare string is an EXACT vitest full name (review M2: never a suffix). */
const asRequirement = (item: string | CaseRequirement): CaseRequirement => (typeof item === "string" ? { kind: "exact", name: item } : item);

/**
 * Does receipt `id` certify `testPath` NOW? Read from the receipt FILE: integrity,
 * verdict `killed` through this file, the source and THIS test file's bytes, the
 * helpers THIS test file imports, the runtime (review K2, K11, K13). With `requireCases` (the newly added cases), EVERY
 * one of them must be covered — exactly by full name, or as a prefix family — with every
 * recorded case of that name killed (`source-cases.ts requirementCovered`): an old strong
 * case, one strong new case, or a strong twin of a weak duplicate never certifies a case
 * that killed nothing (reviews K4, L3, M2, M3).
 */
export function receiptCertifies(root: string, id: string, testPath: string, requireCases?: ReadonlyArray<string | CaseRequirement>, envCache?: EnvironmentCache): Certification {
	const receipt = readKillProof(root, id);
	if (receipt === null) return { certified: false, receipt: null, reasons: ["receipt file missing or unreadable"] };
	const reasons = [...integrityReasons(root, receipt)];
	if (receipt.verdict !== "killed" || !receipt.killedTests.includes(testPath)) reasons.push(`receipt did not kill through ${testPath}`);
	const own = receipt.tests.filter(test => test.path === testPath);
	if (own.length === 0) reasons.push(`receipt does not name ${testPath}`);
	const helpers = receipt.boundImports.filter(file => file.importedBy.includes(testPath));
	reasons.push(...hashMismatches(root, [receipt.source], "source"), ...hashMismatches(root, own, "test"), ...hashMismatches(root, helpers, "helper"), ...environmentReasons(root, receipt.environment, envCache));
	let uncovered: string[] = [];
	if (requireCases !== undefined && requireCases.length > 0) {
		const rows = caseRowsForTest(receipt, testPath);
		uncovered = requireCases.map(asRequirement).filter(req => !requirementCovered(req, rows)).map(requirementLabel);
		if (uncovered.length) reasons.push(`newly added case(s) not among this receipt's killed cases: ${uncovered.join(", ")}`);
	}
	return reasons.length === 0 ? { certified: true, receipt } : { certified: false, receipt, reasons, ...(uncovered.length ? { uncovered } : {}) };
}

/** Receipts that certify `testPath` now (see `receiptCertifies`). The Stop check's and the nudge's whole question. */
export function freshKillsForTest(root: string, testPath: string, requireCases?: ReadonlyArray<string | CaseRequirement>): KillProofReceipt[] {
	// Only CURRENT rows naming this test file are read (review M8, M10): the index is the locator, the receipt file the record.
	const envCache: EnvironmentCache = new Map();
	return readKillProofIndex(root).receipts.filter(row => row.supersededBy === undefined && row.tests.some(test => test.path === testPath)).flatMap(row => {
		const result = receiptCertifies(root, row.id, testPath, requireCases, envCache);
		return result.certified ? [result.receipt] : [];
	});
}
