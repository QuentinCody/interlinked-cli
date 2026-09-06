import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFeeds, defaultFeedPaths, type FeedPaths, seedMutants } from "./feeds.js";
import { appendTestEvent, type TestEvent } from "./test-events.js";

let dir = "";
let paths: FeedPaths;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "viz-feeds-"));
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
	paths = defaultFeedPaths(dir);
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const MANIFEST = JSON.stringify({
	files: {
		"src/a.ts": {
			sym: {
				qualifiedName: "doThing",
				mutants: { m1: { mutantId: "m1", status: "survived", mutator: "BooleanLiteral" } },
			},
		},
	},
});

describe("defaultFeedPaths", () => {
	it("puts every feed under the project's .interlinked dir", () => {
		const p = defaultFeedPaths("/proj");
		expect(p.activity).toBe(join("/proj", ".interlinked", "activity.jsonl"));
		expect(p.checkResults).toBe(join("/proj", ".interlinked", "check-results.jsonl"));
		expect(p.testEvents).toBe(join("/proj", ".interlinked", "test-events.jsonl"));
		expect(p.mutationManifest).toBe(join("/proj", ".interlinked", "mutation-manifest.json"));
	});
});

describe("seedMutants", () => {
	it("frames the manifest's current state as born events", () => {
		writeFileSync(paths.mutationManifest, MANIFEST);
		expect(seedMutants(paths.mutationManifest)).toEqual([
			{ kind: "born", mutant: expect.objectContaining({ id: "m1", status: "survived" }) },
		]);
	});

	it("returns nothing when there is no manifest", () => {
		expect(seedMutants(paths.mutationManifest)).toEqual([]);
	});
});

describe("buildFeeds", () => {
	it("exposes one feed per lens on distinct routes", () => {
		const routes = buildFeeds(paths, 1000).map((f) => f.route);
		expect(routes).toEqual([
			"/api/stream",
			"/api/checks",
			"/api/tests",
			"/api/agents",
			"/api/mutants",
			"/api/mutation-runs",
		]);
		expect(new Set(routes).size).toBe(routes.length);
	});

	it("gives every feed a non-empty hello label", () => {
		for (const feed of buildFeeds(paths, 1000)) expect(feed.hello.length).toBeGreaterThan(0);
	});

	it("seeds each feed as an empty array when no data files exist", () => {
		for (const feed of buildFeeds(paths, 1000)) expect(feed.seed()).toEqual([]);
	});

	it("seeds the test feed from the on-disk backlog, oldest first", () => {
		const base: TestEvent = { ts: "2026-08-04T00:00:00.000Z", kind: "test", run_id: "r1", status: "pass" };
		appendTestEvent(paths.testEvents, { ...base, name: "first" });
		appendTestEvent(paths.testEvents, { ...base, name: "second" });
		const tests = buildFeeds(paths, 1000).find((f) => f.route === "/api/tests");
		expect(tests?.seed().map((e) => (e as TestEvent).name)).toEqual(["first", "second"]);
	});

	it("folds the activity backlog into one presence per agent", () => {
		const rows = [
			{ ts: "2026-08-05T00:00:00.000Z", type: "tool_use", agent: "session-claude-aaa", tool: "Edit" },
			{ ts: "2026-08-05T00:00:01.000Z", type: "tool_use", agent: "session-codex-bbb", tool: "Read" },
			{ ts: "2026-08-05T00:00:02.000Z", type: "tool_use", agent: "session-claude-aaa", tool: "Write" },
		];
		writeFileSync(paths.activity, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
		const agents = buildFeeds(paths, 1000).find((f) => f.route === "/api/agents");
		// SAFETY: the /api/agents feed seeds AgentPresence rows; the feed contract
		// erases the element type to `unknown`, so this restores the known shape.
		const seeded = agents?.seed() as Array<{ id: string; edits: number; runner: string }>;
		expect(seeded.map((a) => a.id).sort()).toEqual(["session-claude-aaa", "session-codex-bbb"]);
		expect(seeded.find((a) => a.id === "session-claude-aaa")).toMatchObject({ edits: 2, runner: "claude" });
	});

	it("delivers newly appended test events to a subscriber", () => {
		vi.useFakeTimers();
		try {
			const feed = buildFeeds(paths, 100).find((f) => f.route === "/api/tests");
			const seen: unknown[] = [];
			const sub = feed?.subscribe((ev) => seen.push(ev));
			appendTestEvent(paths.testEvents, {
				ts: "2026-08-04T00:00:01.000Z",
				kind: "test",
				run_id: "r1",
				name: "live",
				status: "fail",
			});
			vi.advanceTimersByTime(1000);
			sub?.stop();
			expect(seen).toEqual([expect.objectContaining({ name: "live", status: "fail" })]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops delivering once a subscription is stopped", () => {
		vi.useFakeTimers();
		try {
			const feed = buildFeeds(paths, 100).find((f) => f.route === "/api/mutants");
			const seen: unknown[] = [];
			const sub = feed?.subscribe((ev) => seen.push(ev));
			sub?.stop();
			writeFileSync(paths.mutationManifest, MANIFEST);
			vi.advanceTimersByTime(3000);
			expect(seen).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("seeds the mutation-run lens from the ledger, skipping a torn tail line", () => {
		const validFirst = JSON.stringify({ file: "src/a.ts", survived: 0 });
		const torn = "{not valid json";
		const validSecond = JSON.stringify({ file: "src/b.ts", survived: 2 });
		const body = `${validFirst}\n${torn}\n${validSecond}\n`;
		writeFileSync(paths.mutationRuns!, body);
		const runs = buildFeeds(paths, 1000).find((f) => f.route === "/api/mutation-runs");
		expect(runs?.seed()).toEqual([
			{ file: "src/a.ts", survived: 0 },
			{ file: "src/b.ts", survived: 2 },
		]);
	});

	it("delivers newly appended mutation-run rows, skipping a torn tail line", () => {
		vi.useFakeTimers();
		try {
			const feed = buildFeeds(paths, 100).find((f) => f.route === "/api/mutation-runs");
			const seen: unknown[] = [];
			const sub = feed?.subscribe((ev) => seen.push(ev));
			const torn = "{also not valid json";
			const valid = JSON.stringify({ file: "src/c.ts", survived: 1 });
			appendFileSync(paths.mutationRuns!, `${torn}\n${valid}\n`);
			vi.advanceTimersByTime(1000);
			sub?.stop();
			expect(seen).toEqual([{ file: "src/c.ts", survived: 1 }]);
		} finally {
			vi.useRealTimers();
		}
	});
});

// Review 2026-08-28 item 2: the dashboard must never render a first-sighting
// adoption as clean. The row-class rule lives inline in mutation-runs.html, so
// this pin extracts and evaluates the ACTUAL shipped function — a drifted or
// deleted rowSurvClass fails here, not silently in a browser.
describe("mutation-runs.html — adoption is never the clean class", () => {
	interface ShippedRunRow {
		ts?: string;
		file: string;
		source?: unknown;
		mutants?: unknown;
		killed?: unknown;
		survived?: unknown;
		shards?: unknown;
		partial?: unknown;
		outcome?: unknown;
	}

	interface NormalizedRunRow {
		ts: string;
		file: string;
		source: string;
		mutants: number;
		killed: number;
		survived: number;
		shards: number | "";
		partial: boolean;
		outcome: string | null;
	}

	function shippedRowFunctions(): {
		rowSurvClass: (r: { survived?: number; outcome?: string }) => string;
		normalizeRow: (r: ShippedRunRow) => NormalizedRunRow | null;
		renderRowHtml: (r: NormalizedRunRow) => string;
	} {
		const html = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "web", "mutation-runs.html"),
			"utf-8",
		);
		const start = html.indexOf("const RUN_SOURCES");
		const end = html.indexOf("function add(", start);
		if (start < 0 || end < 0) throw new Error("row renderer not found in mutation-runs.html");
		const source = html.slice(start, end);
		// SAFETY: the evaluated source is this repo's own shipped page code,
		// bounded before the DOM/EventSource wiring; the cast names its API.
		return new Function(
			`${source}; return { rowSurvClass, normalizeRow, renderRowHtml };`,
		)() as {
			rowSurvClass: (r: { survived?: number; outcome?: string }) => string;
			normalizeRow: (r: ShippedRunRow) => NormalizedRunRow | null;
			renderRowHtml: (r: NormalizedRunRow) => string;
		};
	}

	function shippedRowSurvClass(): (r: { survived?: number; outcome?: string }) => string {
		return shippedRowFunctions().rowSurvClass;
	}

	it("P: adoption with ZERO survivors renders the neutral baseline class, never clean", () => {
		const rowSurvClass = shippedRowSurvClass();
		expect(rowSurvClass({ survived: 0, outcome: "baseline_adopted" })).toBe("baseline");
	});

	it("P: only an attested measured_clean row earns the clean class", () => {
		const rowSurvClass = shippedRowSurvClass();
		expect(rowSurvClass({ survived: 0, outcome: "measured_clean" })).toBe("clean");
	});

	it("N: a legacy row with NO outcome is not promoted to clean", () => {
		const rowSurvClass = shippedRowSurvClass();
		expect(rowSurvClass({ survived: 0 })).toBe("baseline");
	});

	it("N: survivors always win, whatever the outcome claims", () => {
		const rowSurvClass = shippedRowSurvClass();
		expect(rowSurvClass({ survived: 3, outcome: "measured_clean" })).toBe("surv");
	});

	it("N: hostile non-numeric fields cannot inject markup through the shipped renderer", () => {
		const { normalizeRow, renderRowHtml } = shippedRowFunctions();
		const attack = "</td><img src=x onerror=alert(1)>";
		const normalized = normalizeRow({
			ts: attack,
			file: "src/safe.ts",
			source: attack,
			mutants: attack,
			killed: attack,
			survived: attack,
			shards: attack,
			partial: attack,
			outcome: attack,
		});
		expect(normalized).toEqual({
			ts: attack,
			file: "src/safe.ts",
			source: "unknown",
			mutants: 0,
			killed: 0,
			survived: 0,
			shards: 0,
			partial: false,
			outcome: null,
		});
		expect(normalized).not.toBeNull();
		const rendered = renderRowHtml(normalized!);
		expect(rendered).not.toContain("<img");
		expect(rendered).not.toContain("onerror");
		expect(rendered).not.toContain("alert(1)");
	});

	it("N: hostile file text is escaped rather than interpreted as a tag", () => {
		const { normalizeRow, renderRowHtml } = shippedRowFunctions();
		const normalized = normalizeRow({ file: "<img src=x>", survived: 0 });
		expect(normalized).not.toBeNull();
		const rendered = renderRowHtml(normalized!);
		expect(rendered).toContain("&lt;img src=x&gt;");
		expect(rendered).not.toContain("<img");
	});
});
