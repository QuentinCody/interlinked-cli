// Adversarial cases for `ubs_marshal_load` (independent FP hunt, 2026-10-21).
// Probes: scratch/2026-10-21-adversarial/ubs_marshal_load*.probe.mts

import { describe, expect, it } from "vitest";
import { checkMarshalLoad } from "../../checks/ubs-language-specific/python-checks.js";

const lines = (...l: string[]) => `${l.join("\n")}\n`;

describe("ubs_marshal_load — negative (must not fire)", () => {
	it("N1: multi-line docstring that names marshal.loads(", () => {
		const code = lines(
			"def load_cache(path):",
			'    """',
			"    We deliberately do NOT use marshal.loads(data) here: the file is user-writable.",
			'    """',
			"    return json.loads(open(path).read())",
		);
		expect(checkMarshalLoad(code, "src/cache.py")).toEqual([]);
	});

	it("N2: multi-line ''' string constant that names marshal.loads(", () => {
		const code = lines("HELP = '''", "Do not call marshal.loads(x) on network data.", "'''");
		expect(checkMarshalLoad(code, "src/help.py")).toEqual([]);
	});

	it("N3: injected serializer attribute self.marshal.loads(", () => {
		const code = lines(
			"class Transport:",
			"    def __init__(self, marshal):",
			"        self.marshal = marshal",
			"    def decode(self, payload):",
			"        return self.marshal.loads(payload)",
		);
		expect(checkMarshalLoad(code, "src/transport.py")).toEqual([]);
	});

	it("N4: nested attribute self.codecs.marshal.load(f)", () => {
		expect(checkMarshalLoad("x = self.codecs.marshal.load(f)\n", "src/a.py")).toEqual([]);
	});
});

describe("ubs_marshal_load — positive (must fire)", () => {
	it("P1: a real call after a docstring that mentions it fires on the call line", () => {
		const code = lines(
			"def f(b):",
			'    """Uses marshal.loads(b) for bytecode."""',
			"    import marshal",
			"    return marshal.loads(b)",
		);
		expect(checkMarshalLoad(code, "src/a.py").map((m) => m.line)).toEqual([4]);
	});

	it("P2: a parenthesized call (marshal.loads(b)) fires", () => {
		expect(checkMarshalLoad("v = (marshal.loads(b))\n", "src/a.py").map((m) => m.line)).toEqual([1]);
	});
});
