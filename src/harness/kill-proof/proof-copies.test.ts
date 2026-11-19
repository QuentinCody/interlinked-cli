import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openProofContext, type ProofContextOptions } from "./run.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "proof-context-close-"));
	execFileSync("git", ["init", "-q", root]);
	writeFileSync(join(root, "subject.test.ts"), "export {};\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function contextWith(runner: NonNullable<ProofContextOptions["runner"]>) {
	const opened = openProofContext({ root, tests: ["subject.test.ts"], budgetMs: 500, runner });
	if (!opened.ok) throw new Error(opened.reasons.join(", "));
	return opened.context;
}

it("closing a context while its first copy is in flight releases that copy", async () => {
	const context = contextWith(async () => { throw new Error("freezing inputs should never start the runner"); });
	const pending = context.frozen();
	expect(context.frozen()).toBe(pending);
	try {
		await Promise.all([context.close(), context.close()]);
		const inputs = await pending;
		if ("problem" in inputs) throw new Error(inputs.problem);
		expect(existsSync(inputs.dir)).toBe(false);
	} finally {
		await context.close();
	}
});

it("close waits for a running clone and its frozen source before resolving", async () => {
	let entered!: () => void, finish!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { finish = resolve; });
	const context = contextWith(async (dir) => {
		expect(existsSync(join(dir, "subject.test.ts"))).toBe(true);
		entered();
		await gate;
		return { cases: [], timedOut: false, exitCode: 0, durationMs: 0 };
	});
	const frozen = await context.frozen();
	if ("problem" in frozen) throw new Error(frozen.problem);
	const running = context.runIn(new Map());
	await started;
	const closing = context.close();
	try {
		expect(await Promise.race([closing.then(() => "closed"), new Promise(resolve => setImmediate(() => resolve("pending")))])).toBe("pending");
		expect(existsSync(frozen.dir)).toBe(true);
	} finally {
		finish();
		await closing;
	}
	const result = await running;
	expect(existsSync(result.dir)).toBe(false);
	expect(existsSync(frozen.dir)).toBe(false);
});
