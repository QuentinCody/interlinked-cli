// Companion tests for python-yaml-load.ts — the alias / ruamel / call-body
// helpers behind `ubs_yaml_unsafe_load`. The end-to-end shapes are pinned in
// src/harness/__tests__/adversarial/ubs_yaml_unsafe_load.adversarial.test.ts.

import { describe, expect, it } from "vitest";
import {
	blankPythonTripleQuoted,
	callBodyAt,
	yamlIsSafeRuamelInstance,
	yamlLoadBodyIsSafe,
	yamlReceiverAt,
} from "./python-yaml-load.js";

describe("blankPythonTripleQuoted", () => {
	it("P1: blanks a multi-line docstring interior and keeps the line count", () => {
		const src = 'def f():\n    """Doc\n    yaml.load(x)\n    """\n    return 1\n';
		const out = blankPythonTripleQuoted(src);
		expect(out.split("\n").length).toBe(src.split("\n").length);
		expect(out).not.toContain("yaml.load");
		expect(out).toContain("return 1");
	});

	it("N1: leaves code untouched when there is no triple quote", () => {
		expect(blankPythonTripleQuoted("x = yaml.load(f)\n")).toBe("x = yaml.load(f)\n");
	});
});

describe("callBodyAt", () => {
	it("P1: returns the balanced body across nested parens and lines", () => {
		const src = "yaml.load(\n    open(p),\n    Loader=L,\n)";
		expect(callBodyAt(src, src.indexOf("("))).toBe("\n    open(p),\n    Loader=L,\n");
	});

	it("N1: falls back to a bounded window when the parens never balance", () => {
		const src = `yaml.load(${"a".repeat(300)}`;
		expect(callBodyAt(src, src.indexOf("(")).length).toBe(200);
	});
});

describe("yamlReceiverAt", () => {
	it("classifies module, legacy ruamel module, and attribute receivers", () => {
		const a = "x = yaml.load(f)";
		expect(yamlReceiverAt(a, a.indexOf("yaml"))).toBe("module");
		const b = "x = ruamel.yaml.load(f)";
		expect(yamlReceiverAt(b, b.lastIndexOf("yaml"))).toBe("ruamel-module");
		const c = "x = self.yaml.load(f)";
		expect(yamlReceiverAt(c, c.indexOf("yaml"))).toBe("attribute");
	});
});

describe("yamlLoadBodyIsSafe", () => {
	it("P1: direct Safe-class names and BaseLoader are safe", () => {
		expect(yamlLoadBodyIsSafe("", "f, Loader=yaml.CSafeLoader")).toBe(true);
		expect(yamlLoadBodyIsSafe("", "f, Loader=yaml.BaseLoader")).toBe(true);
	});

	it("P2: an alias is safe only when every binding is Safe-class", () => {
		const file = "from yaml import CSafeLoader as Loader\nfrom yaml import SafeLoader as Loader\n";
		expect(yamlLoadBodyIsSafe(file, "f, Loader=Loader")).toBe(true);
		expect(yamlLoadBodyIsSafe(file, "f, Loader")).toBe(true);
	});

	it("N1: an unbound alias, a mixed alias, and a call expression stay findings", () => {
		expect(yamlLoadBodyIsSafe("from yaml import Loader\n", "f, Loader=Loader")).toBe(false);
		const mixed = "from yaml import CSafeLoader as Loader\nLoader = yaml.FullLoader\n";
		expect(yamlLoadBodyIsSafe(mixed, "f, Loader=Loader")).toBe(false);
		expect(yamlLoadBodyIsSafe("", "f, Loader=get_loader()")).toBe(false);
		expect(yamlLoadBodyIsSafe("", "f")).toBe(false);
	});
});

describe("yamlIsSafeRuamelInstance", () => {
	it("P1: YAML() and YAML(typ='safe') bound to yaml with no PyYAML import", () => {
		const a = "from ruamel.yaml import YAML\nyaml = YAML()\n";
		expect(yamlIsSafeRuamelInstance(a, a)).toBe(true);
		const b = 'from ruamel.yaml import YAML\nyaml = YAML(typ="safe", pure=True)\n';
		expect(yamlIsSafeRuamelInstance(b, b.replace('"safe"', '""'))).toBe(true);
	});

	it("N1: typ='unsafe', a non-literal typ, a PyYAML import, or no instance binding", () => {
		const unsafe = "from ruamel.yaml import YAML\nyaml = YAML(typ='unsafe')\n";
		expect(yamlIsSafeRuamelInstance(unsafe, unsafe.replace("'unsafe'", "''"))).toBe(false);
		const dyn = "from ruamel.yaml import YAML\nyaml = YAML(typ=TYP)\n";
		expect(yamlIsSafeRuamelInstance(dyn, dyn)).toBe(false);
		const both = "import yaml\nfrom ruamel.yaml import YAML\nyaml = YAML()\n";
		expect(yamlIsSafeRuamelInstance(both, both)).toBe(false);
		expect(yamlIsSafeRuamelInstance("import yaml\n", "import yaml\n")).toBe(false);
	});
});
