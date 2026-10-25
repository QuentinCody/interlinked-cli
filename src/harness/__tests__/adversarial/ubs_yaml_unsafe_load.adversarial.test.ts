// Independent adversarial review of the `ubs_yaml_unsafe_load` pre_block check
// (2026-10-21). Each negative case is realistic PyYAML / ruamel.yaml code the
// detector flagged before the refinement in
// checks/ubs-language-specific/python-yaml-load.ts (probe:
// scratch/2026-10-21-adversarial/ubs_yaml_unsafe_load.probe.mts); the
// positives pin that the refinement did not weaken the true-positive shapes.

import { describe, expect, it } from "vitest";
import { checkYamlUnsafeLoad } from "../../checks/ubs-language-specific/python-checks.js";

const PY = "src/app/config.py";

describe("ubs_yaml_unsafe_load — negative (must not fire)", () => {
	it("N1: black-formatted call with Loader=yaml.SafeLoader on its own line", () => {
		const code = [
			"import yaml",
			"",
			"def read(path):",
			"    with open(path) as f:",
			"        return yaml.load(",
			"            f,",
			"            Loader=yaml.SafeLoader,",
			"        )",
			"",
		].join("\n");
		expect(checkYamlUnsafeLoad(code, PY)).toEqual([]);
	});

	it("N2: nested-paren argument before the safe Loader kwarg", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(open(path), Loader=yaml.SafeLoader)\n", PY)).toEqual([]);
	});

	it("N3: the PyYAML README alias — `from yaml import CSafeLoader as Loader` with a SafeLoader fallback", () => {
		const code = [
			"import yaml",
			"try:",
			"    from yaml import CSafeLoader as Loader",
			"except ImportError:",
			"    from yaml import SafeLoader as Loader",
			"",
			"cfg = yaml.load(stream, Loader=Loader)",
			"",
		].join("\n");
		expect(checkYamlUnsafeLoad(code, PY)).toEqual([]);
	});

	it("N4: module-level alias bound through getattr to a Safe-class loader", () => {
		const code = [
			"import yaml",
			"Loader = getattr(yaml, 'CSafeLoader', yaml.SafeLoader)",
			"cfg = yaml.load(stream, Loader=Loader)",
			"",
		].join("\n");
		expect(checkYamlUnsafeLoad(code, PY)).toEqual([]);
	});

	it("N5: ruamel.yaml instance API — yaml = YAML(typ='safe'); yaml.load(f)", () => {
		const code = [
			"from ruamel.yaml import YAML",
			"",
			"yaml = YAML(typ='safe')",
			"",
			"def read(f):",
			"    return yaml.load(f)",
			"",
		].join("\n");
		expect(checkYamlUnsafeLoad(code, PY)).toEqual([]);
	});

	it("N6: ruamel.yaml round-trip default — yaml = YAML(); yaml.load(f)", () => {
		const code = ["from ruamel.yaml import YAML", "yaml = YAML()", "data = yaml.load(f)", ""].join("\n");
		expect(checkYamlUnsafeLoad(code, PY)).toEqual([]);
	});

	it("N7: yaml.BaseLoader — resolves no tags at all", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f, Loader=yaml.BaseLoader)\n", PY)).toEqual([]);
	});

	it("N8: ruff's own code for this finding — `# noqa: S506`", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f, Loader=yaml.FullLoader)  # noqa: S506\n", PY)).toEqual([]);
	});

	it("N9: attribute receiver self.yaml.load(f) — a ruamel instance stored on the object", () => {
		const code = [
			"from ruamel.yaml import YAML",
			"",
			"class Config:",
			"    def __init__(self):",
			"        self.yaml = YAML(typ='safe')",
			"",
			"    def read(self, f):",
			"        return self.yaml.load(f)",
			"",
		].join("\n");
		expect(checkYamlUnsafeLoad(code, PY)).toEqual([]);
	});

	it("N10: multi-line docstring that merely mentions yaml.load(", () => {
		const code = [
			"def read(f):",
			'    """Read config.',
			"",
			"    Never call yaml.load(f) here: the file is user-writable.",
			'    """',
			"    return yaml.safe_load(f)",
			"",
		].join("\n");
		expect(checkYamlUnsafeLoad(code, PY)).toEqual([]);
	});

	it("N11: multi-line load_all with a C-accelerated safe loader and a trailing comment", () => {
		const code = [
			"docs = list(",
			"    yaml.load_all(",
			"        stream,",
			"        Loader=yaml.CSafeLoader,  # C accelerated",
			"    )",
			")",
			"",
		].join("\n");
		expect(checkYamlUnsafeLoad(code, PY)).toEqual([]);
	});

	// Round 2 (resumed review): subclass / annotated bindings and Bandit's own suppression grammar.
	it("N12: custom Loader subclass of yaml.SafeLoader (the add_constructor idiom)", () => {
		const code = [
			"import yaml",
			"",
			"class StrictLoader(yaml.SafeLoader):",
			"    pass",
			"",
			"StrictLoader.add_constructor('!env', env_constructor)",
			"",
			"def read(f):",
			"    return yaml.load(f, Loader=StrictLoader)",
			"",
		].join("\n");
		expect(checkYamlUnsafeLoad(code, PY)).toEqual([]);
	});

	it("N13: subclass of yaml.CSafeLoader passed as the positional Loader", () => {
		const code = ["import yaml", "class Loader(yaml.CSafeLoader):", "    pass", "data = yaml.load(f, Loader)", ""].join("\n");
		expect(checkYamlUnsafeLoad(code, PY)).toEqual([]);
	});

	it("N14: two-hop subclass chain rooted at yaml.SafeLoader", () => {
		const code = ["import yaml", "class A(yaml.SafeLoader):", "    pass", "class B(A):", "    pass", "x = yaml.load(f, Loader=B)", ""].join("\n");
		expect(checkYamlUnsafeLoad(code, PY)).toEqual([]);
	});

	it("N15: annotated alias assignment to a Safe-class loader", () => {
		const code = ["import yaml", "Loader: type[yaml.SafeLoader] = yaml.CSafeLoader", "cfg = yaml.load(f, Loader=Loader)", ""].join("\n");
		expect(checkYamlUnsafeLoad(code, PY)).toEqual([]);
	});

	it("N16: Bandit's own suppression for this finding — `# nosec B506`", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f, Loader=yaml.FullLoader)  # nosec B506\n", PY)).toEqual([]);
	});

	it("N17: Bandit's bare `# nosec`", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f, Loader=yaml.FullLoader)  # nosec\n", PY)).toEqual([]);
	});
});

describe("ubs_yaml_unsafe_load — positive (must fire)", () => {
	it("P10: a subclass of the UNSAFE yaml.Loader still fires", () => {
		const code = ["import yaml", "class MyLoader(yaml.Loader):", "    pass", "x = yaml.load(f, Loader=MyLoader)", ""].join("\n");
		expect(checkYamlUnsafeLoad(code, PY).map((m) => m.line)).toEqual([4]);
	});

	it("P11: `# nosec` naming a different Bandit code still fires", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f, Loader=yaml.FullLoader)  # nosec B602\n", PY).map((m) => m.line)).toEqual([1]);
	});

	it("P12: a subclass mixing a safe base with an unresolvable mixin still fires", () => {
		const code = ["import yaml", "class L(yaml.SafeLoader, PythonObjectMixin):", "    pass", "x = yaml.load(f, Loader=L)", ""].join("\n");
		expect(checkYamlUnsafeLoad(code, PY).map((m) => m.line)).toEqual([4]);
	});

	it("P1: Loader=yaml.Loader (the unsafe loader) still fires", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f, Loader=yaml.Loader)\n", PY).map((m) => m.line)).toEqual([1]);
	});

	it("P2: ruamel instance with typ='unsafe' still fires", () => {
		const code = "from ruamel.yaml import YAML\nyaml = YAML(typ='unsafe')\ndata = yaml.load(f)\n";
		expect(checkYamlUnsafeLoad(code, PY).map((m) => m.line)).toEqual([3]);
	});

	it("P3: an alias bound to the unsafe Loader (`from yaml import Loader`) still fires", () => {
		expect(checkYamlUnsafeLoad("from yaml import Loader\ncfg = yaml.load(f, Loader=Loader)\n", PY).map((m) => m.line)).toEqual([2]);
	});

	it("P4: multi-line call with no Loader at all still fires", () => {
		expect(checkYamlUnsafeLoad(["cfg = yaml.load(", "    f,", ")", ""].join("\n"), PY).map((m) => m.line)).toEqual([1]);
	});

	it("P5: the legacy ruamel.yaml.load(f) module function still fires", () => {
		expect(checkYamlUnsafeLoad("import ruamel.yaml\ndata = ruamel.yaml.load(f)\n", PY).map((m) => m.line)).toEqual([2]);
	});

	it("P6: a ruamel instance in a file that ALSO imports PyYAML is ambiguous and still fires", () => {
		const code = "import yaml\nfrom ruamel.yaml import YAML\nyaml = YAML()\ndata = yaml.load(f)\n";
		expect(checkYamlUnsafeLoad(code, PY).map((m) => m.line)).toEqual([4]);
	});

	it("P7: a ruamel typ that is not a string literal still fires", () => {
		const code = "from ruamel.yaml import YAML\nyaml = YAML(typ=TYP)\ndata = yaml.load(f)\n";
		expect(checkYamlUnsafeLoad(code, PY).map((m) => m.line)).toEqual([3]);
	});

	it("P8: a Loader that comes from a helper call is undecidable and still fires", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f, Loader=get_loader())\n", PY).map((m) => m.line)).toEqual([1]);
	});

	it("P9: a mixed alias (one safe import, one unsafe reassignment) still fires", () => {
		const code = "from yaml import CSafeLoader as Loader\nLoader = yaml.FullLoader\ncfg = yaml.load(f, Loader=Loader)\n";
		expect(checkYamlUnsafeLoad(code, PY).map((m) => m.line)).toEqual([3]);
	});
});
