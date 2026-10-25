import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	findingsCorpusPath,
	foldByBugClass,
	getFinding,
	globalCorpusPath,
	loadFindings,
	makeFinding,
	recordFinding,
	upsertFinding,
	type Finding,
} from "./corpus.js";

let cwd: string;
let home: string;
const prevHome = process.env.INTERLINKED_HOME;
const LOCAL_ONLY = { mirrorGlobal: false } as const;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "findings-mut-cwd-"));
	home = mkdtempSync(join(tmpdir(), "findings-mut-home-"));
	process.env.INTERLINKED_HOME = home;
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
	if (prevHome === undefined) delete process.env.INTERLINKED_HOME;
	else process.env.INTERLINKED_HOME = prevHome;
});

const site = (runner: string, extra: Record<string, unknown> = {}) => ({
	bug_class: "nan_coercion_guard",
	message: "m",
	file: "a.ts",
	line: 7,
	source_runner: runner,
	repo: "o/r",
	...extra,
});

/** Write a Finding straight into the derived global cache (bypassing recordFinding). */
function writeGlobalOnly(f: Finding): void {
	mkdirSync(dirname(globalCorpusPath()), { recursive: true });
	appendFileSync(globalCorpusPath(), `${JSON.stringify(f)}\n`, "utf-8");
}

describe("makeFinding — id slug and anchoring", () => {
	it("collapses a run of punctuation in bug_class into one underscore in the id", () => {
		const f = makeFinding({ bug_class: "a!!b", message: "m", source_runner: "paste" }, cwd);
		expect(f.id).toMatch(/^a_b-/);
	});

	it("trims leading punctuation of bug_class from the id", () => {
		const f = makeFinding({ bug_class: "!!lead", message: "m", source_runner: "paste" }, cwd);
		expect(f.id).toMatch(/^lead-/);
	});

	it("a file with no line is file-tier, line 0 and anchored_file only (provenance.ts computeDedupKey: file-only => file tier)", () => {
		const f = makeFinding({ bug_class: "c", message: "m", file: "a.ts", source_runner: "paste" }, cwd);
		expect(f.line).toBe(0);
		expect(f.provenance_tier).toBe("file");
		expect(nonNull(f.provenance[0]).provenance_completeness).toBe("anchored_file");
	});
});

describe("loadFindings — scope selection", () => {
	it("defaults to the local corpus only (a global-only row is not returned)", () => {
		const f = makeFinding({ bug_class: "c", message: "m", source_runner: "paste" }, cwd);
		writeGlobalOnly(f);
		expect(loadFindings(cwd)).toEqual([]);
	});

	it("scope both includes rows that exist only in the global cache", () => {
		const f = makeFinding({ bug_class: "c", message: "m", source_runner: "paste" }, cwd);
		writeGlobalOnly(f);
		expect(loadFindings(cwd, { scope: "both" }).map((x) => x.id)).toEqual([f.id]);
	});

	it("scope both includes rows that exist only in the local corpus", () => {
		const f = makeFinding({ bug_class: "c", message: "m", source_runner: "paste" }, cwd);
		recordFinding(f, cwd, LOCAL_ONLY);
		expect(loadFindings(cwd, { scope: "both" }).map((x) => x.id)).toEqual([f.id]);
	});

	it("scope global does not read the local corpus", () => {
		const f = makeFinding({ bug_class: "c", message: "m", source_runner: "paste" }, cwd);
		recordFinding(f, cwd, LOCAL_ONLY);
		expect(loadFindings(cwd, { scope: "global" })).toEqual([]);
	});

	it("the local system of record wins over the global cache for the same id (corpus.ts header: global is a derived cache)", () => {
		const f = makeFinding({ bug_class: "c", message: "from-global", source_runner: "paste" }, cwd);
		writeGlobalOnly(f);
		recordFinding({ ...f, message: "from-local" }, cwd, LOCAL_ONLY);
		const rows = loadFindings(cwd, { scope: "both" });
		expect(rows).toHaveLength(1);
		expect(nonNull(rows[0]).message).toBe("from-local");
	});

	it("recordFinding with mirrorGlobal false leaves the global cache untouched", () => {
		const f = makeFinding({ bug_class: "c", message: "m", source_runner: "paste" }, cwd);
		recordFinding(f, cwd, LOCAL_ONLY);
		expect(existsSync(globalCorpusPath())).toBe(false);
		expect(existsSync(findingsCorpusPath(cwd))).toBe(true);
	});
});

describe("upsertFinding — merge policy", () => {
	it("keeps the earliest first_seen and the latest last_seen regardless of arrival order", () => {
		const early = "2026-01-01T00:00:00.000Z";
		const late = "2026-03-01T00:00:00.000Z";
		upsertFinding(makeFinding(site("a", { commit_sha: "s1", now: late }), cwd), cwd, LOCAL_ONLY);
		const merged = upsertFinding(makeFinding(site("b", { commit_sha: "s2", now: early }), cwd), cwd, LOCAL_ONLY);
		expect(merged.first_seen).toBe(early);
		expect(merged.last_seen).toBe(late);

		upsertFinding(makeFinding(site("c", { commit_sha: "s3", now: "2026-02-01T00:00:00.000Z" }), cwd), cwd, LOCAL_ONLY);
		const row = nonNull(getFinding(merged.id, cwd));
		expect(row.first_seen).toBe(early);
		expect(row.last_seen).toBe(late);
	});

	it("an alias seen by both sightings appears once", () => {
		upsertFinding(makeFinding(site("a", { commit_sha: "s1", aliases: ["dup", "x"] }), cwd), cwd, LOCAL_ONLY);
		const merged = upsertFinding(
			makeFinding(site("b", { commit_sha: "s2", aliases: ["dup", "y"] }), cwd),
			cwd,
			LOCAL_ONLY,
		);
		expect([...merged.aliases].sort()).toEqual(["dup", "x", "y"]);
	});

	it("a runner that reported twice is listed once in source_runners while times_observed counts both sightings", () => {
		upsertFinding(makeFinding(site("a", { commit_sha: "s1" }), cwd), cwd, LOCAL_ONLY);
		const merged = upsertFinding(makeFinding(site("a", { commit_sha: "s2" }), cwd), cwd, LOCAL_ONLY);
		expect(merged.times_observed).toBe(2);
		expect(merged.source_runners).toEqual(["a"]);
	});

	it("a re-harvested sighting (same provenance_id) leaves the stored provenance entry intact (idempotent upsert, corpus.ts:354)", () => {
		upsertFinding(makeFinding(site("a", { commit_sha: "s1", quote: "first" }), cwd), cwd, LOCAL_ONLY);
		const merged = upsertFinding(makeFinding(site("a", { commit_sha: "s1", quote: "second" }), cwd), cwd, LOCAL_ONLY);
		expect(merged.provenance).toHaveLength(1);
		expect(nonNull(merged.provenance[0]).quote).toBe("first");
	});

	it("keeps an existing anchor over a re-ingest's anchor (corpus.ts carryAnchor: existing wins)", () => {
		const first = makeFinding(site("a", { commit_sha: "s1" }), cwd);
		upsertFinding(
			{ ...first, anchor_span_sha256: "old-sha", anchor_context: ["old"], anchor_tree: "old-tree" },
			cwd,
			LOCAL_ONLY,
		);
		const merged = upsertFinding(
			{
				...makeFinding(site("b", { commit_sha: "s2" }), cwd),
				anchor_span_sha256: "new-sha",
				anchor_context: ["new"],
				anchor_tree: "new-tree",
			},
			cwd,
			LOCAL_ONLY,
		);
		expect(merged.anchor_span_sha256).toBe("old-sha");
		expect(merged.anchor_context).toEqual(["old"]);
		expect(merged.anchor_tree).toBe("old-tree");
	});

	it("fills a legacy row's missing anchor from the incoming capture", () => {
		upsertFinding(makeFinding(site("a", { commit_sha: "s1" }), cwd), cwd, LOCAL_ONLY);
		const merged = upsertFinding(
			{
				...makeFinding(site("b", { commit_sha: "s2" }), cwd),
				anchor_span_sha256: "new-sha",
				anchor_context: ["new"],
				anchor_tree: "new-tree",
			},
			cwd,
			LOCAL_ONLY,
		);
		expect(merged.anchor_span_sha256).toBe("new-sha");
		expect(merged.anchor_context).toEqual(["new"]);
		expect(merged.anchor_tree).toBe("new-tree");
	});

	it("adopts extensions that only the incoming sighting carries", () => {
		upsertFinding(makeFinding(site("a", { commit_sha: "s1" }), cwd), cwd, LOCAL_ONLY);
		const merged = upsertFinding(
			{ ...makeFinding(site("b", { commit_sha: "s2" }), cwd), extensions: { lens: "incoming" } },
			cwd,
			LOCAL_ONLY,
		);
		expect(merged.extensions).toEqual({ lens: "incoming" });
	});

	it("keeps extensions that only the existing row carries", () => {
		upsertFinding(
			{ ...makeFinding(site("a", { commit_sha: "s1" }), cwd), extensions: { lens: "existing" } },
			cwd,
			LOCAL_ONLY,
		);
		const merged = upsertFinding(makeFinding(site("b", { commit_sha: "s2" }), cwd), cwd, LOCAL_ONLY);
		expect(merged.extensions).toEqual({ lens: "existing" });
	});

	it("unions extension keys carried by different sightings", () => {
		upsertFinding(
			{ ...makeFinding(site("a", { commit_sha: "s1" }), cwd), extensions: { one: 1 } },
			cwd,
			LOCAL_ONLY,
		);
		const merged = upsertFinding(
			{ ...makeFinding(site("b", { commit_sha: "s2" }), cwd), extensions: { two: 2 } },
			cwd,
			LOCAL_ONLY,
		);
		expect(merged.extensions).toEqual({ one: 1, two: 2 });
	});

	it("looks up the existing row in the local corpus only, never the derived global cache", () => {
		const cached = makeFinding(site("a", { commit_sha: "s1" }), cwd);
		writeGlobalOnly(cached);
		const merged = upsertFinding(makeFinding(site("b", { commit_sha: "s2" }), cwd), cwd, LOCAL_ONLY);
		expect(merged.times_observed).toBe(1);
		expect(merged.source_runners).toEqual(["b"]);
	});

	it("honors mirrorGlobal false by not writing the global cache", () => {
		upsertFinding(makeFinding(site("a", { commit_sha: "s1" }), cwd), cwd, LOCAL_ONLY);
		expect(existsSync(globalCorpusPath())).toBe(false);
	});

	it("mirrors to the global cache by default", () => {
		const merged = upsertFinding(makeFinding(site("a", { commit_sha: "s1" }), cwd), cwd);
		expect(loadFindings(cwd, { scope: "global" }).map((x) => x.id)).toEqual([merged.id]);
	});
});

describe("foldByBugClass — counts", () => {
	it("times_observed sums distinct sightings while finding_count counts sites (BugClassRow comments)", () => {
		upsertFinding(makeFinding(site("a", { commit_sha: "s1" }), cwd), cwd, LOCAL_ONLY);
		upsertFinding(makeFinding(site("b", { commit_sha: "s2" }), cwd), cwd, LOCAL_ONLY);
		upsertFinding(makeFinding(site("c", { commit_sha: "s3" }), cwd), cwd, LOCAL_ONLY);
		const rows = foldByBugClass(loadFindings(cwd));
		expect(rows).toHaveLength(1);
		expect(nonNull(rows[0]).finding_count).toBe(1);
		expect(nonNull(rows[0]).times_observed).toBe(3);
	});

	it("does not list the empty file of an unanchored finding in sample_files", () => {
		upsertFinding(makeFinding({ bug_class: "prose", message: "m", source_runner: "paste" }, cwd), cwd, LOCAL_ONLY);
		const rows = foldByBugClass(loadFindings(cwd));
		expect(nonNull(rows[0]).sample_files).toEqual([]);
	});
});
