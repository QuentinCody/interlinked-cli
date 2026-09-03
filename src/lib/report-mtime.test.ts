import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { reportMtimeMs } from "./report-mtime.js";

const dir = mkdtempSync(join(tmpdir(), "report-mtime-"));

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("reportMtimeMs", () => {
	it("returns the file's mtime in milliseconds", () => {
		const path = join(dir, "a.json");
		writeFileSync(path, "{}");
		utimesSync(path, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
		expect(reportMtimeMs(path)).toBe(1_600_000_000_000);
	});

	it("returns 0 for a path that does not exist", () => {
		expect(reportMtimeMs(join(dir, "missing.json"))).toBe(0);
	});

	it("sorts an older file before a newer one", () => {
		const older = join(dir, "older.json");
		const newer = join(dir, "newer.json");
		writeFileSync(older, "{}");
		writeFileSync(newer, "{}");
		utimesSync(older, new Date(1_000), new Date(1_000));
		utimesSync(newer, new Date(2_000), new Date(2_000));
		const sorted = [newer, older].sort((a, b) => reportMtimeMs(a) - reportMtimeMs(b));
		expect(sorted).toEqual([older, newer]);
	});

	it("sorts an unreadable path oldest", () => {
		const present = join(dir, "present.json");
		writeFileSync(present, "{}");
		utimesSync(present, new Date(5_000), new Date(5_000));
		const missing = join(dir, "nope.json");
		const sorted = [present, missing].sort((a, b) => reportMtimeMs(a) - reportMtimeMs(b));
		expect(sorted).toEqual([missing, present]);
	});
});
