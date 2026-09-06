// Companion tests for anchor-liveness.ts (LG-6). Positives prove each verdict
// class and the ingest→merge carry; negatives prove fail-open on legacy rows,
// ambiguity, and unreadable files — and that nothing here mutates state.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureAnchor, classifyAnchor } from "./anchor-liveness.js";
import { type Finding, makeFinding, upsertFinding } from "./corpus.js";

// Toggle to make the module-under-test's `readFileSync` throw while
// `existsSync` still reports true — covers the "file exists but is
// unreadable" catch branches (EACCES/EBUSY-shaped), distinct from "gone"
// (existsSync false) and "unverified" (no anchor captured). Every other
// node:fs export passes through to the real implementation unchanged.
const forceReadFileSyncError = vi.hoisted(() => ({ value: false }));
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
			if (forceReadFileSyncError.value) {
				throw new Error("EACCES: permission denied, open");
			}
			return actual.readFileSync(...args);
		},
	};
});

let dir: string;
let file: string;

const CONTENT = [
	"import { a } from './a';",
	"export function target(x: number) {",
	"  return x + 1;",
	"}",
	"export const other = 2;",
	"",
].join("\n");

function anchoredFinding(line: number): Finding {
	return makeFinding(
		{
			bug_class: "review_off_by_one",
			message: "off by one in target",
			file,
			line,
			source_runner: "test-reviewer",
			now: "2026-07-17T00:00:00.000Z",
		},
		dir,
	);
}

// `upsertFinding` → `recordFinding` mirrors every finding into
// `~/.interlinked/findings-corpus.jsonl` unless `INTERLINKED_HOME` redirects it.
// The tmp `dir` above governs only the per-repo corpus; the global mirror
// resolves its own path and swallows every error, so a leak is silent and the
// test still passes. Same fix as `src/commands/findings.test.ts`.
let fakeHome: string;
let prevInterlinkedHome: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "anchor-live-"));
	file = join(dir, "mod.ts");
	writeFileSync(file, CONTENT);
	prevInterlinkedHome = process.env.INTERLINKED_HOME;
	fakeHome = mkdtempSync(join(tmpdir(), "anchor-live-home-"));
	process.env.INTERLINKED_HOME = fakeHome;
});

afterEach(() => {
	forceReadFileSyncError.value = false;
	rmSync(dir, { recursive: true, force: true });
	rmSync(fakeHome, { recursive: true, force: true });
	if (prevInterlinkedHome === undefined) delete process.env.INTERLINKED_HOME;
	else process.env.INTERLINKED_HOME = prevInterlinkedHome;
});

describe("captureAnchor", () => {
	it("captures span hash + verbatim context around the line", () => {
		const f = captureAnchor(anchoredFinding(3), dir);
		expect(f.anchor_span_sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(f.anchor_context).toEqual([
			"export function target(x: number) {",
			"  return x + 1;",
			"}",
		]);
	});

	it("no-ops for unanchored findings and lines past EOF", () => {
		const unanchored = makeFinding(
			{ bug_class: "review_x", message: "m", source_runner: "r" },
			dir,
		);
		expect(captureAnchor(unanchored, dir).anchor_span_sha256).toBeUndefined();
		expect(captureAnchor(anchoredFinding(999), dir).anchor_span_sha256).toBeUndefined();
	});

	it("upsert keeps an existing anchor over a re-ingested one (carryAnchor)", () => {
		const first = upsertFinding(captureAnchor(anchoredFinding(3), dir), dir, {
			mirrorGlobal: false,
		});
		// Same structural site re-ingested after the file changed — the merged
		// row must keep the ORIGINAL anchor, not the drifted re-capture.
		writeFileSync(file, CONTENT.replace("x + 1", "x + 2"));
		const merged = upsertFinding(captureAnchor(anchoredFinding(3), dir), dir, {
			mirrorGlobal: false,
		});
		expect(merged.anchor_span_sha256).toBe(first.anchor_span_sha256);
	});
});

describe("classifyAnchor", () => {
	it("live: content unchanged at the recorded line", () => {
		const f = captureAnchor(anchoredFinding(3), dir);
		expect(classifyAnchor(f, dir)).toEqual({ state: "live" });
	});

	it("moved: unique context relocated by insertions above", () => {
		const f = captureAnchor(anchoredFinding(3), dir);
		writeFileSync(file, `// new header\n// more header\n${CONTENT}`);
		expect(classifyAnchor(f, dir)).toEqual({ state: "moved", newLine: 5 });
	});

	it("moved: survives a reindent via whitespace-normalized relocation", () => {
		const f = captureAnchor(anchoredFinding(3), dir);
		const reindented = CONTENT.split("\n")
			.map((l) => (l.startsWith("  ") ? `    ${l.trim()}` : l))
			.join("\n");
		writeFileSync(file, `// header\n${reindented}`);
		expect(classifyAnchor(f, dir)).toEqual({ state: "moved", newLine: 4 });
	});

	it("drifted: the anchored content itself changed", () => {
		const f = captureAnchor(anchoredFinding(3), dir);
		writeFileSync(file, CONTENT.replace("return x + 1;", "return x - 1;"));
		expect(classifyAnchor(f, dir).state).toBe("drifted");
	});

	it("drifted: ambiguous relocation (context duplicated) stays conservative", () => {
		const f = captureAnchor(anchoredFinding(3), dir);
		const block = "export function target(x: number) {\n  return x + 1;\n}\n";
		// Two pad lines shift the first copy off the recorded line (no positional
		// hash match), and the duplicated block makes relocation two-way ambiguous.
		writeFileSync(file, `// pad\n// pad2\n${block}\n// pad3\n${block}`);
		expect(classifyAnchor(f, dir).state).toBe("drifted");
	});

	it("gone: the file was deleted", () => {
		const f = captureAnchor(anchoredFinding(3), dir);
		rmSync(file);
		expect(classifyAnchor(f, dir)).toEqual({ state: "gone" });
	});

	it("unverified: legacy rows without a captured anchor fail open", () => {
		expect(classifyAnchor(anchoredFinding(3), dir)).toEqual({ state: "unverified" });
	});
});

describe("unreadable-file catch branches (exists, but read throws)", () => {
	it("captureAnchor leaves the finding unanchored when readFileSync throws", () => {
		const original = anchoredFinding(3);
		const beforeSnapshot = JSON.parse(JSON.stringify(original));
		forceReadFileSyncError.value = true;
		const result = captureAnchor(original, dir);
		// The catch swallows the read error and returns the finding untouched —
		// no anchor fields get added, unlike the successful-read path above.
		expect(result).toEqual(beforeSnapshot);
		expect(result.anchor_span_sha256).toBeUndefined();
	});

	it("classifyAnchor reports unverified when an anchored file's read throws", () => {
		const anchored = captureAnchor(anchoredFinding(3), dir);
		forceReadFileSyncError.value = true;
		// existsSync still sees the file (it was never deleted), so this must
		// come from the catch around readFileSync, not the "gone" branch.
		expect(classifyAnchor(anchored, dir)).toEqual({ state: "unverified" });
	});
});
