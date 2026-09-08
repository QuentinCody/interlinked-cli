import { nonNull } from "../../lib/non-null.js";
// Mutation-directed kills for src/harness/graph-prediction-classifier.ts.
// Every case below closes a gap the companion graph-prediction-classifier.test.ts
// left open — verified by shadow-running the exact mutation against a real
// pristine/mutant module pair (scratch/fleet-r3/w8/gpc-shadow-verify.mts,
// receipts in scratch/fleet-r3/receipts/src_harness_graph-prediction-classifier.ts.jsonl).

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyCase, resetWorkspaceActiveCache, workspaceSupermodelActive } from "../graph-prediction-classifier.js";

let dir: string;

// Every hook and describe block below carries an explicit 60s timeout,
// double vitest.stryker.config.ts's 30s default. Locally each case finishes
// in low single-digit ms (all work is synchronous real-fs I/O via mkdtempSync/
// mkdirSync/writeFileSync/rmSync against the OS tmpdir), but under the
// mutation runner's sandbox cold-cache/load conditions that same I/O can run
// far slower than on a warm dev box — the exact "Test timed out in 30000ms ->
// ConfigError -> no report -> ENOENT" failure mode diagnosed for
// commit-parse.ts / env-extractor.ts / verify-parity.ts
// (scratch/fleet-r3/repair-followups.txt bug #13). This is headroom only:
// no assertion changes.
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "graph-pred-kill-"));
	resetWorkspaceActiveCache();
	vi.useRealTimers();
}, 60_000);

afterEach(() => {
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
	resetWorkspaceActiveCache();
}, 60_000);

function makePair(root: string, ...segments: string[]): void {
	const leafDir = join(root, ...segments.slice(0, -1));
	mkdirSync(leafDir, { recursive: true });
	const base = join(leafDir, nonNull(segments.at(-1)));
	writeFileSync(`${base}.ts`, "export {}");
	writeFileSync(`${base}.graph.ts`, "// @generated supermodel-sidecar");
}

describe("skip-descend directories (.git / .interlinked)", { timeout: 60_000 }, () => {
	// test-contract: invariant — SKIP_DESCEND_DIRS in graph-prediction-classifier.ts
	// must name exactly ".git" and ".interlinked"; scanForShardNearSourcePair must
	// never walk into either even when a shard pair is planted inside.
	it("never reports active from a shard pair planted inside .git", () => {
		mkdirSync(join(dir, ".git"), { recursive: true });
		writeFileSync(join(dir, ".git", "foo.ts"), "export {}");
		writeFileSync(join(dir, ".git", "foo.graph.ts"), "// @generated");
		expect(workspaceSupermodelActive(dir)).toBe(false);
	});

	// test-contract: invariant — same guarantee for the .interlinked directory,
	// which the scanner must also refuse to descend into.
	it("never reports active from a shard pair planted inside .interlinked", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "foo.ts"), "export {}");
		writeFileSync(join(dir, ".interlinked", "foo.graph.ts"), "// @generated");
		expect(workspaceSupermodelActive(dir)).toBe(false);
	});
});

describe("SHARD_RE anchor boundary", { timeout: 60_000 }, () => {
	// test-contract: boundary — the shard suffix pattern must be anchored to the
	// end of the filename. A name where ".graph" is merely a PREFIX of a longer,
	// non-matching tail (here "foo.graph@") must not be mistaken for a shard —
	// even though a corrupted match could otherwise compute a bogus "source"
	// path (here "foo.") that happens to exist on disk.
	it("does not treat a .graph-prefixed non-shard filename as a shard", () => {
		writeFileSync(join(dir, "foo.graph@"), "");
		writeFileSync(join(dir, "foo."), "");
		expect(workspaceSupermodelActive(dir)).toBe(false);
	});

	// test-contract: boundary — a shard file with NO extension segment
	// ("identifier.graph" exactly, matching shardPathFor's own extensionless
	// convention) must still be recognized, and its source name recovered
	// correctly (the m[1] ?? "" fallback must stay "", not something else).
	it("recognizes a bare '<name>.graph' shard with no extension segment", () => {
		writeFileSync(join(dir, "bare"), "");
		writeFileSync(join(dir, "bare.graph"), "");
		expect(workspaceSupermodelActive(dir)).toBe(true);
	});
});

describe("IMPORT_RE boundary — Case B (declares imports) detection", { timeout: 60_000 }, () => {
	beforeEach(() => {
		makePair(dir, "src", "anchor");
	}, 60_000);

	function caseFor(content: string): string {
		return classifyCase(join(dir, "src", "new.ts"), dir, { toolInputContent: content }).case;
	}

	// test-contract: boundary — leading whitespace before "import" must still
	// be recognized (the `\s*` before the alternation, not `\S*`).
	it("detects an import preceded by leading whitespace", () => {
		expect(caseFor("   import x from 'y';")).toBe("B");
	});

	// test-contract: boundary — "from" followed by MORE than one whitespace
	// char before the quote must still match (`\s+`, not a single `\s`).
	it("detects a bare 'from' statement with two spaces before the quote", () => {
		expect(caseFor("x;\nfrom  './y.js';")).toBe("B");
	});

	// test-contract: boundary — "from" followed by exactly one whitespace char
	// (the ordinary case) must match `\s+`, not a mutated `\S+`.
	it("detects a bare 'from' statement with exactly one space before the quote", () => {
		expect(caseFor("x;\nfrom './y.js';")).toBe("B");
	});

	// test-contract: boundary — the quote character itself after "from " must
	// be required (`['\"]`, not its negation `[^'\"]`).
	it("does not falsely gate the 'from' branch on a negated quote class", () => {
		// Same content as the two-cases-above assertion: quote directly follows
		// the required whitespace, which only the non-negated class accepts.
		expect(caseFor("x;\nfrom './y.js';")).toBe("B");
	});

	// test-contract: boundary — "require(" with NO space before the paren
	// (the common case) must match `\s*` (0-or-more), not a mutated `\s`
	// that demands exactly one space.
	it("detects require( with no space before the paren", () => {
		expect(caseFor("x;\nrequire('y');")).toBe("B");
	});

	// test-contract: boundary — "require (" with a space must still match
	// `\s*`, not a mutated `\S*` that forbids whitespace entirely.
	it("detects require( with a space before the paren", () => {
		expect(caseFor("x;\nrequire ('y');")).toBe("B");
	});

	// test-contract: boundary — "use" followed by TWO spaces must still match
	// `\s+` (1-or-more), not a mutated exactly-one `\s`.
	it("detects a 'use' directive with two spaces before the word", () => {
		expect(caseFor("x;\nuse  strict")).toBe("B");
	});

	// test-contract: boundary — "use" followed by exactly one space and a
	// WORD character must match `\s+\w`; this single fixture separately kills
	// both the `\s+`→`\S+` mutation and the trailing `\w`→`\W` mutation
	// (verified independently via shadow-run).
	it("detects a 'use' directive with exactly one space before the word", () => {
		expect(caseFor("x;\nuse strict")).toBe("B");
	});
});

describe("classifyCase staleness grace boundary", { timeout: 60_000 }, () => {
	// test-contract: boundary — a shard exactly STALENESS_GRACE_MS (60s) older
	// than its source is still "fresh" (inclusive `>=`, not exclusive `>`).
	it("treats a shard exactly at the 60s grace boundary as E-fresh", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "b.ts"), "export {}");
		writeFileSync(join(dir, "src", "b.graph.ts"), "// @generated");
		utimesSync(join(dir, "src", "b.ts"), t / 1000, t / 1000);
		utimesSync(join(dir, "src", "b.graph.ts"), (t - 60_000) / 1000, (t - 60_000) / 1000);
		expect(classifyCase(join(dir, "src", "b.ts"), dir).case).toBe("E-fresh");
	});
});

describe("configOptOut malformed-config resilience", { timeout: 60_000 }, () => {
	// test-contract: bug — a config.json whose top-level JSON value is the
	// literal `null` must be treated as "not opted out" WITHOUT throwing.
	// A missing (or weakened) `typeof cfg !== "object" || cfg === null` guard
	// lets `(null).supermodel` crash the whole scan.
	it("does not crash when config.json is the literal JSON value null", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "config.json"), "null");
		expect(workspaceSupermodelActive(dir)).toBe(false);
	});

	// test-contract: bug — a config.json whose "supermodel" field is
	// explicitly null must be treated as "not opted out" WITHOUT throwing.
	// Losing `typeof supermodel !== "object" || supermodel === null` lets
	// `(null).enabled` crash the whole scan.
	it("does not crash when config.json's supermodel field is null", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "config.json"), JSON.stringify({ supermodel: null }));
		expect(workspaceSupermodelActive(dir)).toBe(false);
	});

	// test-contract: bug — a config.json object with NO "supermodel" key at
	// all (supermodel reads as `undefined`) must not crash either; only the
	// `typeof supermodel !== "object"` half of the guard catches undefined,
	// since `undefined === null` is false.
	it("does not crash when config.json has no supermodel key at all", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "config.json"), "{}");
		expect(workspaceSupermodelActive(dir)).toBe(false);
	});

	// test-contract: public-api — opt-out requires `enabled === false`
	// EXACTLY; `enabled: true` (or any other value) must NOT opt out, so a
	// real shard pair elsewhere in the tree is still found.
	it("does not opt out when supermodel.enabled is not exactly false", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "config.json"), JSON.stringify({ supermodel: { enabled: true } }));
		makePair(dir, "src", "foo");
		expect(workspaceSupermodelActive(dir)).toBe(true);
	});
});

describe("isExcluded backslash normalization", { timeout: 60_000 }, () => {
	// test-contract: invariant — isExcluded normalizes backslashes to forward
	// slashes BEFORE fragment-matching (`.replace(/\\/g, "/")`), so a path
	// segment carrying a literal backslash around "dist" is still recognized
	// as the excluded "/dist/" fragment, not silently glued into one word.
	it("still excludes a dist-named segment when a stray backslash separates it", () => {
		const weird = ["x", "dist", "y"].join("\\");
		mkdirSync(join(dir, weird), { recursive: true });
		writeFileSync(join(dir, weird, "foo.ts"), "export {}");
		writeFileSync(join(dir, weird, "foo.graph.ts"), "// @generated");
		expect(workspaceSupermodelActive(dir)).toBe(false);
	});
});

describe("resetWorkspaceActiveCache actually clears state", { timeout: 60_000 }, () => {
	// test-contract: public-api — resetWorkspaceActiveCache must clear the
	// cache map so the NEXT call re-scans instead of returning a stale value,
	// even when called only microseconds apart (well within the TTL).
	it("forces a fresh re-scan after being called, even inside the TTL window", () => {
		expect(workspaceSupermodelActive(dir)).toBe(false);
		resetWorkspaceActiveCache();
		makePair(dir, "src", "foo");
		expect(workspaceSupermodelActive(dir)).toBe(true);
	});
});

describe("scanForShardNearSourcePair symlink guard", { timeout: 60_000 }, () => {
	// test-contract: security — a symlink named like a shard file must NOT be
	// treated as a real shard file (Dirent.isFile() is false for a symlink
	// entry); only real files matching SHARD_RE count.
	it("does not treat a symlink named like a shard file as a real shard", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "link.ts"), "export {}");
		symlinkSync(join(dir, "src", "link.ts"), join(dir, "src", "link.graph.ts"));
		expect(workspaceSupermodelActive(dir)).toBe(false);
	});
});

describe("workspaceSupermodelActive cache timing", { timeout: 60_000 }, () => {
	// test-contract: public-api — a cached result is trusted for the whole TTL
	// window even if the filesystem changes underneath it in the meantime;
	// this is the documented "cold-scan cost paid at most once per minute"
	// contract from the file's own header comment.
	it("trusts a cached false result within the TTL even after a pair appears on disk", () => {
		expect(workspaceSupermodelActive(dir)).toBe(false);
		makePair(dir, "src", "foo");
		expect(workspaceSupermodelActive(dir)).toBe(false);
	});

	// test-contract: boundary — once the FULL 60s TTL has elapsed, the next
	// call must re-scan rather than trust the stale cache.
	it("re-scans once the cache TTL has fully elapsed", () => {
		vi.useFakeTimers();
		const base = Date.parse("2026-05-10T00:00:00Z");
		vi.setSystemTime(base);
		expect(workspaceSupermodelActive(dir)).toBe(false);
		vi.setSystemTime(base + 61_000);
		makePair(dir, "src", "foo");
		expect(workspaceSupermodelActive(dir)).toBe(true);
	});

	// test-contract: boundary — EXACTLY at the 60s TTL boundary the cache must
	// already be considered expired (`<`, not `<=`) — the mirror image of the
	// classifyCase staleness-boundary test above, for the OTHER cache in this
	// module.
	it("treats the cache as expired exactly at the TTL boundary, not one tick later", () => {
		vi.useFakeTimers();
		const base = Date.parse("2026-05-10T00:00:00Z");
		vi.setSystemTime(base);
		expect(workspaceSupermodelActive(dir)).toBe(false);
		vi.setSystemTime(base + 60_000);
		makePair(dir, "src", "foo");
		expect(workspaceSupermodelActive(dir)).toBe(true);
	});

	// test-contract: public-api — the opted-out (false) cache entry must
	// still read back as false on the very next call, not silently flip.
	it("remembers a false (opted-out) cached value correctly across calls", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "config.json"), JSON.stringify({ supermodel: { enabled: false } }));
		expect(workspaceSupermodelActive(dir)).toBe(false);
		expect(workspaceSupermodelActive(dir)).toBe(false);
	});

	// test-contract: invariant — the cache entry written on the opt-out path
	// must carry a real numeric cachedAt so the TTL arithmetic on the NEXT
	// call stays sane (not NaN, which would force an involuntary rescan).
	it("keeps the opt-out cache entry internally consistent across a config change within the TTL", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "config.json"), JSON.stringify({ supermodel: { enabled: false } }));
		expect(workspaceSupermodelActive(dir)).toBe(false);
		writeFileSync(join(dir, ".interlinked", "config.json"), JSON.stringify({ supermodel: { enabled: true } }));
		makePair(dir, "src", "foo");
		expect(workspaceSupermodelActive(dir)).toBe(false);
	});

	// test-contract: invariant — the cache entry written on the normal
	// (scanned) path must likewise carry a real numeric cachedAt, so a
	// filesystem change moments later still reads back the trusted cache.
	it("keeps the active-scan cache entry internally consistent after the pair disappears within the TTL", () => {
		makePair(dir, "src", "foo");
		expect(workspaceSupermodelActive(dir)).toBe(true);
		rmSync(join(dir, "src", "foo.ts"));
		rmSync(join(dir, "src", "foo.graph.ts"));
		expect(workspaceSupermodelActive(dir)).toBe(true);
	});
});
