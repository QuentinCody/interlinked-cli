import { spawn } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseWire, wireArray, wireString } from "../value-validation.js";
import { buildHookScript } from "../hooks-template.js";

interface HookRun {
    status: number | null;
    stdout: string;
    stderr: string;
}

const roots: string[] = [];

function checkout(withServer: boolean): string {
    const root = mkdtempSync(join(tmpdir(), "il-hook-recover-"));
    roots.push(root);
    const state = join(root, ".interlinked");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "interlinked-cli" }));
    writeFileSync(join(state, "config.json"), "{}");
    writeFileSync(join(state, "config.local.json"), JSON.stringify({ sync_mode: "local" }));
    writeFileSync(join(root, "hook.mjs"), buildHookScript("recovery-test"));
    if (withServer) {
        const server = join(root, "dist", "harness", "server.js");
        mkdirSync(join(root, "dist", "harness"), { recursive: true });
        writeFileSync(
            server,
            [
                'import { appendFileSync } from "node:fs";',
                'import { join } from "node:path";',
                'const i = process.argv.indexOf("--cwd");',
                'const root = i >= 0 ? process.argv[i + 1] : process.cwd();',
                'appendFileSync(join(root, ".interlinked", "fake-spawns.log"), String(process.pid) + "\\n");',
                'appendFileSync(join(root, ".interlinked", "fake-exec-argv.jsonl"), JSON.stringify(process.execArgv) + "\\n");',
                "setTimeout(() => process.exit(0), 5000);",
            ].join("\n"),
        );
    }
    return root;
}

function preTool(command: string, root: string): Record<string, unknown> {
    return {
        hook_event_name: "PreToolUse",
        session_id: "recovery-session",
        tool_name: "Bash",
        tool_input: { command },
        cwd: root,
    };
}

function recordPriorDaemon(root: string): void {
    const state = join(root, ".interlinked");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "harness.pid"), "2147480000\n");
}

function writeDisableMarker(root: string, name: "guard-disabled.json" | "guard-disabled.local.json"): void {
    writeFileSync(
        join(root, ".interlinked", name),
        JSON.stringify({ disabled: true, scope: "project", version: 1 }),
    );
}

function writeStartupLease(root: string, pid: number, at = Date.now()): void {
    writeFileSync(
        join(root, ".interlinked", ".harness-start.lock"),
        JSON.stringify({ pid, at }),
    );
}

function runHook(root: string, payload: Record<string, unknown>, path = process.env.PATH): Promise<HookRun> {
    return new Promise((resolve, reject) => {
		const env = Object.assign({}, process.env, {
			PATH: path,
			INTERLINKED_CLIENT: "claude",
			INTERLINKED_HOME: join(root, ".interlinked"),
			INTERLINKED_DATA_DIR: join(root, ".interlinked"),
		});
        const child = spawn(process.execPath, [join(root, "hook.mjs")], {
            cwd: root,
			env,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.once("error", reject);
        child.once("close", (status) => resolve({ status, stdout, stderr }));
        child.stdin.end(JSON.stringify(payload));
    });
}

function readSpawnedPids(root: string): number[] {
    const path = join(root, ".interlinked", "fake-spawns.log");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(Number);
}

async function spawnedPids(root: string): Promise<number[]> {
    const path = join(root, ".interlinked", "fake-spawns.log");
	for (let attempt = 0; attempt < 100 && !existsSync(path); attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
	return readSpawnedPids(root);
}

async function spawnedExecArgv(root: string): Promise<string[][]> {
    await spawnedPids(root);
    const path = join(root, ".interlinked", "fake-exec-argv.jsonl");
    for (let attempt = 0; attempt < 100 && !existsSync(path); attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => parseWire(JSON.parse(line), wireArray(wireString), "recorded process arguments"));
}

afterEach(() => {
    for (const root of roots.splice(0)) {
		for (const pid of readSpawnedPids(root)) {
            try {
                process.kill(pid, "SIGTERM");
            } catch (error) {
				// ESRCH is expected when the short-lived fake server already exited;
				// any other cleanup failure is evidence the test leaked a process.
				if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") {
					throw error;
				}
            }
        }
        rmSync(root, { recursive: true, force: true });
    }
});

describe("generated hook daemon recovery", () => {
    it("recovers on an ordinary event after a prior daemon disappeared", async () => {
        const root = checkout(true);
		recordPriorDaemon(root);
        const result = await runHook(root, preTool("echo safe", root));
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("daemon launch attempted");
        expect(await spawnedPids(root)).toHaveLength(1);
    });

    it("starts the recovery daemon with the canonical heap ceiling and idle-GC flag", async () => {
        const root = checkout(true);
        recordPriorDaemon(root);
        const result = await runHook(root, preTool("echo safe", root));
        expect(result.status).toBe(0);
        expect(await spawnedExecArgv(root)).toEqual([
            ["--max-old-space-size=1536", "--expose-gc"],
        ]);
    });

	it.each([
		["999999999999", "--max-old-space-size=1536"],
		["-1", "--max-old-space-size=1536"],
		["Infinity", "--max-old-space-size=1536"],
	] as const)("validates generated-hook heap override %s", async (raw, expected) => {
		const previous = process.env.INTERLINKED_HARNESS_HEAP_MB;
		process.env.INTERLINKED_HARNESS_HEAP_MB = raw;
		try {
			const root = checkout(true);
			recordPriorDaemon(root);
			const result = await runHook(root, preTool("echo safe", root));
			expect(result.status).toBe(0);
			expect((await spawnedExecArgv(root))[0]).toEqual([expected, "--expose-gc"]);
		} finally {
			if (previous === undefined) delete process.env.INTERLINKED_HARNESS_HEAP_MB;
			else process.env.INTERLINKED_HARNESS_HEAP_MB = previous;
		}
	});

	it("keeps generated-hook RSS whitespace handling in parity with the CLI default", async () => {
		const priorHeap = process.env.INTERLINKED_HARNESS_HEAP_MB;
		const priorRss = process.env.INTERLINKED_HARNESS_RSS_CEILING_MB;
		process.env.INTERLINKED_HARNESS_HEAP_MB = "3000";
		process.env.INTERLINKED_HARNESS_RSS_CEILING_MB = "  \t  ";
		try {
			const root = checkout(true);
			recordPriorDaemon(root);
			const result = await runHook(root, preTool("echo safe", root));
			expect(result.status).toBe(0);
			expect((await spawnedExecArgv(root))[0]).toEqual([
				"--max-old-space-size=1536",
				"--expose-gc",
			]);
		} finally {
			if (priorHeap === undefined) delete process.env.INTERLINKED_HARNESS_HEAP_MB;
			else process.env.INTERLINKED_HARNESS_HEAP_MB = priorHeap;
			if (priorRss === undefined) delete process.env.INTERLINKED_HARNESS_RSS_CEILING_MB;
			else process.env.INTERLINKED_HARNESS_RSS_CEILING_MB = priorRss;
		}
	});

    it("recovers when a live pid is paired with a stale socket file", async () => {
        const root = checkout(true);
        writeFileSync(join(root, ".interlinked", "harness.pid"), `${process.pid}\n`);
        writeFileSync(join(root, ".interlinked", "harness.sock"), "stale socket inode");
        const result = await runHook(root, preTool("echo safe", root));
        expect(result.status).toBe(0);
        expect(result.stderr).toContain("daemon launch attempted");
        expect(await spawnedPids(root)).toHaveLength(1);
    });

    it.each(["guard-disabled.json", "guard-disabled.local.json"] as const)(
        "honors a valid %s stand-down without spawning",
        async (name) => {
            const root = checkout(true);
            recordPriorDaemon(root);
            writeDisableMarker(root, name);
            const result = await runHook(root, preTool("echo safe", root));
            expect(result.status).toBe(0);
            expect(result.stderr).not.toContain("daemon launch");
            expect(await spawnedPids(root)).toEqual([]);
        },
    );

    it("fails toward guarding when a disable marker is corrupt", async () => {
        const root = checkout(true);
        recordPriorDaemon(root);
        writeFileSync(join(root, ".interlinked", "guard-disabled.local.json"), "{not-json");
        const result = await runHook(root, preTool("echo safe", root));
        expect(result.status).toBe(0);
        expect(result.stderr).toContain("daemon launch attempted");
        expect(await spawnedPids(root)).toHaveLength(1);
    });

    it("states that no launch happened when the server artifact is missing", async () => {
        const root = checkout(false);
		recordPriorDaemon(root);
        const result = await runHook(root, preTool("echo safe", root), join(root, "empty-path"));
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("daemon server artifact missing; no launch attempted");
        expect(result.stderr).not.toContain("daemon launch attempted");
        expect(await spawnedPids(root)).toEqual([]);
    });

    it("collapses a concurrent eight-hook burst to one daemon spawn", async () => {
        const root = checkout(true);
        const results = await Promise.all(
            Array.from({ length: 8 }, (_, i) => runHook(root, preTool(`echo safe-${i}`, root))),
        );
        expect(results.every((result) => result.status === 0)).toBe(true);
        expect(results.filter((result) => result.stderr.includes("daemon launch attempted"))).toHaveLength(1);
        expect(await spawnedPids(root)).toHaveLength(1);
    });

    it("does not overlap a daemon holding the startup lease while it quiesces", async () => {
        const root = checkout(true);
        recordPriorDaemon(root);
        writeStartupLease(root, process.pid);
        const result = await runHook(root, preTool("echo safe", root));
        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain("daemon launch");
        expect(await spawnedPids(root)).toEqual([]);
    });

    it("does not steal a live child lease 20 seconds into a slow cold start", async () => {
        const root = checkout(true);
        recordPriorDaemon(root);
        writeStartupLease(root, process.pid, Date.now() - 20_000);
        const result = await runHook(root, preTool("echo safe", root));
        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain("daemon launch");
        expect(await spawnedPids(root)).toEqual([]);
    });

    it("reclaims the quiesce lease immediately after its owner dies", async () => {
        const root = checkout(true);
        recordPriorDaemon(root);
        writeStartupLease(root, 2_147_480_000);
        const result = await runHook(root, preTool("echo safe", root));
        expect(result.status).toBe(0);
        expect(result.stderr).toContain("daemon launch attempted");
        expect(await spawnedPids(root)).toHaveLength(1);
    });

    it("does not steal a freshly-created lock whose owner bytes are still incomplete", async () => {
        const root = checkout(true);
        recordPriorDaemon(root);
        writeFileSync(join(root, ".interlinked", ".harness-start.lock"), "");
        const result = await runHook(root, preTool("echo safe", root));
        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain("daemon launch");
        expect(await spawnedPids(root)).toEqual([]);
    });

    it.each([
        "interlinked harness status --json",
        "node dist/index.js harness restart",
        "interlinked disable --reason daemon-memory-repair",
        "interlinked install-hooks --refresh --preserve-mode",
    ])("lets the exact operator command run without racing it: %s", async (command) => {
        const root = checkout(false);
		recordPriorDaemon(root);
        const result = await runHook(root, preTool(command, root), join(root, "empty-path"));
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain("daemon launch");
        expect(result.stderr).not.toContain("server artifact missing");
    });

    it("does not exempt a compound command merely because it starts with a repair command", async () => {
        const root = checkout(true);
        recordPriorDaemon(root);
        const result = await runHook(
            root,
            preTool("node dist/index.js harness status && echo not-exact", root),
        );
        expect(result.status).toBe(0);
        expect(result.stderr).toContain("daemon launch attempted");
        expect(await spawnedPids(root)).toHaveLength(1);
    });

    it("still refuses a deterministic destructive command while recovery is unavailable", async () => {
        const root = checkout(false);
		recordPriorDaemon(root);
        const result = await runHook(root, preTool("rm -rf /", root), join(root, "empty-path"));
        expect(result.status).toBe(0);
        const response: unknown = JSON.parse(result.stdout);
        expect(response).toHaveProperty("hookSpecificOutput.permissionDecision", "deny");
        expect(response).toHaveProperty("hookSpecificOutput.permissionDecisionReason", expect.stringMatching(/BLOCKED|rm -rf|recursive/i));
    });
});
