import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { tryAcquireProjectHeavyProcessLease } from "../../harness/project-heavy-process-lock.js";
import { LEASE_ANCESTORS_ENV } from "../../harness/project-compiler-lock.js";
import { CAPACITY_SCOPE_ENV } from "../../harness/test-capacity.js";

function project(): string {
	const root = mkdtempSync(join(tmpdir(), "verify-project-admission-"));
	writeFileSync(join(root, "input.ts"), "export const value = 1;\n");
	return root;
}

function startVerify(root: string, extra: string[] = []) {
	const env: NodeJS.ProcessEnv = { ...process.env, [CAPACITY_SCOPE_ENV]: `verify-admission-${root}` };
	delete env[LEASE_ANCESTORS_ENV];
	delete env.INTERLINKED_RESOURCE_SUPERVISOR_PID;
	const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "verify", root,
		"--only", "unknown-admission-fixture-tool", "--json", ...extra], {
		cwd: process.cwd(), env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "", stderr = "", closed = false;
	child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
	child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
	const outcome = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); });
	});
	return { child, outcome, stdout: () => stdout, stderr: () => stderr, closed: () => closed };
}

function stopOwnedChild(child: ReturnType<typeof startVerify>["child"]): void {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") child.kill("SIGKILL");
		else process.kill(-child.pid, "SIGKILL");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
	}
}

it("public verify waits behind an independent project owner, then scans after release", async () => {
	const root = project(), release = tryAcquireProjectHeavyProcessLease(root);
	expect(release).not.toBeNull();
	const run = startVerify(root);
	try {
		await vi.waitFor(() => expect(run.stderr()).toContain("verify waiting for the project check lane"), { timeout: 12_000 });
		expect(run.closed()).toBe(false); expect(run.stdout()).toBe("");
		expect(tryAcquireProjectHeavyProcessLease(root)).toBeNull();
		release?.();
		expect(await run.outcome, run.stderr()).toMatchObject({ code: 0, signal: null });
		expect(JSON.parse(run.stdout())).toMatchObject({ files_scanned: 1 });
		const next = tryAcquireProjectHeavyProcessLease(root); expect(next).not.toBeNull(); next?.();
	} finally { stopOwnedChild(run.child); release?.(); rmSync(root, { recursive: true, force: true }); }
}, 25_000);

it("public cancellation stops a project waiter before scanning and preserves the live owner's lane", async () => {
	const root = project(), release = tryAcquireProjectHeavyProcessLease(root);
	expect(release).not.toBeNull();
	const run = startVerify(root);
	try {
		await vi.waitFor(() => expect(run.stderr()).toContain("verify waiting for the project check lane"), { timeout: 12_000 });
		run.child.kill("SIGTERM");
		expect(await run.outcome, run.stderr()).toMatchObject({ code: 75 });
		expect(run.stdout()).toBe(""); expect(run.stderr()).toContain("no verification verdict");
		expect(tryAcquireProjectHeavyProcessLease(root)).toBeNull();
	} finally { stopOwnedChild(run.child); release?.(); rmSync(root, { recursive: true, force: true }); }
}, 25_000);

it("an explicit public command timeout includes project waiting without stealing the live lease", async () => {
	const root = project(), release = tryAcquireProjectHeavyProcessLease(root);
	expect(release).not.toBeNull();
	const run = startVerify(root, ["--timeout", "4000"]);
	try {
		expect(await run.outcome, run.stderr()).toMatchObject({ code: 75 });
		expect(run.stdout()).toBe(""); expect(run.stderr()).toContain("no verification verdict");
		expect(tryAcquireProjectHeavyProcessLease(root)).toBeNull();
	} finally { stopOwnedChild(run.child); release?.(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);
