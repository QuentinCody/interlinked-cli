import { describe, expect, it } from "vitest";
import { findUniformDirectories, measureFiles, UNIFORM_MIN_FILES } from "./role-generator-uniform.js";

const model = (name: string): string => `from typing import Any\n\nfrom attrs import define\n\n\n@define\nclass ${name}:\n    id: str\n    value: Any\n\n    def to_dict(self) -> dict:\n        return {"id": self.id, "value": self.value}\n`;
const mapOf = (files: Record<string, string>) => ({ paths: Object.keys(files), read: (path: string): string | null => files[path] ?? null });

it("produces finite descriptive measurements for an empty sample and a repeated model", () => {
	expect(measureFiles([])).toEqual({ top3: 0, sameCount: 0, identifierRatio: 1 });
	const one = measureFiles([model("Invoice")]);
	const repeated = measureFiles([model("Invoice"), model("Invoice")]);
	expect(repeated).toEqual({ top3: 1, sameCount: 1, identifierRatio: one.identifierRatio / 2 });
});

function dirOf(prefix: string, count: number, text: (n: number) => string): Record<string, string> {
	return Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}/f${i}.py`, text(i)]));
}

/** Hand-written siblings with a different shape each, so that no ancestor of the uniform directory is uniform itself. */
const varied = (): Record<string, string> => dirOf("src/app", 14, (i) => `V${i}_a = 1\nV${i}_b = 2\n`);

describe("findUniformDirectories", () => {
	it("MUST-FIRE: a directory of identical-shape single-class files is a candidate, with the numbers", () => {
		const { paths, read } = mapOf({ ...varied(), ...dirOf("src/client/models", 30, (i) => model(`Model${i}`)) });
		const found = findUniformDirectories(paths, read);
		expect(found.map((d) => d.dir)).toEqual(["src/client/models"]);
		expect(found[0]?.files).toBe(30);
		expect(found[0]?.detail).toMatch(/30 files, top-3 shape share 1\.00, same definition count 1\.00, distinct-identifier ratio 0\.\d+/);
	});

	it("reports the outermost directory only", () => {
		const { paths, read } = mapOf({ ...dirOf("pkg/api/a", 22, (i) => model(`A${i}`)), ...dirOf("pkg/api/b", 22, (i) => model(`B${i}`)), ...dirOf("pkg/hand", 30, (i) => `W${i}_a = 1\nW${i}_b = 2\n`) });
		expect(findUniformDirectories(paths, read).map((d) => d.dir)).toEqual(["pkg/api"]);
	});

	it("MUST-NOT-FIRE: fewer files than the minimum", () => {
		const { paths, read } = mapOf(dirOf("src/m", UNIFORM_MIN_FILES - 1, (i) => model(`M${i}`)));
		expect(findUniformDirectories(paths, read)).toEqual([]);
	});

	it("MUST-NOT-FIRE: hand-written files with different shapes", () => {
		const shapes = ["import os\n\ndef a():\n    return os.getcwd()\n", "class A:\n    pass\n\nclass B:\n    pass\n", "X = 1\nY = 2\n\ndef f():\n    pass\n\ndef g():\n    pass\n", "import sys\nfrom a import b\n\n@dec\ndef h():\n    pass\n"];
		const { paths, read } = mapOf(dirOf("src/util", 40, (i) => `${shapes[i % shapes.length]}# ${i}\n`));
		expect(findUniformDirectories(paths, read)).toEqual([]);
	});

	it("MUST-NOT-FIRE: the same shape but a large, varied vocabulary (hand-written components)", () => {
		const words = (i: number): string => Array.from({ length: 80 }, (_, k) => `word${i}x${k}`).join(", ");
		const { paths, read } = mapOf(dirOf("src/widgets", 30, (i) => `from x import y\n\nclass W${i}:\n    def render(self):\n        return [${words(i)}]\n`));
		expect(findUniformDirectories(paths, read)).toEqual([]);
	});

	it("MUST-NOT-FIRE: identical files that hold no definition (statements, a suite of describe calls)", () => {
		const { paths, read } = mapOf({ ...varied(), ...dirOf("src/suite", 30, () => "import x\n\ndescribe('a', () => {\n  it('b', () => {});\n});\n") });
		expect(findUniformDirectories(paths.map((p) => p.replace(/\.py$/, ".ts")), (p) => read(p.replace(/\.ts$/, ".py")))).toEqual([]);
	});

	it("MUST-NOT-FIRE: a different number of definitions in each file", () => {
		const { paths, read } = mapOf(dirOf("src/m", 30, (i) => `import os\n\n${Array.from({ length: (i % 6) + 1 }, (_, k) => `class C${k}:\n    pass\n`).join("\n")}`));
		expect(findUniformDirectories(paths, read)).toEqual([]);
	});

	it("MUST-FIRE: conditional imports and a type variable do not split the shapes (endpoint-style modules with the same functions)", () => {
		const endpoint = (i: number): string => `from typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from x import y${i % 2 === 0 ? "\nelse:\n    pass" : ""}\n\nT = 1\n\ndef a():\n    return 1\n\ndef b():\n    return 2\n\ndef c():\n    return 3\n`;
		const { paths, read } = mapOf({ ...varied(), ...dirOf("src/api", 30, endpoint) });
		expect(findUniformDirectories(paths, read).map((d) => d.dir)).toEqual(["src/api"]);
	});

	it("skips files that cannot be read and non-code files", () => {
		const files = { ...varied(), ...dirOf("src/m", 30, (i) => model(`M${i}`)) };
		const found = findUniformDirectories([...Object.keys(files), "src/m/notes.md", "src/m/gone.py"], (path) => files[path] ?? null);
		expect(found[0]?.files).toBe(31);
	});
});
