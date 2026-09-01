import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLIENT_TO_RUNNER, clientHookTargets, detectClients } from "../settings.js";

describe("detectClients", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "settings-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns one entry per registered client", () => {
		const clients = detectClients(tmp, {});
		expect(clients.map((c) => c.name)).toEqual([
			"claude",
			"copilot",
			"gemini",
			"codex",
			"cursor",
			"opencode",
			"opencode2",
			"pi",
		]);
	});

	it("marks exists=false when the config dir is missing", () => {
		const clients = detectClients(tmp, {});
		for (const c of clients) {
			expect(c.exists, `${c.name} should not exist in fresh tmpdir`).toBe(false);
		}
	});

	it("marks exists=true once the config dir is created", () => {
		mkdirSync(join(tmp, ".claude"), { recursive: true });
		const clients = detectClients(tmp, {});
		const claude = clients.find((c) => c.name === "claude");
		expect(claude?.exists).toBe(true);
	});

	it("settingsPath is absolute and under cwd", () => {
		const clients = detectClients(tmp, {});
		for (const c of clients) {
			expect(c.settingsPath.startsWith(tmp)).toBe(true);
		}
	});

	it("uses the provider-native project plugin and extension paths", () => {
		const targets = clientHookTargets(tmp);
		expect(targets.find((c) => c.name === "opencode")?.settingsPath).toBe(
			join(tmp, ".opencode", "plugins", "interlinked.ts"),
		);
		expect(targets.find((c) => c.name === "pi")?.settingsPath).toBe(
			join(tmp, ".pi", "extensions", "interlinked.js"),
		);
	});

	it("detects OpenCode and Pi from their project config roots", () => {
		mkdirSync(join(tmp, ".opencode"), { recursive: true });
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		const clients = detectClients(tmp, {});
		expect(clients.find((c) => c.name === "opencode")?.exists).toBe(true);
		expect(clients.find((c) => c.name === "pi")?.exists).toBe(true);
	});

	it.each(["opencode.json", "opencode.jsonc"])(
		"detects OpenCode from the root %s configuration",
		(file) => {
			writeFileSync(join(tmp, file), "{}\n");
			const client = detectClients(tmp, {}).find((entry) => entry.name === "opencode");
			expect(client?.exists).toBe(true);
		},
	);

	it("detects OpenCode from a non-empty OPENCODE* environment marker", () => {
		const client = detectClients(tmp, { OPENCODE_CONFIG: "/tmp/opencode.json" }).find(
			(entry) => entry.name === "opencode",
		);
		expect(client?.exists).toBe(true);
	});

	it.each([
		{ AI_AGENT: "pi" },
		{ AI_AGENT: " PI " },
		{ PI_CODING_AGENT: "1" },
	])("detects Pi from provider environment markers: $AI_AGENT$PI_CODING_AGENT", (env) => {
		const client = detectClients(tmp, env).find((entry) => entry.name === "pi");
		expect(client?.exists).toBe(true);
	});

	it("does not treat empty provider environment markers as detection", () => {
		const clients = detectClients(tmp, {
			OPENCODE_CONFIG: "",
			AI_AGENT: "claude",
			PI_CODING_AGENT: "",
		});
		expect(clients.find((entry) => entry.name === "opencode")?.exists).toBe(false);
		expect(clients.find((entry) => entry.name === "pi")?.exists).toBe(false);
	});

	it("maps the new public client ids to their normalized runner ids", () => {
		expect(CLIENT_TO_RUNNER.opencode).toBe("opencode");
		expect(CLIENT_TO_RUNNER.opencode2).toBe("opencode2");
		expect(CLIENT_TO_RUNNER.pi).toBe("pi");
	});
});
