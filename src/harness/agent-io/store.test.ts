// ===========================================
// agent-io store — companion for the pipeline choke point
// ===========================================
// Sibling `.mutation-kill-*.test.ts` files in this directory cover most of
// store.ts already; this file's one job is the shallow tail those files
// don't reach: `recordAgentIo`'s outer catch (CLAUDE.md, "A dry run must not
// move the gate" — capture must never break the guard pipeline).

// One real absolute directory path is designated to make mkdirSync throw —
// simulating the append pipeline failing mid-write — while every other path
// is delegated to the real implementation.
let failMkdirPath: string | null = null;
import { vi } from "vitest";
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
			const [p] = args;
			if (typeof p === "string" && p === failMkdirPath) {
				throw new Error("EACCES: simulated mkdir failure for coverage");
			}
			return actual.mkdirSync(...args);
		},
	};
});

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentIoLogPath, type AgentIoRowInput, recordAgentIo } from "./store.js";

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
	failMkdirPath = null;
});

function makeCwd(): string {
	const cwd = mkdtempSync(join(tmpdir(), "agent-io-store-companion-"));
	roots.push(cwd);
	return cwd;
}

function row(): AgentIoRowInput {
	return {
		ts: "2026-01-01T00:00:00.000Z",
		runner: "test",
		direction: "input",
		role: "user",
		kind: "final_message",
		source: "payload",
		raw: "hello",
	};
}

describe("recordAgentIo — fail-open catch around the append pipeline", () => {
	it("returns 0 and writes no log row when mkdirSync throws mid-write", () => {
		const cwd = makeCwd();
		failMkdirPath = join(cwd, ".interlinked");
		const n = recordAgentIo([row()], { cwd });
		expect(n).toBe(0);
		expect(existsSync(agentIoLogPath(cwd))).toBe(false);
	});
});
