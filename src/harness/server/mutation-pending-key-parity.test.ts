import { makeServerRuntime, makeServerRules } from "./__tests__/fixtures.js";
// ===========================================
// Cross-window invariant: ONE file ⇒ ONE pending-registry key
// ===========================================
// The pending registry correlates two SEPARATE hook invocations. PreToolUse
// records an in-flight mutation run (`onPending`, pre-tool-coverage-gates.ts);
// PostToolUse claims it (`writtenFile`, post-tool-mutation-harvest.ts). They meet
// on EXACT STRING EQUALITY of the file key (`takePending`), so two things must
// hold and neither module's own suite owns them:
//
//   1. every spelling of one file collapses onto ONE key (no duplicate records)
//   2. the writer's derivation and the reader's derivation agree byte-for-byte
//
// This is the pinned form of a bug class that bit this repo twice on 2026-07-31:
// TWO PRODUCERS, TWO PATH SPELLINGS, ONE MAP — 17 absolute-path keys duplicating
// repo-relative entries in the mutation manifest, and every file compared twice by
// the coverage ratchet (LCOV relative vs istanbul absolute). The harvest's own
// tests author the pending key by hand (`recordPending({ file: "src/a.ts" })`),
// which is precisely why the original absolute-vs-repo-relative mismatch here
// shipped green: nothing exercised the WRITER.
//
// Everything below drives the real gate — a real ChangeSet, a real cloud runner
// whose budget really expires, the real singleton registry — and asserts observable
// state (what the store holds, what the agent is told), never that a mock was called.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { overlayHash, pendingRegistry, resetPendingRegistry } from "../mutation/pending-registry.js";
import { recordPending } from "../mutation/pending-runs.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { appendMutationHarvestWarning } from "./post-tool-mutation-harvest.js";
import { runMutationWriteGate } from "./pre-tool-coverage-gates.js";
import type { ServerRuntime } from "./runtime-context.js";

const SOURCE = 'export function classify(n: number) {\n\treturn n > 0 ? "positive" : "other";\n}\n';
const TEST_SOURCE = 'import { classify } from "./a.js";\nvoid classify(1);\n';
/** What the Edit below produces — the bytes the gate measures and the harvest re-hashes. */
const EDITED = SOURCE.replace("positive", "nonneg");

/** A Stryker report shaped like the runner's, carrying one survivor. */
const REPORT = {
	files: {
		"src/a.ts": {
			source: "export function f(x: number) { return x > 0; }\n",
			mutants: [
				{
					mutatorName: "EqualityOperator",
					replacement: ">=",
					status: "Survived",
					location: { start: { line: 1, column: 39 }, end: { line: 1, column: 40 } },
				},
			],
		},
	},
};

const okFetch = async () => ({ ok: true, status: 200, json: async () => REPORT });

let repo: string;

beforeEach(() => {
	resetPendingRegistry();
	// A real tree: the gate reads the target off disk and walks its imports.
	repo = mkdtempSync(join(tmpdir(), "il-pending-key-"));
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", "a.ts"), SOURCE, "utf-8");
	// The mutation gate requires a proven import-graph test scope before it
	// contacts a runner. Keep this fixture real so the pending-run assertions
	// exercise the production selector instead of bypassing it with a mock.
	writeFileSync(join(repo, "src", "a.test.ts"), TEST_SOURCE, "utf-8");
});

afterEach(() => {
	vi.unstubAllGlobals();
	resetPendingRegistry();
	rmSync(repo, { recursive: true, force: true });
});

/**
 * A runner that never answers, so the gate's budget genuinely expires and the
 * real `MutationRunPendingError` path runs. Rejecting when there is no abort
 * signal keeps a wiring change from hanging the suite instead of failing it.
 */
function stubHangingRunner(): void {
	vi.stubGlobal(
		"fetch",
		(_url: string, init?: { signal?: AbortSignal }) =>
			new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) {
					reject(new Error("cloud runner was called without an abort signal"));
					return;
				}
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
	);
}

function ctxFor(root: string): ServerRuntime {
	return makeServerRuntime({
		cwd: root,
		graphCache: new Map(),
		log: () => {},
		rules: { ...makeServerRules(),
			per_edit_mutation: {
				enabled: true,
				mode: "warn",
				unavailable_behavior: "allow_unmeasured",
				runner_url: "http://runner.test/",
				budget_ms: 5,
				harvest_budget_ms: 0,
			},
		},
	});
}

function editEvent(spelling: string, hookEvent: "PreToolUse" | "PostToolUse"): HarnessEvent {
	return {
		agent_source: "claude",
		timestamp: "2026-09-08T00:00:00Z",
		hook_event: hookEvent,
		session_id: "s",
		tool_name: "Edit",
		tool_input: { file_path: spelling, old_string: "positive", new_string: "nonneg" },
	};
}

/**
 * Every spelling of `<repo>/src/a.ts` a producer could plausibly hand the gate.
 * String concatenation, not `join`, for the `.`/`..` cases — `join` would
 * normalize them away and the case would silently stop testing anything.
 */
const SPELLINGS: Array<{ label: string; of: (root: string) => string }> = [
	{ label: "absolute (what Claude Code's hook actually sends)", of: (r) => join(r, "src", "a.ts") },
	{ label: "repo-relative", of: () => "src/a.ts" },
	{ label: '"./"-prefixed', of: () => "./src/a.ts" },
	{ label: "redundant separator", of: () => "src//a.ts" },
	{ label: "relative with a '.' segment", of: () => "src/./a.ts" },
	{ label: "relative round-tripping through '..'", of: () => "src/../src/a.ts" },
	{ label: "absolute with a '.' segment", of: (r) => `${r}/src/./a.ts` },
	{ label: "absolute round-tripping through '..'", of: (r) => `${r}/src/../src/a.ts` },
];

describe("pending-registry key — one file cannot occupy two keys", () => {
	it.each(SPELLINGS)("normalizes $label to the canonical repo-relative key", async ({ of }) => {
		stubHangingRunner();
		const decision: HarnessDecision = { decision: "allow" };

		await runMutationWriteGate(ctxFor(repo), editEvent(of(repo), "PreToolUse"), decision);

		// The run really went pending — otherwise the key assertion below would be
		// vacuously satisfied by an empty store for the wrong reason.
		expect(decision.warnings?.join("\n")).toContain("still running past the budget");
		expect(pendingRegistry().runs.map((r) => r.file)).toEqual(["src/a.ts"]);
	});

	it("collapses all eight spellings onto a single key across repeated edits", async () => {
		stubHangingRunner();
		for (const spelling of SPELLINGS) {
			await runMutationWriteGate(ctxFor(repo), editEvent(spelling.of(repo), "PreToolUse"), {
				decision: "allow",
			});
		}

		const keys = pendingRegistry().runs.map((r) => r.file);
		// One entry per edit — the store is a log, not a set.
		expect(keys).toHaveLength(SPELLINGS.length);
		// ...but one DISTINCT key. This is the invariant: a split history is
		// impossible because there is no second spelling for the store to hold.
		expect([...new Set(keys)]).toEqual(["src/a.ts"]);
	});
});

describe("pending-registry key — the two hook windows agree", () => {
	it("PostToolUse claims the run PreToolUse recorded, and reports its survivor", async () => {
		stubHangingRunner();
		const absolute = join(repo, "src", "a.ts");
		await runMutationWriteGate(ctxFor(repo), editEvent(absolute, "PreToolUse"), {
			decision: "allow",
		});
		expect(pendingRegistry().runs).toHaveLength(1);

		// The edit lands: disk now holds exactly the overlay that was measured, so
		// the content half of the correlation matches and only the key is in question.
		writeFileSync(absolute, EDITED, "utf-8");
		expect(readFileSync(absolute, "utf-8")).toBe(EDITED);

		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(
			ctxFor(repo),
			editEvent(absolute, "PostToolUse"),
			decision,
			{ fetchImpl: okFetch },
		);

		// The finding reached the agent — the writer's key was findable by the reader.
		expect(decision.warnings?.join("\n")).toContain("surviving mutant");
		// Claims are single-use: the store drained, so a second PostToolUse cannot
		// re-report what the agent has already been shown.
		expect(pendingRegistry().runs).toHaveLength(0);
	});

	it("a run recorded under the pre-fix ABSOLUTE spelling is never claimed", async () => {
		// The regression this key-space already suffered once, held in place: if a
		// future producer records the absolute form, the harvest must not match it.
		// Misattribution is the failure that matters — reporting findings about one
		// file against another's bytes — so a miss is the correct outcome.
		const absolute = join(repo, "src", "a.ts");
		writeFileSync(absolute, EDITED, "utf-8");
		recordPending(pendingRegistry(), {
			file: absolute,
			overlayHash: overlayHash(EDITED),
			jobId: "j1",
			runnerUrl: "http://runner.test/",
			startedAt: Date.now(),
		});

		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(
			ctxFor(repo),
			editEvent(absolute, "PostToolUse"),
			decision,
			{ fetchImpl: okFetch },
		);

		expect(decision.warnings ?? []).not.toContainEqual(expect.stringContaining("surviving mutant"));
		expect(pendingRegistry().runs).toHaveLength(1); // orphaned, reaped by TTL
	});

	it("does NOT diagnose a key mismatch — only a content mismatch (known gap)", async () => {
		// CHARACTERIZATION, not endorsement. `unmatchedPendingWarning` filters
		// `store.runs.filter(r => r.file === file)` — the SAME equality `takePending`
		// just failed on — so a KEY mismatch leaves it with zero orphans and it stays
		// silent. Its own docstring claims it covers "the two windows disagree about
		// the key". It cannot. Reported separately; when that is fixed this
		// expectation flips to asserting the warning fires.
		const absolute = join(repo, "src", "a.ts");
		writeFileSync(absolute, EDITED, "utf-8");
		recordPending(pendingRegistry(), {
			file: absolute, // key mismatch
			overlayHash: overlayHash(EDITED), // content MATCHES
			jobId: "j1",
			runnerUrl: "http://runner.test/",
			startedAt: Date.now(),
		});

		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(
			ctxFor(repo),
			editEvent(absolute, "PostToolUse"),
			decision,
			{ fetchImpl: okFetch },
		);

		expect(decision.warnings).toBeUndefined();
	});

	/**
	 * The invariant stated OPERATIONALLY rather than by inspecting the key string:
	 * whatever spelling the WRITER was handed, the READER can claim it under any
	 * other spelling of the same file. That is the property the two-window design
	 * actually needs, and it is the one an assertion on `runs.map(r => r.file)`
	 * cannot express — that assertion pins the writer alone, so a change applied to
	 * ONE side of the pair still passes it.
	 *
	 * What this discriminates (each checked by making the change and watching a
	 * pair fail, not by inspection):
	 *   - writer stops normalizing            → (absolute write, relative read) misses
	 *   - writer switches to the manifest's `normalizeManifestKey(file, cwd)`, which
	 *     does NOT resolve `.` / `..` / `//` in a RELATIVE input → every dotted
	 *     write spelling misses. This is why the "route it through the canonical
	 *     helper" refactor is declined: the canonical helper is weaker here.
	 *   - reader stops normalizing            → every relative-read column misses
	 */
	it(
		"claims across the full 8x8 write-spelling x read-spelling matrix",
		async () => {
			stubHangingRunner();
			const absolute = join(repo, "src", "a.ts");
			const misses: string[] = [];
			let recorded = 0;

			for (const write of SPELLINGS) {
				for (const read of SPELLINGS) {
					resetPendingRegistry();
					// Restore the pre-edit bytes: the gate applies `old_string` against
					// what is on disk, and a stale EDITED file would make the patch a
					// no-op, record nothing, and turn the whole pair vacuous.
					writeFileSync(absolute, SOURCE, "utf-8");
					await runMutationWriteGate(ctxFor(repo), editEvent(write.of(repo), "PreToolUse"), {
						decision: "allow",
					});
					recorded += pendingRegistry().runs.length;

					// The edit lands, so the content half of the correlation matches and
					// only the key is under test.
					writeFileSync(absolute, EDITED, "utf-8");
					const decision: HarnessDecision = { decision: "allow" };
					await appendMutationHarvestWarning(
						ctxFor(repo),
						editEvent(read.of(repo), "PostToolUse"),
						decision,
						{ fetchImpl: okFetch },
					);
					if (!(decision.warnings ?? []).join("\n").includes("surviving mutant")) {
						misses.push(`write=${write.label} read=${read.label}`);
					}
				}
			}

			// Non-vacuity: every pair really put a run in the store, so a green result
			// cannot come from an empty registry that nothing asked anything of.
			expect(recorded).toBe(SPELLINGS.length * SPELLINGS.length);
			expect(misses).toEqual([]);
		},
		30_000,
	);

	it("DOES diagnose a content mismatch under a matching key", async () => {
		// The half that works: same key, different bytes ⇒ the anti-misattribution
		// guard fires and says so, rather than reading as "nothing was pending".
		const absolute = join(repo, "src", "a.ts");
		writeFileSync(absolute, EDITED, "utf-8");
		recordPending(pendingRegistry(), {
			file: "src/a.ts", // key MATCHES
			overlayHash: overlayHash("something else entirely"), // content mismatch
			jobId: "j1",
			runnerUrl: "http://runner.test/",
			startedAt: Date.now(),
		});

		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(
			ctxFor(repo),
			editEvent(absolute, "PostToolUse"),
			decision,
			{ fetchImpl: okFetch },
		);

		expect(decision.warnings?.join("\n")).toContain("could not be matched to what landed");
	});
});
