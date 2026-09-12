// Unit tests for the Write/Edit/MultiEdit line-count + text projection that
// backs the PreToolUse per-file line-cap gate (extracted from pre-checks.ts).
// The beforeText/afterText pair feeds the comment-only-growth exemption, so
// its fidelity (first-occurrence-only, literal replacement, sequential
// MultiEdit application) is pinned here.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { projectLineCount } from "../line-count-projection.js";

describe("projectLineCount", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "line-proj-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const file = (name: string, text: string): string => {
		const path = join(dir, name);
		writeFileSync(path, text);
		return path;
	};

	it("projects a Write over an existing file (before/after + both texts)", () => {
		const path = file("w.ts", "old();\nlines();");
		const p = projectLineCount({ file_path: path, content: "a();\nb();\nc();" }, path);
		expect(p).toEqual({
			before: 2,
			after: 3,
			content: "a();\nb();\nc();",
			beforeText: "old();\nlines();",
			afterText: "a();\nb();\nc();",
		});
	});

	it("projects a Write creating a brand-new file (before 0, empty beforeText)", () => {
		const path = join(dir, "new.ts");
		const p = projectLineCount({ file_path: path, content: "x();" }, path);
		expect(p?.before).toBe(0);
		expect(p?.beforeText).toBe("");
		expect(p?.afterText).toBe("x();");
	});

	it("Edit replaces only the FIRST occurrence in afterText", () => {
		const path = file("e.ts", "dup();\ndup();\nend();");
		const p = projectLineCount({ file_path: path, old_string: "dup();", new_string: "one();\ntwo();" }, path);
		expect(p?.before).toBe(3);
		expect(p?.after).toBe(4);
		expect(p?.afterText).toBe("one();\ntwo();\ndup();\nend();");
	});

	it("does not synthesize a replacement after an earlier MultiEdit step removed its match", () => {
		const path = file("overlap.ts", "old();");
		const projection = projectLineCount({ file_path: path, edits: [
			{ old_string: "old();", new_string: "first();" },
			{ old_string: "old();", new_string: "second();" },
		] }, path);
		expect(projection?.afterText).toBe("first();");
	});

	it("Edit inserts new_string LITERALLY (no $-substitution)", () => {
		const path = file("dollar.ts", "const s = OLD;");
		const p = projectLineCount({ file_path: path, old_string: "OLD", new_string: '"$&$`$1"' }, path);
		expect(p?.afterText).toBe('const s = "$&$`$1";');
	});

	it("Edit with replace_all replaces every occurrence in afterText", () => {
		const path = file("all.ts", "dup();\ndup();\nend();");
		const p = projectLineCount(
			{ file_path: path, old_string: "dup();", new_string: "a();\nb();", replace_all: true },
			path,
		);
		expect(p?.after).toBe(5);
		expect(p?.afterText).toBe("a();\nb();\na();\nb();\nend();");
	});

	it("Edit with an absent old_string projects null (the tool itself will error)", () => {
		const path = file("miss.ts", "code();");
		expect(projectLineCount({ file_path: path, old_string: "nope", new_string: "x" }, path)).toBeNull();
	});

	it("declines an empty Edit search instead of looping or inventing an insertion", () => {
		const path = file("empty-search.ts", "code();");
		expect(projectLineCount({ file_path: path, old_string: "", new_string: "insert();", replace_all: true }, path)).toBeNull();
	});

	it("Edit on a nonexistent file projects null", () => {
		const path = join(dir, "ghost.ts");
		expect(projectLineCount({ file_path: path, old_string: "a", new_string: "b" }, path)).toBeNull();
	});

	it("MultiEdit applies edits SEQUENTIALLY in afterText (later edit sees earlier result)", () => {
		const path = file("m.ts", "start();");
		const p = projectLineCount(
			{
				file_path: path,
				edits: [
					{ old_string: "start();", new_string: "mid();" },
					{ old_string: "mid();", new_string: "final();\nextra();" },
				],
			},
			path,
		);
		expect(p?.afterText).toBe("final();\nextra();");
	});

	it("fails open (null) on unprojectable tool shapes", () => {
		const path = file("p.ts", "code();");
		expect(projectLineCount({ file_path: path, patch: "@@ -1 +1 @@" }, path)).toBeNull();
	});
});
