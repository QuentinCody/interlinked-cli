// ===========================================
// Committed test fixture — the one Read-side exception to "secret ⇒ Confidential"
// ===========================================
// Test suites and scanner fixtures carry fake, shape-valid secrets on purpose
// (signatures.test.ts, supply-chain fixtures, egress-redaction tests). A Read
// of one would ratchet the whole session to Confidential and hard-block every
// network call. This predicate names the case where the bytes the agent just
// read are ALREADY COMMITTED test data, so the Read path raises the session to
// Internal (the escalation tier) instead.
//
// True only when ALL of these hold (each failure is the fail-safe answer):
//   1. the file (symlinks resolved) lies inside the git work tree of the
//      daemon's project root;
//   2. its path is a test path (isStrictTestFile) or sits in a fixture
//      directory (`__fixtures__/`, `fixtures/`, `testdata/`);
//   3. its path classifies Public under the taint file_sensitivity globs, so
//      `.env.*`, `secrets/`, `*.pem` … never qualify;
//   4. EVERY occurrence of every matched signature in the read text also
//      appears in the file's blob at HEAD. An untracked or gitignored file has
//      no HEAD blob; a secret copied into a tracked fixture after the last
//      commit is not in it. Laundering a secret through this tier needs a
//      commit to the project, which the commit gates see.
// git missing, a timeout, or a non-repository root ⇒ false.
//
// Cost: the HEAD tree listing is cached per work tree for five minutes (a stale
// listing still names committed blobs, so staleness only errs toward
// Confidential for files committed after it was taken); blob bodies are cached
// by blob id. Both run only after a secret-signature hit on a test path.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { isStrictTestFile } from "./checks/shared-test-classification.js";
import { signatureSpans } from "./public-credential-contexts.js";
import { classifyFileSensitivity } from "./taint-tracker.js";
import type { TaintTrackingConfig } from "./types.js";

const FIXTURE_DIR = /(^|\/)(?:__fixtures__|fixtures|testdata)\//;
const TREE_TTL_MS = 300_000;
const GIT_TIMEOUT_MS = 3_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const BLOB_CACHE_MAX = 32;

interface TreeListing {
	at: number;
	blobs: ReadonlyMap<string, string>;
}

const toplevels = new Map<string, string | null>();
const trees = new Map<string, TreeListing>();
const blobBodies = new Map<string, string>();

function git(cwd: string, args: readonly string[]): string | null {
	const r = spawnSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: GIT_MAX_BUFFER,
		stdio: ["ignore", "pipe", "ignore"],
	});
	return r.status === 0 && typeof r.stdout === "string" ? r.stdout : null;
}

function realpathOrNull(p: string): string | null {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
}

function workTreeOf(projectRoot: string): string | null {
	if (!toplevels.has(projectRoot)) {
		const top = git(projectRoot, ["rev-parse", "--show-toplevel"])?.trim();
		toplevels.set(projectRoot, top ? realpathOrNull(top) : null);
	}
	return toplevels.get(projectRoot) ?? null;
}

/** path → blob id for every file at HEAD. */
function headTree(top: string, now: number): ReadonlyMap<string, string> | null {
	const cached = trees.get(top);
	if (cached && now - cached.at <= TREE_TTL_MS) return cached.blobs;
	const out = git(top, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]);
	if (out === null) return null;
	const blobs = new Map<string, string>();
	for (const row of out.split("\0")) {
		const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(row);
		if (m?.[1] && m[2]) blobs.set(m[2], m[1]);
	}
	trees.set(top, { at: now, blobs });
	return blobs;
}

function blobBody(top: string, blob: string): string | null {
	const cached = blobBodies.get(blob);
	if (cached !== undefined) return cached;
	const body = git(top, ["cat-file", "blob", blob]);
	if (body === null) return null;
	if (blobBodies.size >= BLOB_CACHE_MAX) blobBodies.clear();
	blobBodies.set(blob, body);
	return body;
}

/** A test file, or a file under a fixture directory. */
export function isTestFixturePath(absPath: string): boolean {
	return isStrictTestFile(absPath) || FIXTURE_DIR.test(absPath.replace(/\\/g, "/"));
}

/** Every occurrence of every listed signature in `text`; null when one id is unknown or has none. */
function signatureTokens(text: string, ruleIds: readonly string[]): string[] | null {
	const tokens: string[] = [];
	for (const id of ruleIds) {
		const spans = signatureSpans(text, id);
		if (!spans || spans.length === 0) return null;
		for (const [s, e] of spans) tokens.push(text.slice(s, e));
	}
	return tokens.length > 0 ? tokens : null;
}

export interface CommittedFixtureQuery {
	/** Absolute path of the file that was read. */
	path: string;
	/** The text the agent saw. */
	text: string;
	ruleIds: readonly string[];
	/** The daemon's project root. */
	projectRoot: string;
	taint: TaintTrackingConfig;
	now?: number;
}

/** True when the read bytes' secret-shaped values are committed test data (rules 1–4 above). */
export function isCommittedTestFixture(q: CommittedFixtureQuery): boolean {
	const abs = realpathOrNull(q.path);
	if (!abs || !isTestFixturePath(abs) || classifyFileSensitivity(abs, q.taint) !== "Public") return false;
	const top = workTreeOf(q.projectRoot);
	const rel = top ? relative(top, abs) : "";
	if (!top || rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
	const tokens = signatureTokens(q.text, q.ruleIds);
	const blob = tokens ? headTree(top, q.now ?? Date.now())?.get(rel) : undefined;
	const body = blob ? blobBody(top, blob) : null;
	return body !== null && tokens !== null && tokens.every((t) => body.includes(t));
}
