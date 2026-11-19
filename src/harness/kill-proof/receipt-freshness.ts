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
import { MAX_BOUND_IMPORTS } from "./bound-imports.js";
import { type KnownSurvivors, knownSurvivorsFor } from "./prove-command.js";
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
	reasons.push(...hashMismatches(root, recorded.configFiles, "config file"));
	for (const file of env.configFiles) if (!recorded.configFiles.some(known => known.path === file.path)) reasons.push(`config file ${file.path} is loaded by the config since the proof`);
	if (env.node !== recorded.node) reasons.push(`node ${recorded.node} → ${env.node}`);
	if (env.vitest !== recorded.vitest) reasons.push(`vitest ${recorded.vitest ?? "unresolved"} → ${env.vitest ?? "unresolved"}`);
	if (env.platform !== recorded.platform) reasons.push(`platform ${recorded.platform} → ${env.platform}`);
	if ((env.config?.sha256 ?? null) !== (recorded.config?.sha256 ?? null)) reasons.push("vitest/vite config changed since the proof");
	return reasons;
}

/** A receipt whose helper closure was cut at the cap binds less than its tests load (round 5, R5-3): the edit that
 *  changes the proof may sit in an unbound file, so the receipt certifies nothing and `--verify` says why. */
export const CLOSURE_TRUNCATED_REASON = `bound-import closure truncated at ${MAX_BOUND_IMPORTS} files; helpers beyond the cap are unbound, so the receipt cannot certify these tests`;

/** The receipt's own consistency: digest and id re-derive, root matches, verdict agrees with its cases, and the
 *  helper closure is complete (a cut closure is a receipt that does not describe its tests). */
export function integrityReasons(root: string, receipt: KillProofReceipt): string[] {
	const reasons: string[] = [];
	if (receipt.version !== 2) reasons.push("receipt uses obsolete proof protocol v1; Re-run prove-kill to bind frozen inputs and source dependencies");
	if (receipt.boundImportsTruncated === true) reasons.push(CLOSURE_TRUNCATED_REASON);
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
 * or unstaged file is uncommitted, and so is every file in a repository without a commit. Empty
 * outside git (nothing to compare against).
 */
export function uncommittedPaths(root: string, files: readonly HashedFile[]): string[] {
	try {
		execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return [];
	}
	try {
		execFileSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		// A repository with no commit yet: nothing is committed, so every proven file is uncommitted.
		return files.map(file => file.path);
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

/** The current (non-superseded) receipt ids naming `testPath` (review M8, M10): the index is the locator, the receipt file the record. */
export function currentReceiptIdsFor(root: string, testPath: string): string[] {
	return readKillProofIndex(root).receipts.filter(row => row.supersededBy === undefined && row.tests.some(test => test.path === testPath)).map(row => row.id);
}

export interface CertifyCasesInput {
	root: string;
	testPath: string;
	/** The newly added cases; empty when any fresh kill through the file is enough. */
	requireCases?: ReadonlyArray<string | CaseRequirement>;
	/** Receipt ids to judge; default: the current ones naming `testPath`. */
	ids?: readonly string[];
	/** Injected for tests; defaults to `receiptCertifies`. */
	certify?: (root: string, id: string, testPath: string, requireCases?: ReadonlyArray<string | CaseRequirement>, envCache?: EnvironmentCache) => Certification;
	/** The companion source's known manifest survivors; default: the survivors sidecar (`knownSurvivorsFor`). */
	known?: KnownSurvivors | null;
}

export interface CaseCertification {
	/** Fresh receipts that killed through the file AND are anchored (see `unanchored`); each binds the mutant its killed cases detected. */
	fresh: KillProofReceipt[];
	/** Fresh kills of an explicit fault while the companion source has known manifest survivors (review round 3 §d.11):
	 *  executed evidence of distinction, but not of the survivors the file claims, so they certify nothing. */
	unanchored: KillProofReceipt[];
	/** The known survivors that made `unanchored` non-empty possible; null when the sidecar knows none. */
	known: KnownSurvivors | null;
	/** Every judged receipt's own result (bytes, runtime, verdict), for wording. */
	results: Certification[];
	/** New cases that NO fresh receipt's killed cases cover. */
	uncovered: string[];
	certified: boolean;
}

/** Combine exact names, keeping every duplicate within one receipt together before combining receipts. */
function combinedCaseRows(receipts: readonly KillProofReceipt[], testPath: string): Array<{ name: string; verdict: CaseOutcome["verdict"] }> {
	const combined = new Map<string, boolean>();
	for (const receipt of receipts) {
		const own = new Map<string, boolean>();
		for (const row of caseRowsForTest(receipt, testPath)) {
			own.set(row.name, (own.get(row.name) ?? true) && row.verdict === "killed");
		}
		for (const [name, killed] of own) combined.set(name, (combined.get(name) ?? false) || killed);
	}
	return [...combined].map(([name, killed]) => ({ name, verdict: killed ? "killed" : "survived" }));
}

/**
 * The receipts of one test file judged TOGETHER (review round 6, finding 3). Each receipt is
 * fresh or not on its own (bytes, runtime, verdict through this file). Each new case must then be
 * covered by at least one fresh receipt's killed cases — the mutant that case detected is the one
 * that receipt binds — but two cases may be covered by two different receipts: a lower-bound test
 * proven against fault A and an upper-bound test proven against fault B are both evidence, and no
 * single mutant has to be killed by every case. A fresh receipt that covers no new case still
 * certifies nothing on its own (reviews K4, L3, M2, M3 hold per case).
 */
export function certifyCases(input: CertifyCasesInput): CaseCertification {
	const certify = input.certify ?? receiptCertifies, envCache: EnvironmentCache = new Map();
	const ids = input.ids ?? currentReceiptIdsFor(input.root, input.testPath);
	const results = ids.map(id => certify(input.root, id, input.testPath, undefined, envCache));
	const known = input.known === undefined ? knownSurvivorsFor(input.root, input.testPath) : input.known;
	const certified = results.flatMap(result => (result.certified ? [result.receipt] : []));
	const fresh = certified.filter(receipt => anchored(receipt, known)), unanchored = certified.filter(receipt => !anchored(receipt, known));
	const cases = input.requireCases?.length ? combinedCaseRows(fresh, input.testPath) : [];
	const uncovered = (input.requireCases ?? []).map(asRequirement)
		.filter(req => !requirementCovered(req, cases))
		.map(requirementLabel);
	return { fresh, unanchored, known, results, uncovered, certified: fresh.length > 0 && uncovered.length === 0 };
}

/** With known survivors of the companion source, only a manifest mutant OF that source anchors the file's claim; else any kill does. */
function anchored(receipt: KillProofReceipt, known: KnownSurvivors | null): boolean {
	if (known === null || known.count === 0) return true;
	return receipt.mutant.source === "manifest" && receipt.mutant.file === known.source;
}

/** Receipts that certify `testPath` now, judged together (`certifyCases`). The Stop check's and the nudge's whole question. */
export function freshKillsForTest(root: string, testPath: string, requireCases?: ReadonlyArray<string | CaseRequirement>): KillProofReceipt[] {
	const cert = certifyCases({ root, testPath, ...(requireCases !== undefined ? { requireCases } : {}) });
	return cert.certified ? cert.fresh : [];
}
