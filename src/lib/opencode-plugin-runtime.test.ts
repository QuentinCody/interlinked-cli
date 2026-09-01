import { createServer, type Server } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildOpencodePluginSource } from "./opencode-plugin-source.js";
import { mapOpencode2Tool } from "./opencode-tool-map.js";

interface PluginModule {
	default: { id: string; setup: (ctx: unknown) => Promise<void> };
}

async function loadPlugin(dir: string): Promise<PluginModule> {
	const path = join(dir, "plugin.ts");
	writeFileSync(path, buildOpencodePluginSource());
	return (await import(pathToFileURL(path).href)) as PluginModule;
}

function startHarness(dir: string, replies: string[]): Promise<{ server: Server; sock: string }> {
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
	const sock = join(dir, ".interlinked", "harness.sock");
	return new Promise((resolve, reject) => {
		const server = createServer((c) => {
			let buf = "";
			c.on("data", (chunk) => {
				buf += chunk.toString("utf8");
				if (!buf.includes("\n")) return;
				const reply = replies.shift() ?? '{"decision":"allow"}\n';
				c.write(reply);
			});
		});
		server.on("error", reject);
		server.listen(sock, () => resolve({ server, sock }));
	});
}

describe("generated OpenCode v2 plugin against a fake host", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	it("registers tool hooks and event.subscribe lifecycle, blocks Write, skips PostToolUse on read", async () => {
		const dir = mkdtempSync(join(tmpdir(), "oc2-plugin-"));
		dirs.push(dir);
		const { server } = await startHarness(dir, [
			'{"decision":"block","reason":"nope"}\n',
			'{"decision":"allow","warnings":["[interlinked:x] warn"]}\n',
		]);
		try {
			const hooks: Record<string, (event: Record<string, unknown>) => Promise<unknown>> = {};
			const events: Record<string, (event: Record<string, unknown>) => unknown> = {};
			const plugin = await loadPlugin(dir);
			expect(plugin.default.id).toBe("interlinked-opencode2");
			await plugin.default.setup({
				location: { directory: dir },
				tool: {
					hook: async (name: string, fn: (e: Record<string, unknown>) => Promise<unknown>) => {
						hooks[name] = fn;
					},
				},
				event: {
					subscribe: (name: string, fn: (e: Record<string, unknown>) => unknown) => {
						events[name] = fn;
					},
				},
			});
			expect(Object.keys(hooks).sort()).toEqual(["execute.after", "execute.before"]);
			expect(Object.keys(events).sort()).toEqual(["session.created", "session.deleted", "session.idle"]);
			await expect(
				hooks["execute.before"]?.({
					tool: "write",
					args: { filePath: join(dir, "a.ts"), content: "x" },
					sessionID: "s",
				}),
			).rejects.toThrow(/nope/);
			const afterRead = { tool: "read", args: { filePath: "a.ts" }, sessionID: "s" };
			await hooks["execute.after"]?.(afterRead);
			expect(afterRead).not.toHaveProperty("output");
			const afterWrite: Record<string, unknown> = {
				tool: "write",
				args: { filePath: "a.ts", content: "x" },
				sessionID: "s",
				output: "ok",
			};
			await hooks["execute.after"]?.(afterWrite);
			expect(String(afterWrite.output)).toContain("[interlinked:x] warn");
			events["session.created"]?.({ id: "s" });
			events["session.deleted"]?.({ id: "s" });
			events["session.idle"]?.({ id: "s" });
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("cold-blocks rm -fr / when the daemon closes before a complete line", async () => {
		const dir = mkdtempSync(join(tmpdir(), "oc2-plugin-"));
		dirs.push(dir);
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const sock = join(dir, ".interlinked", "harness.sock");
		const server = createServer((c) => {
			c.on("data", () => c.end());
		});
		await new Promise<void>((resolve, reject) => {
			server.on("error", reject);
			server.listen(sock, () => resolve());
		});
		try {
			const hooks: Record<string, (event: Record<string, unknown>) => Promise<unknown>> = {};
			const plugin = await loadPlugin(dir);
			await plugin.default.setup({
				location: { directory: dir },
				tool: {
					hook: async (name: string, fn: (e: Record<string, unknown>) => Promise<unknown>) => {
						hooks[name] = fn;
					},
				},
				event: { subscribe: () => undefined },
			});
			await expect(
				hooks["execute.before"]?.({ tool: "bash", args: { command: "rm -fr /" }, sessionID: "s" }),
			).rejects.toThrow(/BLOCKED/);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("cold-blocks rm -fr / on malformed daemon JSON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "oc2-plugin-"));
		dirs.push(dir);
		const { server } = await startHarness(dir, ["not-json\n"]);
		try {
			const hooks: Record<string, (event: Record<string, unknown>) => Promise<unknown>> = {};
			const plugin = await loadPlugin(dir);
			await plugin.default.setup({
				location: { directory: dir },
				tool: {
					hook: async (name: string, fn: (e: Record<string, unknown>) => Promise<unknown>) => {
						hooks[name] = fn;
					},
				},
				event: { subscribe: () => undefined },
			});
			await expect(
				hooks["execute.before"]?.({ tool: "bash", args: { command: "rm -fr /" }, sessionID: "s" }),
			).rejects.toThrow(/BLOCKED/);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("generated mapTool matches mapOpencode2Tool", () => {
		const src = buildOpencodePluginSource();
		const start = src.indexOf("function asRecord");
		const end = src.indexOf("function findSocket");
		const mapTool = new Function(`${src.slice(start, end)}; return mapTool;`)() as (
			tool: string,
			args: unknown,
		) => { tool_name: string; tool_input: Record<string, unknown> };
		const samples: Array<[string, Record<string, unknown>]> = [
			["write", { filePath: "/a.ts", content: "x" }],
			["edit", { filePath: "/a.ts", oldString: "a", newString: "b" }],
			["bash", { command: "ls", workdir: "/tmp" }],
		];
		for (const [tool, args] of samples) {
			expect(mapTool(tool, args)).toEqual(mapOpencode2Tool(tool, args));
		}
	});
});
