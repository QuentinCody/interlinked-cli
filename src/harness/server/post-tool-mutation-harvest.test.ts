import { beforeEach, describe, expect, it, vi } from "vitest";
// These tests run with the REAL repo cwd; without these mocks the durable
// side effects (run ledger + pending-store JSON) write into the actual
// .interlinked/ — synthetic rows polluted the live ledger once (external
// review 2026-08-23, finding 4). Registry logic stays real; only persistence
// and the ledger append are neutralized.
vi.mock("../mutation/run-log.js", () => ({ appendMutationRun: vi.fn() }));
vi.mock("../mutation/pending-registry.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../mutation/pending-registry.js")>();
	return { ...actual, initPendingRegistryStore: vi.fn(), commitPendingRegistry: vi.fn() };
});
import { overlayHash, pendingRegistry, resetPendingRegistry } from "../mutation/pending-registry.js";
import { recordPending } from "../mutation/pending-runs.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { appendMutationHarvestWarning } from "./post-tool-mutation-harvest.js";
import type { ServerRuntime } from "./runtime-context.js";

const NOW = 1_800_000_000_000;
const CONTENT = "export function f(x: number) { return x > 0; }\n";

const REPORT = {
	files: {
		"src/a.ts": {
			source: CONTENT,
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

function ctxWith(enabled: boolean, cwd: string) {
	return {
		cwd,
		rules: { per_edit_mutation: { enabled, runner_urls: ["http://runner/"] } },
	} as unknown as ServerRuntime;
}

function writeEvent(path: string): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "s",
		tool_name: "Edit",
		tool_input: { file_path: path },
	} as unknown as HarnessEvent;
}

const okFetch = async () => ({ ok: true, status: 200, json: async () => REPORT });

beforeEach(() => {
	resetPendingRegistry();
});

describe("appendMutationHarvestWarning", () => {
	// test-contract: invariant — Grok 2026-08-28 issue 4: `mode: "off"` must
	// silence BOTH windows. The PreToolUse gate no-ops on it; a harvest keyed
	// only off `enabled` kept claiming pending jobs for a disabled gate.
	it("N: mode 'off' produces nothing and claims no pending handle", async () => {
		const cwd = process.cwd();
		recordPending(pendingRegistry(NOW), {
			file: "src/a.ts",
			overlayHash: overlayHash(CONTENT),
			jobId: "j-off",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		const ctx = {
			cwd,
			rules: { per_edit_mutation: { enabled: true, mode: "off", runner_urls: ["http://runner/"] } },
			// SAFETY: same structural stand-in shape as ctxWith — the function
			// reads only cwd and rules.per_edit_mutation.
		} as unknown as ServerRuntime;
		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(ctx, writeEvent(`${cwd}/src/a.ts`), decision, {
			readDisk: () => CONTENT,
			fetchImpl: okFetch,
			now: () => NOW,
		});
		expect(decision.warnings).toBeUndefined();
		// The handle is still claimable — off-mode must not consume it.
		expect(pendingRegistry(NOW).runs).toHaveLength(1);
	});

	it("reports survivors from a run the PreToolUse window could not wait for", async () => {
		const cwd = process.cwd();
		recordPending(pendingRegistry(NOW), {
			file: "src/a.ts",
			overlayHash: overlayHash(CONTENT),
			jobId: "j1",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(ctxWith(true, cwd), writeEvent(`${cwd}/src/a.ts`), decision, {
			readDisk: () => CONTENT,
			fetchImpl: okFetch,
			now: () => NOW,
		});
		expect(decision.warnings?.join("\n")).toContain("surviving mutant");
	});

	// test-contract: invariant — review 2026-08-28 P1: the harvester writes an
	// EVIDENCE status, never an evaluator-minted outcome. The ledger row must
	// say `harvest_partial` + `partial: true` — incomplete evidence, neither
	// clean nor a committed `finding` — and the mock was previously never
	// asserted, so nothing pinned the persisted shape at all.
	it("P: the persisted ledger row carries outcome harvest_partial and partial:true", async () => {
		const { appendMutationRun } = await import("../mutation/run-log.js");
		const mAppend = vi.mocked(appendMutationRun);
		mAppend.mockClear();
		const cwd = process.cwd();
		recordPending(pendingRegistry(NOW), {
			file: "src/a.ts",
			overlayHash: overlayHash(CONTENT),
			jobId: "j-row",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		await appendMutationHarvestWarning(ctxWith(true, cwd), writeEvent(`${cwd}/src/a.ts`), { decision: "allow" }, {
			readDisk: () => CONTENT,
			fetchImpl: okFetch,
			now: () => NOW,
		});
		expect(mAppend).toHaveBeenCalledTimes(1);
		const row = mAppend.mock.calls[0]?.[1];
		expect(row?.outcome).toBe("harvest_partial");
		expect(row?.partial).toBe(true);
		expect(row?.source).toBe("harvest");
	});

	it("N: an unmatched window (zero harvested jobs) writes NO ledger row", async () => {
		const { appendMutationRun } = await import("../mutation/run-log.js");
		const mAppend = vi.mocked(appendMutationRun);
		mAppend.mockClear();
		const cwd = process.cwd();
		// No pending run recorded — nothing to claim, nothing to persist.
		await appendMutationHarvestWarning(ctxWith(true, cwd), writeEvent(`${cwd}/src/a.ts`), { decision: "allow" }, {
			readDisk: () => CONTENT,
			fetchImpl: okFetch,
			now: () => NOW,
		});
		expect(mAppend).not.toHaveBeenCalled();
	});

	it("waits for a run that is still going when the phase starts", async () => {
		// The whole point of the second window: PostToolUse fires milliseconds
		// after the write while the run still needs seconds.
		const cwd = process.cwd();
		recordPending(pendingRegistry(NOW), {
			file: "src/a.ts",
			overlayHash: overlayHash(CONTENT),
			jobId: "j1",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		let t = NOW;
		let calls = 0;
		const readyOnThirdTry = async () => {
			calls++;
			if (calls < 3) return { ok: false, status: 404, json: async () => ({}) };
			return { ok: true, status: 200, json: async () => REPORT };
		};
		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(ctxWith(true, cwd), writeEvent(`${cwd}/src/a.ts`), decision, {
			readDisk: () => CONTENT,
			fetchImpl: readyOnThirdTry,
			now: () => t,
			sleep: async (ms: number) => {
				t += ms;
			},
		});
		expect(calls).toBe(3);
		expect(decision.warnings?.join("\n")).toContain("surviving mutant");
	});

	it("reports a no-survivors harvest WITHOUT calling it clean", async () => {
		// Two requirements pull against each other here and both must hold.
		// Silence made the path unobservable: "claimed, waited, nothing
		// survived" looked identical to "never correlated at all". But the
		// harvest extracts SURVIVORS ONLY — no test run, no engine exit, no
		// mutant census, and it never passes through the evaluator — so "no
		// survivors" is equally consistent with a run that executed no tests.
		// Report the observation; refuse the word "clean".
		const cwd = process.cwd();
		recordPending(pendingRegistry(NOW), {
			file: "src/a.ts",
			overlayHash: overlayHash(CONTENT),
			jobId: "j1",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		const noSurvivors = async () => ({
			ok: true,
			status: 200,
			json: async () => ({ files: { "src/a.ts": { source: CONTENT, mutants: [] } } }),
		});
		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(ctxWith(true, cwd), writeEvent(`${cwd}/src/a.ts`), decision, {
			readDisk: () => CONTENT,
			fetchImpl: noSurvivors,
			now: () => NOW,
		});
		const said = decision.warnings?.join("\n") ?? "";
		// Observable: the agent can see the harvest reported and found nothing.
		expect(said).toContain("NO SURVIVORS");
		expect(said).toContain("1/1");
		// But NOT certified: survivor-only evidence is not a clean attestation.
		expect(said).not.toContain("measured clean");
		expect(said).toContain("not a clean attestation");
	});

	it("reports pending runs that never came back, instead of implying clean", async () => {
		const cwd = process.cwd();
		recordPending(pendingRegistry(NOW), {
			file: "src/a.ts",
			overlayHash: overlayHash(CONTENT),
			jobId: "j1",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		const refused = async () => {
			throw new Error("connection refused");
		};
		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(ctxWith(true, cwd), writeEvent(`${cwd}/src/a.ts`), decision, {
			readDisk: () => CONTENT,
			fetchImpl: refused,
			now: () => NOW,
		});
		const text = decision.warnings?.join("\n") ?? "";
		expect(text).toContain("not measured");
		expect(text).not.toContain("clean");
	});

	it("says nothing when no run is pending for the edited file", async () => {
		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(ctxWith(true, process.cwd()), writeEvent("/x/src/a.ts"), decision, {
			readDisk: () => CONTENT,
			fetchImpl: okFetch,
			now: () => NOW,
		});
		expect(decision.warnings ?? []).toHaveLength(0);
	});

	it("does not claim a run whose measured bytes are not the bytes that landed", async () => {
		// The safety property: an edit that changed after measurement, or a
		// different concurrent edit, must MISS rather than report a wrong answer.
		const cwd = process.cwd();
		recordPending(pendingRegistry(NOW), {
			file: "src/a.ts",
			overlayHash: overlayHash(CONTENT),
			jobId: "j1",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(ctxWith(true, cwd), writeEvent(`${cwd}/src/a.ts`), decision, {
			readDisk: () => "totally different content\n",
			fetchImpl: okFetch,
			now: () => NOW,
		});
		const text = decision.warnings?.join("\n") ?? "";
		// It must not report the measured survivors against text they were not
		// measured against — but it must SAY the guard fired, because a silent
		// miss is indistinguishable from "nothing was running" and hid a live
		// key-format bug for a whole session.
		expect(text).not.toContain("surviving mutant");
		expect(text).toContain("could not be matched");
	});

	// The disk read is the only unguarded I/O this phase performs, and it runs
	// AFTER the tool call succeeded: a file the agent (or a concurrent agent)
	// removed between the write and this window must degrade to "no current
	// bytes", never throw and never be hashed into a match.
	it("P: a file that vanished before the harvest window is reported as unreadable, not as a match", async () => {
		const cwd = process.cwd();
		// Never created — the real readFileSync raises ENOENT for it. No
		// `readDisk` seam here on purpose: this case is about the real reader.
		const vanished = "src/harvest-vanished-fixture.ts";
		recordPending(pendingRegistry(NOW), {
			file: vanished,
			overlayHash: overlayHash(CONTENT),
			jobId: "j-vanished",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(ctxWith(true, cwd), writeEvent(`${cwd}/${vanished}`), decision, {
			fetchImpl: okFetch,
			now: () => NOW,
		});
		// A reader that returned "" instead of null would hash the empty string
		// and print that digest here; one that rethrew would fail the phase's
		// never-throws contract before any warning was appended.
		expect(decision.warnings?.join("\n")).toBe(
			`[interlinked:mutation] ${vanished}: 1 pending run(s) could not be matched to what landed (measured ${overlayHash(CONTENT)}, on disk unreadable) — not measured.`,
		);
	});

	it("stays silent when the feature is disabled", async () => {
		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(ctxWith(false, process.cwd()), writeEvent("/x/src/a.ts"), decision, {
			readDisk: () => CONTENT,
			fetchImpl: okFetch,
			now: () => NOW,
		});
		expect(decision.warnings ?? []).toHaveLength(0);
	});

	it("never throws when the runner is unreachable — the write already happened", async () => {
		const cwd = process.cwd();
		recordPending(pendingRegistry(NOW), {
			file: "src/a.ts",
			overlayHash: overlayHash(CONTENT),
			jobId: "j1",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		const decision: HarnessDecision = { decision: "allow" };
		const boom = async () => {
			throw new Error("connection refused");
		};
		await expect(
			appendMutationHarvestWarning(ctxWith(true, cwd), writeEvent(`${cwd}/src/a.ts`), decision, {
				readDisk: () => CONTENT,
				fetchImpl: boom,
				now: () => NOW,
			}),
		).resolves.toBeUndefined();
		// It reports the unmeasured outcome rather than staying silent, but the
		// property under test here is that nothing escapes into the hook.
		expect(decision.warnings?.join("\n")).toContain("not measured");
	});

	it("ignores events that are not file writes", async () => {
		const decision: HarnessDecision = { decision: "allow" };
		const bashEvent = {
			hook_event: "PostToolUse",
			session_id: "s",
			tool_name: "Bash",
			tool_input: { command: "ls" },
		} as unknown as HarnessEvent;
		await appendMutationHarvestWarning(ctxWith(true, process.cwd()), bashEvent, decision, {
			readDisk: () => CONTENT,
			fetchImpl: okFetch,
			now: () => NOW,
		});
		expect(decision.warnings ?? []).toHaveLength(0);
	});
});
