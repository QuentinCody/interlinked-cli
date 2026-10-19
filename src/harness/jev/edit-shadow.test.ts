import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluatePostToolUse } from "../evaluator/post-tool.js";
import { CohortManager } from "../cohort.js";
import { ReservationManager } from "../reservations.js";
import { DEFAULT_CONFIG } from "../rules/default-config.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import type { JevFetch } from "./client.js";
import {
	EDIT_SHADOW_LEDGER,
	EDIT_SHADOW_QUESTION_ID,
	EDIT_SHADOW_SUMMARY_CHARS,
	editShadowSpendUsd,
	isCodeScopeFile,
	resetEditShadowState,
	runEditShadow,
	scheduleEditShadow,
} from "./edit-shadow.js";

let dir: string;

beforeEach(() => {
	resetEditShadowState();
	dir = mkdtempSync(join(tmpdir(), "jev-shadow-"));
	mkdirSync(join(dir, ".interlinked"));
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src", "calc.ts"), "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n");
	mkdirSync(join(dir, "src", "__tests__"));
	writeFileSync(join(dir, "src", "__tests__", "calc.test.ts"), "import { it } from 'vitest';\nit('adds', () => {});\n");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.useRealTimers();
});

function rules(jev?: GuardRulesConfig["jev"]): GuardRulesConfig {
	const base = structuredClone(DEFAULT_CONFIG);
	return jev ? { ...base, jev } : base;
}

const ON = { enabled: true, shadow_edits: true } as const;

function editEvent(over: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "s1",
		agent_source: "claude",
		agent_name: "main",
		tool_name: "Edit",
		tool_use_id: `tu-${Math.random()}`,
		tool_input: { file_path: join(dir, "src", "calc.ts"), old_string: "a + b", new_string: "a - b" },
		cwd: dir,
		timestamp: "2026-10-08T00:00:00Z",
		...over,
	};
}

function okFetch(p = 0.83, inputTokens = 300): { fetchImpl: JevFetch; calls: { body: unknown }[] } {
	const calls: { body: unknown }[] = [];
	const fetchImpl: JevFetch = async (_url, init) => {
		calls.push({ body: JSON.parse(String(init.body)) });
		const body = { model: "jev-test", answers: { [EDIT_SHADOW_QUESTION_ID]: { type: "noul", noul: p } }, usage: { input_tokens: inputTokens, output_tokens: 1 } };
		return new Response(JSON.stringify(body), { status: 200 });
	};
	return { fetchImpl, calls };
}

const key = () => "test-key";

function ledgerRows(): Record<string, unknown>[] {
	const path = join(dir, ".interlinked", EDIT_SHADOW_LEDGER);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("runEditShadow — positive (must fire)", () => {
	it("P1: enabled + cappable file → one call with the fixed question, one row with p", async () => {
		const { fetchImpl, calls } = okFetch(0.83, 300);
		const row = await runEditShadow(editEvent(), rules(ON), { fetchImpl, resolveKey: key });
		expect(calls).toHaveLength(1);
		const sent = calls[0]?.body as { state: Record<string, unknown>; questions: Record<string, unknown> };
		expect(sent.state).toEqual({ file: "src/calc.ts", tool: "Edit", edit_summary: "a - b", before_excerpt: "a + b" });
		expect(Object.keys(sent.questions)).toEqual([EDIT_SHADOW_QUESTION_ID]);
		expect(row?.p).toBe(0.83);
		const rows = ledgerRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ session_id: "s1", surface: "edit", agent: "main", tool: "Edit", file: "src/calc.ts", p: 0.83, input_tokens: 300, model: "jev-test", error: null, question_id: EDIT_SHADOW_QUESTION_ID });
		expect(rows[0]).not.toHaveProperty("session");
		expect(typeof rows[0]?.latency_ms).toBe("number");
		expect(rows[0]?.usd).toBeCloseTo(300 * (0.042 / 1_000_000), 12);
	});

	it("P1b: Write sends the first 4,000 chars of content and no before_excerpt", async () => {
		const { fetchImpl, calls } = okFetch();
		const content = "x".repeat(EDIT_SHADOW_SUMMARY_CHARS + 50);
		await runEditShadow(editEvent({ tool_name: "Write", tool_input: { file_path: join(dir, "src", "calc.ts"), content } }), rules(ON), { fetchImpl, resolveKey: key });
		const sent = calls[0]?.body as { state: Record<string, unknown> };
		expect(sent.state.edit_summary).toBe("x".repeat(EDIT_SHADOW_SUMMARY_CHARS));
		expect("before_excerpt" in sent.state).toBe(false);
	});

	it("P5: HTTP error → row with p null and the error class; post-tool decision is allow with no shadow warning", async () => {
		const fetchImpl: JevFetch = async () => new Response("no", { status: 503 });
		const row = await runEditShadow(editEvent(), rules(ON), { fetchImpl, resolveKey: key });
		expect(row).toMatchObject({ p: null, error: "http_503" });
		expect(ledgerRows()[0]).toMatchObject({ p: null, error: "http_503" });
	});

	it("P5b: timeout → row with p null and error timeout", async () => {
		const fetchImpl: JevFetch = (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new DOMException("t", "TimeoutError")));
			});
		const row = await runEditShadow(editEvent(), rules({ ...ON, shadow_timeout_ms: 20 }), { fetchImpl, resolveKey: key });
		expect(row).toMatchObject({ p: null, error: "timeout" });
		expect(ledgerRows()).toHaveLength(1);
	});

	it("P7: apply_patch on a cappable file → one row with tool apply_patch, the parsed file and that file's hunk", async () => {
		const { fetchImpl, calls } = okFetch(0.7);
		writeFileSync(join(dir, "README.md"), "# r\n");
		const command = [
			"*** Begin Patch",
			`*** Update File: ${join(dir, "README.md")}`,
			"@@",
			"-# r",
			"+# readme",
			`*** Update File: ${join(dir, "src", "calc.ts")}`,
			"@@",
			"-\treturn a + b;",
			"+\treturn a - b;",
			"*** End Patch",
		].join("\n");
		const row = await runEditShadow(editEvent({ tool_name: "apply_patch", tool_input: { command } }), rules(ON), { fetchImpl, resolveKey: key });
		expect(calls).toHaveLength(1);
		const sent = calls[0]?.body as { state: Record<string, unknown> };
		expect(sent.state).toEqual({ file: "src/calc.ts", tool: "apply_patch", edit_summary: "@@\n-\treturn a + b;\n+\treturn a - b;" });
		expect(row).toMatchObject({ tool: "apply_patch", file: "src/calc.ts", p: 0.7 });
		expect(ledgerRows()).toHaveLength(1);
	});

	it("P8: scope code + an apply_patch adding a scratch/ .py file → one row", async () => {
		const { fetchImpl, calls } = okFetch(0.4);
		mkdirSync(join(dir, "scratch", "e7"), { recursive: true });
		const py = join(dir, "scratch", "e7", "probe.py");
		writeFileSync(py, "print(1)\n");
		const command = `*** Begin Patch\n*** Add File: ${py}\n+print(1)\n*** End Patch`;
		const row = await runEditShadow(editEvent({ tool_name: "apply_patch", tool_input: { command } }), rules({ ...ON, shadow_scope: "code" }), { fetchImpl, resolveKey: key });
		expect(calls).toHaveLength(1);
		expect(row).toMatchObject({ tool: "apply_patch", file: "scratch/e7/probe.py", p: 0.4 });
	});

	it("P6: spend cap reached → one spend_cap row, then no further calls or rows", async () => {
		const { fetchImpl, calls } = okFetch(0.5, 10_000_000); // $0.42 per call
		const cfg = rules({ ...ON, shadow_max_spend_usd: 0.4 });
		await runEditShadow(editEvent(), cfg, { fetchImpl, resolveKey: key });
		expect(editShadowSpendUsd()).toBeGreaterThanOrEqual(0.4);
		const capped = await runEditShadow(editEvent(), cfg, { fetchImpl, resolveKey: key });
		const after = await runEditShadow(editEvent(), cfg, { fetchImpl, resolveKey: key });
		expect(calls).toHaveLength(1);
		expect(capped).toMatchObject({ p: null, error: "spend_cap" });
		expect(after).toBeNull();
		expect(ledgerRows().map((r) => r.error)).toEqual([null, "spend_cap"]);
	});
});

describe("runEditShadow — negative (must not fire)", () => {
	it("P2: dry_run → no call and no row", async () => {
		const { fetchImpl, calls } = okFetch();
		expect(await runEditShadow(editEvent({ dry_run: true }), rules(ON), { fetchImpl, resolveKey: key })).toBeNull();
		expect(calls).toHaveLength(0);
		expect(ledgerRows()).toHaveLength(0);
	});

	it("P3: default config (no jev section) and enabled-without-shadow_edits → no call", async () => {
		const { fetchImpl, calls } = okFetch();
		expect(await runEditShadow(editEvent(), rules(), { fetchImpl, resolveKey: key })).toBeNull();
		expect(await runEditShadow(editEvent(), rules({ enabled: true }), { fetchImpl, resolveKey: key })).toBeNull();
		expect(await runEditShadow(editEvent(), rules({ enabled: false, shadow_edits: true }), { fetchImpl, resolveKey: key })).toBeNull();
		expect(calls).toHaveLength(0);
		expect(ledgerRows()).toHaveLength(0);
	});

	it("P4: test file, non-code file, Read tool and failed edit → no call", async () => {
		const { fetchImpl, calls } = okFetch();
		writeFileSync(join(dir, "notes.md"), "# notes\n");
		const events = [
			editEvent({ tool_input: { file_path: join(dir, "src", "__tests__", "calc.test.ts"), old_string: "a", new_string: "b" } }),
			editEvent({ tool_input: { file_path: join(dir, "notes.md"), old_string: "a", new_string: "b" } }),
			editEvent({ tool_name: "Read", tool_input: { file_path: join(dir, "src", "calc.ts") } }),
			editEvent({ tool_outcome: "error" }),
			editEvent({ hook_event: "PreToolUse" }),
		];
		for (const e of events) expect(await runEditShadow(e, rules(ON), { fetchImpl, resolveKey: key })).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it("N5: scope cappable (default) + a scratch/ code file → no call and no row", async () => {
		const { fetchImpl, calls } = okFetch();
		mkdirSync(join(dir, "scratch"));
		const py = join(dir, "scratch", "probe.py");
		writeFileSync(py, "print(1)\n");
		const command = `*** Begin Patch\n*** Add File: ${py}\n+print(1)\n*** End Patch`;
		expect(await runEditShadow(editEvent({ tool_name: "apply_patch", tool_input: { command } }), rules(ON), { fetchImpl, resolveKey: key })).toBeNull();
		expect(await runEditShadow(editEvent({ tool_input: { file_path: py, old_string: "1", new_string: "2" } }), rules({ ...ON, shadow_scope: "cappable" }), { fetchImpl, resolveKey: key })).toBeNull();
		expect(calls).toHaveLength(0);
		expect(ledgerRows()).toHaveLength(0);
	});

	it("N6: apply_patch with only .md targets (any scope) → no call and no row", async () => {
		const { fetchImpl, calls } = okFetch();
		writeFileSync(join(dir, "a.md"), "a\n");
		const command = `*** Begin Patch\n*** Update File: ${join(dir, "a.md")}\n@@\n-a\n+b\n*** Add File: ${join(dir, "b.md")}\n+b\n*** End Patch`;
		for (const scope of ["cappable", "code"] as const) {
			expect(await runEditShadow(editEvent({ tool_name: "apply_patch", tool_input: { command } }), rules({ ...ON, shadow_scope: scope }), { fetchImpl, resolveKey: key })).toBeNull();
		}
		expect(calls).toHaveLength(0);
		expect(ledgerRows()).toHaveLength(0);
	});

	it("N7: scope code still excludes tests, declarations, dist/node_modules/generated and paths outside the root", () => {
		for (const rel of ["src/a.test.ts", "src/a.spec.mjs", "src/__tests__/a.ts", "src/a.d.ts", "dist/a.js", "node_modules/x/a.js", "src/generated/a.ts", "../other/a.ts", "src/a.md"]) {
			expect(isCodeScopeFile(join(dir, rel), dir)).toBe(false);
		}
		expect(isCodeScopeFile(join(dir, "scratch", "a.py"), dir)).toBe(true);
	});

	it("N1: no API key → no call and no row", async () => {
		const { fetchImpl, calls } = okFetch();
		expect(await runEditShadow(editEvent(), rules(ON), { fetchImpl, resolveKey: () => undefined })).toBeNull();
		expect(calls).toHaveLength(0);
		expect(ledgerRows()).toHaveLength(0);
	});

	it("N2: a repeated delivery of the same tool_use_id → at most one call", async () => {
		const { fetchImpl, calls } = okFetch();
		const e = editEvent({ tool_use_id: "tu-same" });
		await runEditShadow(e, rules(ON), { fetchImpl, resolveKey: key });
		expect(await runEditShadow(e, rules(ON), { fetchImpl, resolveKey: key })).toBeNull();
		expect(calls).toHaveLength(1);
	});

	it("N3: enabled, the post-tool path schedules the shadow but the decision carries no shadow warning", () => {
		// Swallow the deferred run: the real key resolver would reach the network.
		const spy = vi.spyOn(globalThis, "setImmediate").mockImplementation((() => undefined) as unknown as typeof setImmediate);
		const decision = evaluatePostToolUse(editEvent(), rules(ON), undefined, new ReservationManager(), new CohortManager());
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
		expect(decision.decision).toBe("allow");
		expect((decision.warnings ?? []).some((w) => w.includes("jev") || w.includes(EDIT_SHADOW_QUESTION_ID))).toBe(false);
	});

	it("N4: scheduleEditShadow is a no-op for dry_run and disabled config", () => {
		const spy = vi.spyOn(globalThis, "setImmediate");
		scheduleEditShadow(editEvent({ dry_run: true }), rules(ON));
		scheduleEditShadow(editEvent(), rules());
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});
