import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addSponsorSpinnerVerb, removeSponsorSpinnerVerbs } from "./sponsor-spinner.js";

const ESC = String.fromCharCode(27);

describe("sponsor spinner verb management", () => {
	let dir: string;
	let settingsPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sponsor-spin-"));
		settingsPath = join(dir, "settings.json");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function readSettings(): Record<string, unknown> {
		return JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	}

	it("creates the file and an append-mode entry when nothing exists", () => {
		const res = addSponsorSpinnerVerb(settingsPath, "Sponsored by Alpha");
		expect(res.ok).toBe(true);
		expect(res.written).toBe("Sponsored by Alpha");
		expect(readSettings().spinnerVerbs).toEqual({
			mode: "append",
			verbs: ["Sponsored by Alpha"],
		});
	});

	it("preserves user keys, existing verbs, and an existing mode", () => {
		writeFileSync(
			settingsPath,
			JSON.stringify({
				statusLine: { type: "command", command: "x" },
				spinnerVerbs: { mode: "replace", verbs: ["Pondering"] },
			}),
		);
		const res = addSponsorSpinnerVerb(settingsPath, "Sponsored by Alpha");
		expect(res.ok).toBe(true);
		const s = readSettings();
		expect(s.statusLine).toEqual({ type: "command", command: "x" });
		expect(s.spinnerVerbs).toEqual({
			mode: "replace",
			verbs: ["Pondering", "Sponsored by Alpha"],
		});
	});

	it("is idempotent and strips control bytes from the verb", () => {
		addSponsorSpinnerVerb(settingsPath, `Spon${ESC}sored`);
		addSponsorSpinnerVerb(settingsPath, "Sponsored");
		expect(readSettings().spinnerVerbs).toEqual({ mode: "append", verbs: ["Sponsored"] });
	});

	it("refuses to touch malformed settings", () => {
		writeFileSync(settingsPath, "{not json");
		const res = addSponsorSpinnerVerb(settingsPath, "Sponsored");
		expect(res.ok).toBe(false);
		expect(readFileSync(settingsPath, "utf8")).toBe("{not json");
	});

	it("refuses to touch settings that parse but are not a JSON object", () => {
		// Valid JSON, but an array — readSettings' object/array guard must
		// reject it rather than silently treating it as an empty settings map.
		writeFileSync(settingsPath, "[]");
		const res = addSponsorSpinnerVerb(settingsPath, "Sponsored");
		expect(res).toEqual({ ok: false, reason: "settings.json not parseable — left untouched" });
		expect(readFileSync(settingsPath, "utf8")).toBe("[]");
	});

	it("reports the write failure instead of throwing when the destination is unwritable", () => {
		const target = join(dir, "does-not-exist", "settings.json");
		const res = addSponsorSpinnerVerb(target, "Sponsored by Beta");
		expect(res.ok).toBe(false);
		expect(res.reason).toContain("ENOENT");
	});

	it("removes exactly our verbs and drops an emptied append-mode entry", () => {
		writeFileSync(
			settingsPath,
			JSON.stringify({
				other: 1,
				spinnerVerbs: { mode: "append", verbs: ["Sponsored by Alpha"] },
			}),
		);
		const res = removeSponsorSpinnerVerbs(settingsPath, ["Sponsored by Alpha"]);
		expect(res.ok).toBe(true);
		const s = readSettings();
		expect(s.other).toBe(1);
		expect(s.spinnerVerbs).toBeUndefined();
	});

	it("keeps user verbs when removing ours and tolerates absent files/keys", () => {
		writeFileSync(
			settingsPath,
			JSON.stringify({
				spinnerVerbs: { mode: "replace", verbs: ["Pondering", "Sponsored by Alpha"] },
			}),
		);
		removeSponsorSpinnerVerbs(settingsPath, ["Sponsored by Alpha"]);
		expect(readSettings().spinnerVerbs).toEqual({ mode: "replace", verbs: ["Pondering"] });
		// Absent file and absent key are clean no-ops.
		expect(removeSponsorSpinnerVerbs(join(dir, "missing.json"), ["x"]).ok).toBe(true);
		writeFileSync(settingsPath, JSON.stringify({}));
		expect(removeSponsorSpinnerVerbs(settingsPath, ["x"]).ok).toBe(true);
	});

	it("reports the write failure instead of throwing when the file is read-only", () => {
		writeFileSync(
			settingsPath,
			JSON.stringify({ spinnerVerbs: { mode: "append", verbs: ["Sponsored by Alpha"] } }),
		);
		chmodSync(settingsPath, 0o444);
		try {
			const res = removeSponsorSpinnerVerbs(settingsPath, ["Sponsored by Alpha"]);
			expect(res.ok).toBe(false);
			expect(res.reason).toContain("EACCES");
		} finally {
			chmodSync(settingsPath, 0o644);
		}
	});
});
