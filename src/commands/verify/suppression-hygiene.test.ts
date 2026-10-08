// Stale-suppression report (antithesis intake backlog #16): suppressions that
// match nothing hide the next real finding at that spot. Report only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanInlineSuppressions } from "../../harness/suppressions.js";
import { directiveLineFor, staleFileSuppressions, unusedInlineDirectives } from "./suppression-hygiene.js";

let root: string;
const entry = { reason: "a reason long enough to pass", by: "qcody", at: "2026-10-05" };
function writeSuppressions(body: Record<string, Record<string, typeof entry>>): string {
	const dir = join(root, ".interlinked");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "verify-suppressions.json"), JSON.stringify(body));
	return dir;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "supp-hygiene-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("staleFileSuppressions — positive (must fire)", () => {
	it("P1: an entry for a file that no longer exists matches nothing", () => {
		const dir = writeSuppressions({ "src/gone.ts": { empty_catch: entry, magic_number: entry } });
		expect(staleFileSuppressions(dir)).toEqual([
			{
				name: "stale_file_suppression",
				file: "src/gone.ts",
				message: "verify-suppressions.json suppresses empty_catch, magic_number for a file that does not exist; the entry matches nothing",
			},
		]);
	});
});

describe("staleFileSuppressions — negative (must not fire)", () => {
	it("N1: an entry for an existing file is not reported", () => {
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src/here.ts"), "export {};\n");
		expect(staleFileSuppressions(writeSuppressions({ "src/here.ts": { empty_catch: entry } }))).toEqual([]);
	});

	it("N2: a glob key is not judged (matching a glob needs a tree walk)", () => {
		expect(staleFileSuppressions(writeSuppressions({ "src/**/*.gen.ts": { empty_catch: entry } }))).toEqual([]);
	});

	it("N3: no suppression file reports nothing", () => {
		expect(staleFileSuppressions(join(root, ".interlinked"))).toEqual([]);
	});
});

describe("inline directives — positive (must fire)", () => {
	const source = "// interlinked-ignore: empty_catch — reason\ntry { f(); } catch {}\n";

	it("P1: the directive's target line is found for a finding on, above or below it", () => {
		const inline = scanInlineSuppressions(source);
		expect(directiveLineFor("empty_catch", 2, inline)).toBe(2);
		expect(directiveLineFor("empty_catch", 3, inline)).toBe(2);
		expect(directiveLineFor("empty_catch", 1, inline)).toBe(2);
	});

	it("P2: a directive that suppressed nothing is reported at its target line", () => {
		const [finding] = unusedInlineDirectives("src/a.ts", scanInlineSuppressions(source), new Set());
		expect(finding).toMatchObject({ check: "unused_inline_suppression", file: "src/a.ts", line: 2 });
		expect(finding?.message).toContain("`interlinked-ignore: empty_catch` suppressed nothing in this verify run");
	});
});

describe("inline directives — negative (must not fire)", () => {
	const source = "// interlinked-ignore: empty_catch, magic_number — reason\ntry { f(); } catch {}\n";

	it("N1: a finding two lines away, or of another check, does not use the directive", () => {
		const inline = scanInlineSuppressions(source);
		expect(directiveLineFor("empty_catch", 4, inline)).toBeNull();
		expect(directiveLineFor("silent_catch", 2, inline)).toBeNull();
	});

	it("N2: a used check is not reported; the unused check on the same directive still is", () => {
		const used = new Set([`2\0empty_catch`]);
		const findings = unusedInlineDirectives("src/a.ts", scanInlineSuppressions(source), used);
		expect(findings.map((f) => f.message.match(/ignore: (\w+)/)?.[1])).toEqual(["magic_number"]);
	});
});
