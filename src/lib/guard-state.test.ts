import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendGuardEvent,
	clearGuardDisable,
	readGuardDisable,
	writeGuardDisable,
} from "./guard-state.js";

const LOCAL = "guard-disabled.local.json";
const TEAM = "guard-disabled.json";
const AUDIT = "guard-events.jsonl";

let root: string;
let dir: string; // the .interlinked dir under the fake repo root

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "guard-state-"));
	dir = join(root, ".interlinked");
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeRaw(name: string, contents: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), contents);
}
function writeMarker(name: string, body: Record<string, unknown>): void {
	writeRaw(name, JSON.stringify(body));
}

describe("readGuardDisable", () => {
	it("returns null when no marker is present (guard active)", () => {
		expect(readGuardDisable(dir)).toBeNull();
	});

	it("reads a personal/local marker", () => {
		writeMarker(LOCAL, { disabled: true, scope: "project", version: 1 });
		const r = readGuardDisable(dir);
		expect(r?.disabled).toBe(true);
		expect(r?.source).toBe("local");
	});

	it("reads a committed/team marker", () => {
		writeMarker(TEAM, { disabled: true, scope: "project", version: 1 });
		expect(readGuardDisable(dir)?.source).toBe("team");
	});

	it("local overrides team when both are present", () => {
		writeMarker(TEAM, { disabled: true, scope: "project", version: 1, reason: "team" });
		writeMarker(LOCAL, { disabled: true, scope: "project", version: 1, reason: "me" });
		const r = readGuardDisable(dir);
		expect(r?.source).toBe("local");
		expect(r?.reason).toBe("me");
	});

	it("ignores an expired marker (fails toward guarding)", () => {
		writeMarker(LOCAL, {
			disabled: true,
			scope: "project",
			version: 1,
			expires_at: "1970-01-01T00:00:01.000Z",
		});
		expect(readGuardDisable(dir, 2000)).toBeNull();
	});

	it("ignores a marker with a malformed expires_at (fails toward guarding)", () => {
		// A typo / garbage timestamp → Date.parse NaN. It must NOT read as a live,
		// never-expiring stand-down — that would silently disable guarding (finding
		// 2026-06, round 8). Fail toward guarding instead.
		for (const bad of ["not-a-real-date", "2026-13-45", ""]) {
			writeMarker(LOCAL, { disabled: true, scope: "project", version: 1, expires_at: bad });
			expect(readGuardDisable(dir, 1000)).toBeNull();
		}
	});

	it("honors a future expiry", () => {
		writeMarker(LOCAL, {
			disabled: true,
			scope: "project",
			version: 1,
			expires_at: new Date(10_000).toISOString(),
		});
		expect(readGuardDisable(dir, 5000)?.disabled).toBe(true);
	});

	it("ignores malformed JSON (fails toward guarding)", () => {
		writeRaw(LOCAL, "{ not json");
		expect(readGuardDisable(dir)).toBeNull();
	});

	it("ignores a marker with disabled !== true", () => {
		writeMarker(LOCAL, { disabled: false, scope: "project", version: 1 });
		expect(readGuardDisable(dir)).toBeNull();
	});

	it("ignores a marker missing the disabled flag", () => {
		writeMarker(LOCAL, { scope: "project", version: 1 });
		expect(readGuardDisable(dir)).toBeNull();
	});
});

describe("writeGuardDisable", () => {
	it("writes a personal marker by default and appends an audit event", () => {
		const rec = writeGuardDisable(dir, {
			reason: "debugging the harness itself",
			by: "qcody",
			now: "2026-06-14T00:00:00.000Z",
		});
		expect(rec.source).toBe("local");
		expect(existsSync(join(dir, LOCAL))).toBe(true);
		expect(existsSync(join(dir, TEAM))).toBe(false);
		const resolved = readGuardDisable(dir);
		expect(resolved?.reason).toBe("debugging the harness itself");
		expect(resolved?.by).toBe("qcody");
		const audit = readFileSync(join(dir, AUDIT), "utf-8");
		expect(audit).toContain('"action":"disable"');
		expect(audit).toContain('"by":"qcody"');
	});

	it("writes a committed team marker when team=true", () => {
		writeGuardDisable(dir, { by: "qcody" }, true);
		expect(existsSync(join(dir, TEAM))).toBe(true);
		expect(existsSync(join(dir, LOCAL))).toBe(false);
		expect(readGuardDisable(dir)?.source).toBe("team");
	});

	it("stamps `at` when no explicit timestamp is given", () => {
		const rec = writeGuardDisable(dir, {});
		expect(rec.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});
});

describe("clearGuardDisable", () => {
	it("clears both scopes by default and re-arms the guard", () => {
		writeGuardDisable(dir, {}, false);
		writeGuardDisable(dir, {}, true);
		const res = clearGuardDisable(dir, { by: "qcody" });
		expect([...res.cleared].sort()).toEqual(["local", "team"]);
		expect(readGuardDisable(dir)).toBeNull();
	});

	it("can clear one scope and leave the other", () => {
		writeGuardDisable(dir, {}, false);
		writeGuardDisable(dir, {}, true);
		clearGuardDisable(dir, { team: false });
		expect(readGuardDisable(dir)?.source).toBe("team");
	});

	it("is a no-op (no audit) when nothing is set", () => {
		const res = clearGuardDisable(dir);
		expect(res.cleared).toEqual([]);
		expect(existsSync(join(dir, AUDIT))).toBe(false);
	});
});

describe("appendGuardEvent", () => {
	it("appends a parseable JSONL line stamped with a ts", () => {
		appendGuardEvent(dir, {
			action: "enable",
			cleared: ["local"],
			by: "qcody",
			at: "2026-06-14T00:00:00.000Z",
		});
		const line = readFileSync(join(dir, AUDIT), "utf-8").trim();
		const obj: unknown = JSON.parse(line);
		expect(obj).toMatchObject({ action: "enable", by: "qcody", ts: expect.any(String) });
	});

	it("never throws on an unwritable target", () => {
		// A path nested *under a regular file* is unwritable on every platform:
		// ensureDir's `mkdirSync(…, { recursive: true })` hits ENOTDIR immediately
		// and is swallowed. This must NOT use a "/proc/…" path: on Linux, recursive
		// mkdir against a /proc subpath spins forever (the parent dir exists but is
		// unwritable, and the recursive walk never terminates) instead of throwing,
		// which hung the vitest worker and timed CI out for 25 min (finding 2026-06).
		// macOS has no /proc so the bug was invisible locally.
		const fileAsParent = join(root, "not-a-directory");
		writeFileSync(fileAsParent, "x");
		expect(() =>
			appendGuardEvent(join(fileAsParent, "nested"), { action: "enable", cleared: [] }),
		).not.toThrow();
	});
});
