// Mutation-hardening tests for local-activity-collection.ts.
// Each test pins a behavior that survived a single-change mutant of the module
// under the original suite. Real files in a tmpdir, no mocks.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseLocalActivityEvent, readCollectionActivity } from "./local-activity-collection.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "lac-mut-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function row(agent: string, command: string): string {
	return JSON.stringify({
		kind: "tool_event",
		ts: "2026-07-30T10:00:00Z",
		session_id: "s",
		agent_name: agent,
		provider_tool: "Bash",
		phase: "post",
		action: { command },
	});
}

/** Oldest-first file: `deep` matching rows, then `filler` non-matching rows. */
function writeRows(deep: number, filler: number): void {
	mkdirSync(join(tmp, ".interlinked"), { recursive: true });
	const lines: string[] = [];
	for (let i = 0; i < deep; i++) lines.push(row("needle", `deep-${i}`));
	for (let i = 0; i < filler; i++) lines.push(row("haystack", "n"));
	writeFileSync(join(tmp, ".interlinked", "collection.jsonl"), `${lines.join("\n")}\n`);
}

// Basis for the scan-window numbers: the existing suite's contract at
// local-activity-collection.test.ts:529-545 ("500-line floor"; "limit 1 -> scan
// budget max(1*20, 500)"; "limit 100 -> budget 2000"), which mirrors
// readLocalActivity at local-activity.ts:164.
describe("readCollectionActivity — tail scan window", () => {
	it("a limited read still sees a match sitting exactly on the 500th line from the tail", () => {
		// 1 needle followed by 499 filler lines: the needle is line 500 from the tail.
		writeRows(1, 499);
		expect(readCollectionActivity({ cwd: tmp, agent: "needle", limit: 1 })).toHaveLength(1);
	});

	it("the scan window grows by 20 lines per requested result once past the 500-line floor", () => {
		// limit 30 -> window 600. 30 needles sit in the oldest 30 of 600 lines
		// (filler 570 newest), so all 30 are inside the window.
		writeRows(30, 570);
		expect(readCollectionActivity({ cwd: tmp, agent: "needle", limit: 30 })).toHaveLength(30);
	});

	// Weaker basis: no doc states the unlimited-read window; the same constant
	// is used by readLocalActivity (local-activity.ts:164) which this reader
	// documents itself as mirroring (local-activity-collection.ts:291-292).
	it("an unlimited read scans 10000 lines from the tail", () => {
		writeRows(1, 9999);
		expect(readCollectionActivity({ cwd: tmp, agent: "needle" })).toHaveLength(1);
	});
});

// Basis: TokenUsage (local-activity-types.ts:13-14) and LocalActivityEvent
// (local-activity-types.ts:93) declare these fields; the parser doc says each
// optional field is kept when present and correctly typed.
describe("parseLocalActivityEvent — declared optional fields are kept", () => {
	const base = { ts: "2026-08-01T00:00:00Z", agent: "alpha", type: "tool_use" };

	it("keeps tokens.cache_creation alongside the other token counts", () => {
		const parsed = parseLocalActivityEvent({
			...base,
			tokens: { input: 1, output: 2, cache_read: 3, cache_creation: 4 },
		});
		expect(parsed?.tokens).toEqual({ input: 1, output: 2, cache_read: 3, cache_creation: 4 });
	});

	it("keeps the stop_hook_active boolean", () => {
		expect(parseLocalActivityEvent({ ...base, stop_hook_active: true })?.stop_hook_active).toBe(true);
		expect(parseLocalActivityEvent({ ...base, stop_hook_active: false })?.stop_hook_active).toBe(false);
	});
});
