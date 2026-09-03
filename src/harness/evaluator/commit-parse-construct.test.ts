import { describe, expect, it } from "vitest";
import { applyConstructedContent, type AddState, type SegmentCommit } from "./commit-parse-construct.js";
import type { CommitParse } from "./commit-parse.js";

// ===========================================
// applyConstructedContent — companion test for the sibling module extracted
// from commit-parse.ts (2026-09) to keep the parser entry point under the
// per-file line cap. Cases mirror the doc comment's branches (finding
// 2026-06, rounds 4-6): --only/--include semantics, broad-vs-specific
// pathspecs, tracked-only overlay scope.
// ===========================================

function segment(overrides: Partial<SegmentCommit> = {}): SegmentCommit {
	return {
		isCommit: true,
		noVerify: false,
		all: false,
		include: false,
		pathspecs: [],
		pathspecFromFile: false,
		cDir: null,
		...overrides,
	};
}

function addState(overrides: Partial<AddState> = {}): AddState {
	return {
		sawGitAdd: false,
		addBroad: false,
		addPaths: [],
		updateOnlyPaths: [],
		...overrides,
	};
}

function freshParse(): CommitParse {
	return { isCommit: true, noVerify: false };
}

describe("applyConstructedContent — pathspec commit without --include (git's --only default)", () => {
	it("P1: a bare pathspec commit is SPECIFIC to its own paths, index NOT included", () => {
		const parse = freshParse();
		applyConstructedContent(parse, segment({ pathspecs: ["src/x.ts"] }), addState());
		expect(parse.constructedPaths).toEqual(["src/x.ts"]);
		expect(parse.includesIndex).toBeUndefined();
	});

	it("P2: a preceding narrow `git add` does NOT widen the pathspec commit's set", () => {
		const parse = freshParse();
		applyConstructedContent(
			parse,
			segment({ pathspecs: ["src/x.ts"] }),
			addState({ sawGitAdd: true, addPaths: ["other.ts"] }),
		);
		expect(parse.constructedPaths).toEqual(["src/x.ts"]);
		expect(parse.includesIndex).toBeUndefined();
	});

	it("P3: an add path COVERED by the commit's pathspec merges in (round 5)", () => {
		const parse = freshParse();
		applyConstructedContent(
			parse,
			segment({ pathspecs: ["src"] }),
			addState({ sawGitAdd: true, addPaths: ["src/new.ts"] }),
		);
		expect(parse.constructedPaths).toEqual(["src", "src/new.ts"]);
	});
});

describe("applyConstructedContent — --include / no-pathspec commits capture the staged index", () => {
	it("P4: --include folds the staged add paths into constructedPaths and marks includesIndex", () => {
		const parse = freshParse();
		applyConstructedContent(
			parse,
			segment({ pathspecs: ["src/x.ts"], include: true }),
			addState({ sawGitAdd: true, addPaths: ["other.ts"] }),
		);
		expect(parse.constructedPaths).toEqual(["src/x.ts", "other.ts"]);
		expect(parse.includesIndex).toBe(true);
	});

	it("P5: a commit with no pathspecs after a `git add` includes the index", () => {
		const parse = freshParse();
		applyConstructedContent(parse, segment(), addState({ sawGitAdd: true, addPaths: ["a.ts"] }));
		expect(parse.constructedPaths).toEqual(["a.ts"]);
		expect(parse.includesIndex).toBe(true);
	});
});

describe("applyConstructedContent — broadening (unknowable must fail toward evaluating MORE)", () => {
	it("N1: `git commit -a` is broad — no constructedPaths even with a pathspec", () => {
		const parse = freshParse();
		applyConstructedContent(parse, segment({ pathspecs: ["src/x.ts"], all: true }), addState());
		expect(parse.constructedPaths).toBeUndefined();
	});

	it("N2: a bare broad `git add -A` (no pathspecs on the commit) is broad", () => {
		const parse = freshParse();
		applyConstructedContent(parse, segment(), addState({ sawGitAdd: true, addBroad: true }));
		expect(parse.constructedPaths).toBeUndefined();
		expect(parse.includesIndex).toBe(true);
	});

	it("N3: a broad add does NOT broaden a commit that names its own pathspecs (round 4)", () => {
		const parse = freshParse();
		applyConstructedContent(
			parse,
			segment({ pathspecs: ["src/x.ts"] }),
			addState({ sawGitAdd: true, addBroad: true }),
		);
		expect(parse.constructedPaths).toEqual(["src/x.ts"]);
	});

	it("N4: a non-literal (glob) pathspec is broad — no constructedPaths", () => {
		const parse = freshParse();
		applyConstructedContent(parse, segment({ pathspecs: ["src/*.ts"] }), addState());
		expect(parse.constructedPaths).toBeUndefined();
	});

	it("N5: --pathspec-from-file is broad regardless of pathspecs", () => {
		const parse = freshParse();
		applyConstructedContent(parse, segment({ pathspecFromFile: true }), addState());
		expect(parse.constructedPaths).toBeUndefined();
	});
});

describe("applyConstructedContent — trackedOnlyPaths overlay scope", () => {
	it("P6: a pathspec commit with no covering plain add is tracked-only", () => {
		const parse = freshParse();
		applyConstructedContent(parse, segment({ pathspecs: ["src/x.ts"] }), addState());
		expect(parse.trackedOnlyPaths).toEqual(["src/x.ts"]);
	});

	it("N6: a candidate covered by a plain `git add` keeps the FULL overlay (not tracked-only)", () => {
		const parse = freshParse();
		applyConstructedContent(
			parse,
			segment({ pathspecs: ["src"] }),
			addState({ sawGitAdd: true, addPaths: ["src"] }),
		);
		expect(parse.trackedOnlyPaths).toBeUndefined();
	});

	it("N7: a broad add leaves nothing tracked-only", () => {
		const parse = freshParse();
		applyConstructedContent(
			parse,
			segment({ pathspecs: ["src/x.ts"] }),
			addState({ sawGitAdd: true, addBroad: true }),
		);
		expect(parse.trackedOnlyPaths).toBeUndefined();
	});
});
