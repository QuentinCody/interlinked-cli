import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ToolRunnerInput } from "../types.js";
import type { SpawnSyncStub } from "./test-process-fixtures.js";

const { resolvePackage, sync, asyncRun } = vi.hoisted(() => ({
	resolvePackage: vi.fn<() => string>(),
	sync: vi.fn<SpawnSyncStub>(),
	asyncRun: vi.fn<typeof import("../spawn-async.js").runProcessAsync>(),
}));
vi.mock("node:module", () => ({ createRequire: () => ({ resolve: resolvePackage }) }));
vi.mock("node:child_process", async (original) => ({
	...await original<typeof import("node:child_process")>(), spawnSync: sync,
}));
vi.mock("../spawn-async.js", () => ({ runProcessAsync: asyncRun }));

let root: string;
beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.stubEnv("GOMAXPROCS", undefined);
	root = mkdtempSync(join(tmpdir(), "tsgo-daemon-cpu-"));
	mkdirSync(join(root, "bin"));
	writeFileSync(join(root, "bin", "tsgo.js"), "");
	writeFileSync(join(root, "tsconfig.json"), "{}");
	resolvePackage.mockReturnValue(join(root, "package.json"));
	sync.mockImplementation((cmd, args) => ({
		pid: 1, status: cmd === "npx" && args.includes("--version") ? 1 : 0,
		stdout: "", stderr: "", signal: null, output: [],
	}));
	asyncRun.mockResolvedValue({ code: 0, stdout: "", stderr: "", timedOut: false, killed: false });
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

async function compile(input: ToolRunnerInput, daemon: boolean) {
	const { runTsc, runTscAsync, enableDaemonTsgoCpuLimit } = await import("./tsc.js");
	if (daemon) enableDaemonTsgoCpuLimit();
	expect(runTsc(input)).toEqual([]);
	expect(await runTscAsync(input)).toEqual([]);
	const syncCall = sync.mock.calls.find(([, args]) => args.includes("--noEmit"));
	const asyncCall = asyncRun.mock.calls[0];
	if (!syncCall || !asyncCall) throw new Error("expected both project compilers to spawn");
	expect(syncCall[1]).toEqual(asyncCall[1]);
	return { args: syncCall[1], envs: [syncCall[2].env, asyncCall[2]?.env] };
}

function project(): ToolRunnerInput {
	return { scope: { projectRoot: root, mode: "project" }, timeoutMs: 5000 };
}

it("gives native daemon project checks two Go processors while preserving the child environment", async () => {
	vi.stubEnv("TSGO_TEST_MARKER", "inherited");
	const { args, envs } = await compile(project(), true);
	expect(args).toEqual([join(root, "bin", "tsgo.js"), "--noEmit", "--pretty", "false"]);
	for (const env of envs) {
		expect(env?.GOMAXPROCS).toBe("2");
		expect(env?.TSGO_TEST_MARKER).toBe("inherited");
	}
	expect(process.env.GOMAXPROCS).toBeUndefined();
});

it.each(["1", "8"])("inherits the operator's GOMAXPROCS=%s for both daemon project runners", async value => {
	vi.stubEnv("GOMAXPROCS", value);
	const { envs } = await compile(project(), true);
	for (const env of envs) expect((env ?? process.env).GOMAXPROCS).toBe(value);
});

it("leaves ordinary foreground commands and explicit foreground verification unbounded", async () => {
	expect((await compile(project(), false)).envs).toEqual([undefined, undefined]);
	vi.clearAllMocks();
	expect((await compile({ ...project(), resourcePolicy: "foreground-verify" }, true)).envs)
		.toEqual([undefined, undefined]);
});

it("leaves regular tsc and standalone native file checks on their inherited environment", async () => {
	resolvePackage.mockReturnValue(join(root, "absent", "package.json"));
	const tsc = await compile(project(), true);
	expect(tsc.args[0]).toBe("tsc");
	expect(tsc.envs).toEqual([undefined, undefined]);
	vi.resetModules();
	vi.clearAllMocks();
	resolvePackage.mockReturnValue(join(root, "package.json"));
	rmSync(join(root, "tsconfig.json"));
	const targetFile = join(root, "single.ts");
	const standalone = await compile({ scope: { projectRoot: root, mode: "file", targetFile }, timeoutMs: 5000 }, true);
	expect(standalone.args).toContain(targetFile);
	expect(standalone.envs).toEqual([undefined, undefined]);
});
