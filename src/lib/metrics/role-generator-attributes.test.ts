import { describe, expect, it } from "vitest";
import { attributeVerdict, readAttributeRules } from "./role-generator-attributes.js";

function rules(files: Record<string, string>) {
	return Object.entries(files).flatMap(([file, text]) => readAttributeRules(file, text).rules);
}

describe("readAttributeRules / attributeVerdict", () => {
	it("MUST-FIRE: linguist-generated set on a directory glob marks files below it, with file and line", () => {
		const set = rules({ ".gitattributes": "# header\n/frontend/src/api/models/** linguist-generated=true\n" });
		const hit = attributeVerdict(set, "frontend/src/api/models/user.ts");
		expect(hit?.role).toBe("generated");
		expect(`${hit?.rule.file}:${hit?.rule.line}`).toBe(".gitattributes:2");
	});

	it("MUST-FIRE: the bare attribute and a basename pattern at any depth", () => {
		const set = rules({ ".gitattributes": "*.gen.go linguist-generated\n" });
		expect(attributeVerdict(set, "a/b/api.gen.go")?.role).toBe("generated");
	});

	it("MUST-FIRE: linguist-vendored gives the vendor role", () => {
		const set = rules({ ".gitattributes": "third/* linguist-vendored\n" });
		expect(attributeVerdict(set, "third/x.js")?.role).toBe("vendor");
	});

	it("a nested .gitattributes is relative to its own directory", () => {
		const set = rules({ "src/bindings/.gitattributes": "constants.ts linguist-generated=true\n" });
		expect(attributeVerdict(set, "src/bindings/constants.ts")?.role).toBe("generated");
		expect(attributeVerdict(set, "src/other/constants.ts")).toBeNull();
	});

	it("MUST-NOT-FIRE: an unset or false attribute, and a later line that unsets", () => {
		expect(attributeVerdict(rules({ ".gitattributes": "*.ts -linguist-generated\n" }), "a.ts")).toBeNull();
		expect(attributeVerdict(rules({ ".gitattributes": "*.ts linguist-generated=false\n" }), "a.ts")).toBeNull();
		expect(attributeVerdict(rules({ ".gitattributes": "gen/** linguist-generated\ngen/keep.ts -linguist-generated\n" }), "gen/keep.ts")).toBeNull();
		expect(attributeVerdict(rules({ ".gitattributes": "gen/** linguist-generated\ngen/keep.ts -linguist-generated\n" }), "gen/other.ts")?.role).toBe("generated");
	});

	it("MUST-NOT-FIRE: other attributes, comments, a pattern that does not match", () => {
		const set = rules({ ".gitattributes": "# *.ts linguist-generated\n*.sh text eol=lf\n*.md linguist-documentation\ndocs/** linguist-generated\n" });
		expect(attributeVerdict(set, "x.ts")).toBeNull();
		expect(attributeVerdict(set, "src/x.sh")).toBeNull();
		expect(attributeVerdict(set, "src/docs/a.ts")).toBeNull();
	});

	it("a trailing-slash pattern is not a gitattributes pattern: skipped and counted", () => {
		const reading = readAttributeRules(".gitattributes", "gen/ linguist-generated\n");
		expect(reading.rules).toEqual([]);
		expect(reading.skipped.map((s) => s.reason)).toEqual(["trailing-slash"]);
	});
});
