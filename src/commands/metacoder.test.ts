import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	metacoderDisableCommand,
	metacoderEnableCommand,
	metacoderStatusCommand,
	readCurrentMetacoderEnabled,
} from "./metacoder.js";

const LOCAL_RULES_FILE = "guard-rules.local.json";
const AUDIT_LOG_FILE = "metacoder.audit.jsonl";

let originalCwd: string;
let workDir: string;
function localRulesPath(): string {
	return join(workDir, ".interlinked", LOCAL_RULES_FILE);
}
function auditPath(): string {
	return join(workDir, ".interlinked", AUDIT_LOG_FILE);
}

beforeEach(() => {
	originalCwd = process.cwd();
	workDir = mkdtempSync(join(tmpdir(), "metacoder-cmd-"));
	mkdirSync(join(workDir, ".interlinked"), { recursive: true });
	process.chdir(workDir);
});
afterEach(() => {
	process.chdir(originalCwd);
	rmSync(workDir, { recursive: true, force: true });
});

describe("readCurrentMetacoderEnabled", () => {
	it("defaults to enabled when guard-rules.local.json is absent", () => {
		expect(readCurrentMetacoderEnabled(workDir)).toBe(true);
	});

	it("defaults to enabled when the metacoder field is absent", () => {
		writeFileSync(localRulesPath(), JSON.stringify({ content_scanner: { enabled: true } }));
		expect(readCurrentMetacoderEnabled(workDir)).toBe(true);
	});

	it("returns false when explicitly disabled", () => {
		writeFileSync(localRulesPath(), JSON.stringify({ metacoder: { enabled: false } }));
		expect(readCurrentMetacoderEnabled(workDir)).toBe(false);
	});

	it("returns true when explicitly enabled", () => {
		writeFileSync(
			localRulesPath(),
			JSON.stringify({ metacoder: { enabled: true, timeout_ms: 10_000 } }),
		);
		expect(readCurrentMetacoderEnabled(workDir)).toBe(true);
	});

	it("treats malformed JSON as enabled (fail-open)", () => {
		writeFileSync(localRulesPath(), "not json");
		expect(readCurrentMetacoderEnabled(workDir)).toBe(true);
	});
});

describe("metacoderDisableCommand", () => {
	it("writes enabled:false into guard-rules.local.json", async () => {
		await metacoderDisableCommand({ json: true, reason: "save quota" });
		expect(existsSync(localRulesPath())).toBe(true);
		const parsed = JSON.parse(readFileSync(localRulesPath(), "utf-8")) as {
			metacoder?: { enabled?: boolean };
		};
		expect(parsed.metacoder?.enabled).toBe(false);
	});

	it("preserves other top-level config fields when toggling", async () => {
		writeFileSync(
			localRulesPath(),
			JSON.stringify({
				content_scanner: { enabled: true },
				disabled_rules: ["some_rule"],
			}),
		);
		await metacoderDisableCommand({ json: true });
		const parsed = JSON.parse(readFileSync(localRulesPath(), "utf-8")) as {
			content_scanner?: { enabled?: boolean };
			disabled_rules?: string[];
			metacoder?: { enabled?: boolean };
		};
		expect(parsed.content_scanner?.enabled).toBe(true);
		expect(parsed.disabled_rules).toEqual(["some_rule"]);
		expect(parsed.metacoder?.enabled).toBe(false);
	});

	it("appends an audit entry", async () => {
		await metacoderDisableCommand({ json: true, reason: "burn rate too high" });
		const lines = readFileSync(auditPath(), "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0);
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0]) as { action: string; to: boolean; reason: string };
		expect(entry.action).toBe("disable");
		expect(entry.to).toBe(false);
		expect(entry.reason).toBe("burn rate too high");
	});
});

describe("metacoderEnableCommand", () => {
	it("writes enabled:true back into guard-rules.local.json", async () => {
		writeFileSync(localRulesPath(), JSON.stringify({ metacoder: { enabled: false } }));
		await metacoderEnableCommand({ json: true });
		const parsed = JSON.parse(readFileSync(localRulesPath(), "utf-8")) as {
			metacoder?: { enabled?: boolean };
		};
		expect(parsed.metacoder?.enabled).toBe(true);
	});

	it("preserves other metacoder fields when re-enabling", async () => {
		writeFileSync(
			localRulesPath(),
			JSON.stringify({ metacoder: { enabled: false, timeout_ms: 12_000 } }),
		);
		await metacoderEnableCommand({ json: true });
		const parsed = JSON.parse(readFileSync(localRulesPath(), "utf-8")) as {
			metacoder?: { enabled?: boolean; timeout_ms?: number };
		};
		expect(parsed.metacoder?.enabled).toBe(true);
		expect(parsed.metacoder?.timeout_ms).toBe(12_000);
	});

	it("records a no_change audit entry when already enabled", async () => {
		writeFileSync(localRulesPath(), JSON.stringify({ metacoder: { enabled: true } }));
		await metacoderEnableCommand({ json: true });
		const lines = readFileSync(auditPath(), "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0);
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0]) as { action: string };
		expect(entry.action).toBe("no_change");
	});
});

describe("metacoderStatusCommand", () => {
	it("does not throw when the audit log is empty", async () => {
		await expect(metacoderStatusCommand({ json: true })).resolves.toBeUndefined();
	});

	it("reads recent audit entries on status --full", async () => {
		await metacoderDisableCommand({ json: true, reason: "first" });
		await metacoderEnableCommand({ json: true, reason: "second" });
		await expect(metacoderStatusCommand({ json: true, full: true })).resolves.toBeUndefined();
		// The status command's payload is rendered via output(); we don't
		// assert on stdout here (formatter writes to stdout directly).
		// The toggling itself wrote the audit log; status reads it without
		// throwing — that's the contract under test.
		expect(existsSync(auditPath())).toBe(true);
	});
});
