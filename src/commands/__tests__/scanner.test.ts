import { parseWire, wireArray, wireRecord, wireUnknown } from "../../lib/value-validation.js";
// End-to-end tests for `interlinked scanner {on,off,toggle,status}` — exercise
// the real filesystem side effects (config write + audit append) by pointing
// INTERLINKED_HOME at a fresh tmp dir per test. The command module reads/writes
// config through `getConfigDir()`, which honors that env var.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	scannerOffCommand,
	scannerOnCommand,
	scannerStatusCommand,
	scannerToggleCommand,
} from "../scanner.js";

let workDir: string;
let previousInterlinkedHome: string | undefined;

beforeEach(() => {
	workDir = join(
		tmpdir(),
		`scanner-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(workDir, { recursive: true });
	previousInterlinkedHome = process.env.INTERLINKED_HOME;
	process.env.INTERLINKED_HOME = workDir;
});

afterEach(() => {
	if (previousInterlinkedHome === undefined) {
		delete process.env.INTERLINKED_HOME;
	} else {
		process.env.INTERLINKED_HOME = previousInterlinkedHome;
	}
	rmSync(workDir, { recursive: true, force: true });
});

function readLocalRules(): Record<string, unknown> {
	const path = join(workDir, "guard-rules.local.json");
	return parseWire(JSON.parse(readFileSync(path, "utf-8")), wireRecord(wireUnknown), "test JSON value");
}

function readAuditLines(): Array<Record<string, unknown>> {
	const path = join(workDir, "content-scanner.audit.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => parseWire(JSON.parse(line), wireRecord(wireUnknown), "test JSON value"));
}

describe("interlinked scanner — enable/disable flow", () => {
	it("scanner off writes enabled:false and appends a 'disable' audit entry", async () => {
		// Starting state: rules file missing — behaves as enabled:false already.
		await scannerOffCommand({ reason: "testing", json: true });

		const rules = readLocalRules();
		expect(rules).toHaveProperty("content_scanner");
		expect(rules).toHaveProperty(["content_scanner","enabled"], false);

		const audit = readAuditLines();
		expect(audit).toHaveLength(1);
		// Going from (missing → false) is a no_change in terms of enablement.
		expect(nonNull(audit[0]).action).toBe("no_change");
		expect(nonNull(audit[0]).from).toBe(false);
		expect(nonNull(audit[0]).to).toBe(false);
		expect(nonNull(audit[0]).reason).toBe("testing");
	});

	it("scanner on after off persists enabled=true to local rules", async () => {
		await scannerOffCommand({ json: true });
		await scannerOnCommand({ reason: "re-enable for sensitive session", json: true });
		const rules = readLocalRules();
		expect(rules).toHaveProperty(["content_scanner","enabled"], true);
	});

	it("scanner on after off records both transitions in the audit log", async () => {
		await scannerOffCommand({ json: true });
		await scannerOnCommand({ reason: "re-enable for sensitive session", json: true });
		const audit = readAuditLines();
		expect(audit).toHaveLength(2);
		expect(nonNull(audit[1]).action).toBe("enable");
	});

	it("scanner on after off records the from/to transition", async () => {
		await scannerOffCommand({ json: true });
		await scannerOnCommand({ reason: "re-enable for sensitive session", json: true });
		const audit = readAuditLines();
		expect(nonNull(audit[1]).from).toBe(false);
		expect(nonNull(audit[1]).to).toBe(true);
	});

	it("scanner on after off carries the reason through to the audit entry", async () => {
		await scannerOffCommand({ json: true });
		await scannerOnCommand({ reason: "re-enable for sensitive session", json: true });
		const audit = readAuditLines();
		expect(nonNull(audit[1]).reason).toBe("re-enable for sensitive session");
	});

	it("scanner on after off stamps the actor and an ISO timestamp", async () => {
		await scannerOffCommand({ json: true });
		await scannerOnCommand({ reason: "re-enable for sensitive session", json: true });
		const audit = readAuditLines();
		const actor = parseWire(nonNull(audit[1]).actor, wireRecord(wireUnknown), "test JSON value");
		expect(actor.via).toBe("cli");
		expect(typeof actor.user).toBe("string");
		expect(nonNull(audit[1]).ts).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
	});

	it("toggle flips repeatedly and records each transition", async () => {
		// Seed to a known on state.
		await scannerOnCommand({ json: true });
		// Flip off, on, off with reasons.
		await scannerToggleCommand({ reason: "briefly off for debugging", json: true });
		await scannerToggleCommand({ json: true });
		await scannerToggleCommand({ reason: "ending session — disable", json: true });

		const rules = readLocalRules();
		expect(rules).toHaveProperty(["content_scanner","enabled"], false);

		const audit = readAuditLines();
		expect(audit.map((e) => e.action)).toEqual(["enable", "disable", "enable", "disable"]);
		expect(nonNull(audit[1]).reason).toBe("briefly off for debugging");
		expect(nonNull(audit[3]).reason).toBe("ending session — disable");
	});

	it("preserves unrelated keys in guard-rules.local.json", async () => {
		// Simulate a user who has already set other overrides.
		const path = join(workDir, "guard-rules.local.json");
		writeFileSync(
			path,
			JSON.stringify(
				{
					disabled_rules: ["some-rule"],
					output_scanning: { max_scan_bytes: 50000 },
				},
				null,
				2,
			),
		);

		await scannerOnCommand({ json: true });

		const rules = readLocalRules();
		expect(rules.disabled_rules).toEqual(["some-rule"]);
		expect(rules.output_scanning).toEqual({ max_scan_bytes: 50000 });
		expect(rules).toHaveProperty(["content_scanner","enabled"], true);
	});

	it("status prints the current enabled flag and last audit entries", async () => {
		const { vi } = await import("vitest");
		await scannerOffCommand({ reason: "demo-1", json: true });
		await scannerOnCommand({ reason: "demo-2", json: true });

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await scannerStatusCommand({ json: true });
		const logs = logSpy.mock.calls.map((call) => call.map(String).join(" "));
		logSpy.mockRestore();

		// json mode output goes through output() which console.logs a JSON string.
		const jsonPayload = logs.find((l) => l.includes("enabled"));
		expect(jsonPayload).toBeDefined();
		const parsed = parseWire(JSON.parse(nonNull(jsonPayload)), wireRecord(wireUnknown), "test JSON value");
		expect(parsed.enabled).toBe(true);
		expect(Array.isArray(parsed.last_audit)).toBe(true);
		expect((parseWire(parsed.last_audit, wireArray(wireUnknown), "test JSON value")).length).toBeGreaterThanOrEqual(2);
	});

	it("status renders review_* audit entries as 'review: <decision>', not 'off → off'", async () => {
		const { appendFileSync } = await import("node:fs");
		const { vi } = await import("vitest");
		const auditPath = join(workDir, "content-scanner.audit.jsonl");
		const ts = "2026-04-25T22:00:00.000Z";
		const actor = { user: "u", host: "h", tty: null, via: "cli" as const };
		appendFileSync(
			auditPath,
			`${JSON.stringify({ ts, action: "enable", from: false, to: true, actor, reason: "on" })}\n`,
		);
		appendFileSync(
			auditPath,
			`${JSON.stringify({ ts, action: "review_redact", actor, reason: "demo redact" })}\n`,
		);
		appendFileSync(
			auditPath,
			`${JSON.stringify({ ts, action: "review_block", actor, reason: null })}\n`,
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await scannerStatusCommand({});
		const rendered = logSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
		logSpy.mockRestore();
		// Toggle entry still shows the on/off transition.
		expect(rendered).toMatch(/off → on/);
		// Review entries must NOT render as a fake on/off transition.
		expect(rendered).not.toMatch(/review_redact[^]*off → off/);
		// Reviews should surface their decision in the rendered line.
		expect(rendered).toMatch(/review:\s*redact/i);
		expect(rendered).toMatch(/review:\s*block/i);
	});
});
