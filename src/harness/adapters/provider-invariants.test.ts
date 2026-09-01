// Cross-provider invariants. A new runner that only has a smoke test is not done:
// these must stay green for every adapter in buildAllAdapters().

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONSUMED_PAYLOAD_KEYS } from "../payload-key-census.js";
import { isFileWrite } from "../evaluator/tool-classifiers.js";
import { installHooks } from "../installer.js";
import { PROVIDER_BY_SOURCE } from "../server/agent-event-capture.js";
import { AGENT_SOURCES } from "../types/events.js";
import { DIRECT_FILE_EDIT_TOOLS } from "../../lib/write-tool-registry.js";
import { CLIENT_TO_RUNNER, detectClients } from "../../lib/settings.js";
import { runnerOf } from "../../lib/viz/agent-roster.js";
import { buildAllAdapters } from "./index.js";
import type { RunnerId } from "../unified-event.js";

interface WriteFixture {
	nativeEvent: string;
	payload: Record<string, unknown>;
	/** Expected unified tool_class after parse. */
	toolClass: "modify" | "write";
}

/** One native write/edit payload per runner. Missing an adapter id fails the suite. */
const WRITE_FIXTURES: Record<RunnerId, WriteFixture> = {
	"claude-code": {
		nativeEvent: "PreToolUse",
		payload: { session_id: "s", cwd: "/r", tool_name: "Write", tool_input: { file_path: "/r/a.ts", content: "x" } },
		toolClass: "write",
	},
	"copilot-cli": {
		nativeEvent: "preToolUse",
		payload: { sessionId: "s", cwd: "/r", toolName: "edit_file", toolInput: { path: "/r/a.ts" } },
		toolClass: "modify",
	},
	cursor: {
		nativeEvent: "preToolUse",
		payload: { session_id: "s", cwd: "/r", tool_name: "Edit", tool_input: { file_path: "/r/a.ts" } },
		toolClass: "modify",
	},
	"gemini-cli": {
		nativeEvent: "BeforeTool",
		payload: { session_id: "s", cwd: "/r", tool_name: "write_file", tool_input: { path: "/r/a.ts" } },
		toolClass: "write",
	},
	codex: {
		nativeEvent: "PreToolUse",
		payload: { session_id: "s", cwd: "/r", tool_name: "Write", tool_input: { file_path: "/r/a.ts", content: "x" } },
		toolClass: "write",
	},
	opencode: {
		nativeEvent: "tool.execute.before",
		payload: { sessionID: "s", cwd: "/r", tool: "edit", args: { file_path: "/r/a.ts" } },
		toolClass: "modify",
	},
	opencode2: {
		nativeEvent: "tool.execute.before",
		payload: { sessionID: "s", cwd: "/r", tool: "write", args: { filePath: "/r/a.ts", content: "x" } },
		toolClass: "write",
	},
	pi: {
		nativeEvent: "tool_call",
		payload: { sessionId: "s", cwd: "/r", toolName: "edit", input: { file_path: "/r/a.ts" } },
		toolClass: "modify",
	},
};

function looksLikeAllow(out: { exit_code: number; stdout?: string }): boolean {
	if (out.exit_code !== 0) return false;
	if (!out.stdout) return true;
	try {
		const parsed = JSON.parse(out.stdout) as { decision?: string; permissionDecision?: string };
		return parsed.decision === "allow" || parsed.permissionDecision === "allow";
	} catch {
		return false;
	}
}

function adapterHasAskOrPermission(adapter: ReturnType<typeof buildAllAdapters>[number]): boolean {
	return adapter.capabilities.events.some(
		(event) => event.install && (event.control === "ask" || event.control === "permission"),
	);
}

describe("agent_source maps are exhaustive", () => {
	it("PROVIDER_BY_SOURCE has a label for every AgentSource", () => {
		for (const source of AGENT_SOURCES) {
			expect(PROVIDER_BY_SOURCE[source], source).toEqual(expect.any(String));
			expect(PROVIDER_BY_SOURCE[source].length).toBeGreaterThan(0);
		}
		expect(Object.keys(PROVIDER_BY_SOURCE).sort()).toEqual([...AGENT_SOURCES].sort());
	});

	it("CLIENT_TO_RUNNER covers every client name and a live adapter", () => {
		const adapterIds = new Set(buildAllAdapters().map((a) => a.id));
		for (const runner of Object.values(CLIENT_TO_RUNNER)) {
			expect(adapterIds.has(runner), runner).toBe(true);
		}
	});
});

describe("every adapter's native write is a harness file-write", () => {
	it("WRITE_FIXTURES lists every adapter exactly once", () => {
		expect(Object.keys(WRITE_FIXTURES).sort()).toEqual(
			buildAllAdapters().map((a) => a.id).sort(),
		);
	});

	it("parsed write tool names are isFileWrite / direct edits (or file_operation)", () => {
		for (const adapter of buildAllAdapters()) {
			const fixture = WRITE_FIXTURES[adapter.id];
			const event = adapter.parseHookInput(fixture.payload, fixture.nativeEvent);
			if (event.action.kind === "file_operation") {
				expect(["create", "edit", "write", "delete"]).toContain(event.action.operation);
				continue;
			}
			expect(event.action.kind, adapter.id).toBe("tool_call");
			if (event.action.kind !== "tool_call") continue;
			const name = event.action.tool_name;
			expect(
				isFileWrite(name) || DIRECT_FILE_EDIT_TOOLS.includes(name),
				`${adapter.id} emitted ${name}, which is not a file write`,
			).toBe(true);
			expect(["modify", "write"]).toContain(event.action.tool_class);
		}
	});

	it("isFileWrite agrees with DIRECT_FILE_EDIT_TOOLS", () => {
		for (const name of DIRECT_FILE_EDIT_TOOLS) {
			expect(isFileWrite(name), name).toBe(true);
		}
	});
});

describe("adapter detection", () => {
	it("no adapter claims a blank environment", () => {
		for (const adapter of buildAllAdapters()) {
			expect(adapter.detectFromEnv({}), adapter.id).toBe(false);
		}
	});
});

describe("detectClients shared config directories", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	it("a shared project dir without env selects at most one OpenCode client", () => {
		const cwd = mkdtempSync(join(tmpdir(), "prov-detect-"));
		dirs.push(cwd);
		mkdirSync(join(cwd, ".opencode"));
		const names = detectClients(cwd, {}).filter((c) => c.exists).map((c) => c.name);
		const open = names.filter((n) => n === "opencode" || n === "opencode2");
		expect(open).toEqual(["opencode"]);
	});
});

describe("managed plugin install paths stay in-repo for project scope", () => {
	it("fileContent adapters use a project-relative path", () => {
		for (const adapter of buildAllAdapters()) {
			const frag = adapter.renderSettingsFragment("/bin/hook", "project");
			if (!frag.fileContent) continue;
			expect(frag.path.startsWith("~/"), adapter.id).toBe(false);
			expect(frag.path.startsWith("/"), adapter.id).toBe(false);
		}
	});

	it("project-scope install does not write the user-scope plugin file", () => {
		const cwd = mkdtempSync(join(tmpdir(), "prov-install-"));
		const home = mkdtempSync(join(tmpdir(), "prov-home-"));
		const prevHome = process.env.HOME;
		const prevUser = process.env.USERPROFILE;
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		delete process.env.XDG_CONFIG_HOME;
		try {
			for (const adapter of buildAllAdapters()) {
				const projectFrag = adapter.renderSettingsFragment("/bin/hook", "project");
				if (!projectFrag.fileContent) continue;
				const result = installHooks({
					cwd,
					binaryPath: "/bin/hook",
					runners: [adapter.id],
					scope: "project",
				});
				expect(result.ok, adapter.id).toBe(true);
				expect(existsSync(join(cwd, projectFrag.path)), adapter.id).toBe(true);
				const userFrag = adapter.renderSettingsFragment("/bin/hook", "user");
				const userRel = userFrag.path.replace(/^~\//, "");
				expect(existsSync(join(home, userRel)), `${adapter.id} wrote $HOME`).toBe(false);
			}
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
			if (prevUser === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = prevUser;
			rmSync(cwd, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("ask without a native prompt is not an allow", () => {
	it("encodeDecision(ask) is not indistinguishable from allow when the runner cannot ask", () => {
		for (const adapter of buildAllAdapters()) {
			if (adapterHasAskOrPermission(adapter)) continue;
			const fixture = WRITE_FIXTURES[adapter.id];
			const event = adapter.parseHookInput(fixture.payload, fixture.nativeEvent);
			const out = adapter.encodeDecision({ decision: "ask", reason: "confirm" }, event);
			expect(looksLikeAllow(out), `${adapter.id} turned ask into allow`).toBe(false);
		}
	});
});

describe("docs, roster, and payload census", () => {
	it("architecture.md names every adapter's project hook path", () => {
		const docs = readFileSync(join(import.meta.dirname, "..", "..", "..", "docs", "architecture.md"), "utf8");
		for (const adapter of buildAllAdapters()) {
			expect(
				docs,
				`${adapter.id} path ${adapter.capabilities.project_hook_path} missing from architecture.md`,
			).toContain(adapter.capabilities.project_hook_path);
		}
	});

	it("runnerOf maps every AgentSource token in a session name", () => {
		for (const source of AGENT_SOURCES) {
			expect(runnerOf(`session-${source}-deadbeef`)).toBe(source);
		}
	});

	it("WRITE_FIXTURE top-level keys are in CONSUMED_PAYLOAD_KEYS", () => {
		for (const [id, fixture] of Object.entries(WRITE_FIXTURES)) {
			for (const key of Object.keys(fixture.payload)) {
				expect(CONSUMED_PAYLOAD_KEYS.has(key), `${id} payload key ${key}`).toBe(true);
			}
		}
	});
});
