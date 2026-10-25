// Smoke tests for the Python-language UBS detectors. The exhaustive
// red/green suites for each check live in src/harness/__tests__/ubs-*.test.ts
// and exercise these via the ubs-language-specific.ts barrel; this colocated
// file covers the module surface directly and satisfies the colocation gate.

import { describe, expect, it } from "vitest";
import {
	checkMarshalLoad,
	checkOsSystemTainted,
	checkPickleUntrustedLoad,
	checkPickleWrapperLoad,
	checkPyMutableDefaultArg,
	checkPyNoneEquality,
	checkRegexInLoopNoCompile,
	checkShelveOpen,
	checkSubprocessShellTrue,
	checkTempfileMktempRace,
	checkTorchUnsafeLoad,
	checkXmlExternalEntity,
	checkYamlUnsafeLoad,
} from "./python-checks.js";
import { MATCH_LIMIT } from "./_shared.js";

/** N copies of one line, each independently triggering a detector — pins the
 *  MATCH_LIMIT cap exactly (kills both the "never breaks" and the off-by-one
 *  `> cap` vs `>= cap` mutants with a single assertion). */
function repeat(line: string, n: number): string {
	return Array.from({ length: n }, () => line).join("\n");
}

describe("ubs-language-specific/python-checks", () => {
	it("checkSubprocessShellTrue flags shell=True", () => {
		const code = "subprocess.run(cmd, shell=True)";
		expect(checkSubprocessShellTrue(code, "a.py").length).toBeGreaterThan(0);
		expect(checkSubprocessShellTrue(code, "a.ts")).toEqual([]);
	});

	it("checkPyNoneEquality flags `x == None`", () => {
		expect(checkPyNoneEquality("if x == None:", "a.py").length).toBeGreaterThan(0);
		expect(checkPyNoneEquality("if x is None:", "a.py")).toEqual([]);
	});

	it("checkPyMutableDefaultArg flags `def f(x=[])`", () => {
		expect(checkPyMutableDefaultArg("def f(x=[]):", "a.py").length).toBeGreaterThan(0);
		expect(checkPyMutableDefaultArg("def f(x=None):", "a.py")).toEqual([]);
	});

	it("checkTempfileMktempRace flags tempfile.mktemp()", () => {
		expect(checkTempfileMktempRace("p = tempfile.mktemp()", "a.py").length).toBeGreaterThan(0);
		expect(checkTempfileMktempRace("p = tempfile.mkstemp()", "a.py")).toEqual([]);
	});

	it("checkPickleUntrustedLoad flags pickle.load", () => {
		expect(checkPickleUntrustedLoad("x = pickle.load(f)", "a.py").length).toBeGreaterThan(0);
		expect(checkPickleUntrustedLoad("x = json.load(f)", "a.py")).toEqual([]);
	});

	it("checkXmlExternalEntity flags an etree import paired with a parse call", () => {
		const code = "import xml.etree.ElementTree as ET\nroot = ET.parse(src)";
		expect(checkXmlExternalEntity(code, "a.py").length).toBeGreaterThan(0);
	});

	it("checkOsSystemTainted flags os.system with an identifier arg", () => {
		expect(checkOsSystemTainted("os.system(cmd)", "a.py").length).toBeGreaterThan(0);
	});

	it("checkRegexInLoopNoCompile flags re.match inside a loop", () => {
		const code = "for line in lines:\n    re.match(pat, line)";
		expect(checkRegexInLoopNoCompile(code, "a.py").length).toBeGreaterThan(0);
	});

	it("checkMarshalLoad flags marshal.loads", () => {
		expect(checkMarshalLoad("obj = marshal.loads(buf)", "a.py").length).toBeGreaterThan(0);
		expect(checkMarshalLoad("obj = json.loads(buf)", "a.py")).toEqual([]);
	});

	it("checkShelveOpen flags shelve.open", () => {
		expect(checkShelveOpen("d = shelve.open(p)", "a.py").length).toBeGreaterThan(0);
		expect(checkShelveOpen("d = sqlite3.connect(p)", "a.py")).toEqual([]);
	});

	it("checkYamlUnsafeLoad flags bare yaml.load and skips yaml.safe_load", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f)", "a.py").length).toBeGreaterThan(0);
		expect(checkYamlUnsafeLoad("cfg = yaml.safe_load(f)", "a.py")).toEqual([]);
	});

	it("checkTorchUnsafeLoad flags torch.load without weights_only=True", () => {
		expect(checkTorchUnsafeLoad("m = torch.load(p)", "a.py").length).toBeGreaterThan(0);
		expect(checkTorchUnsafeLoad("m = torch.load(p, weights_only=True)", "a.py")).toEqual([]);
	});

	it("checkPickleWrapperLoad flags joblib.load and skips safe np.load", () => {
		expect(checkPickleWrapperLoad("m = joblib.load(p)", "a.py").length).toBeGreaterThan(0);
		expect(checkPickleWrapperLoad("arr = np.load(p)", "a.py")).toEqual([]);
	});
});

// ===========================================================================
// Survivor-elimination precision suites — one describe per detector.
// Each block follows the campaign's mechanical recipe (docs/plans/15-survivor-
// elimination-campaign.md): guard positive/negative pairs, regex whitespace
// precision, MATCH_LIMIT boundary with exact line/text, and noqa checkId
// specificity where the check id is Bandit-mapped. Exact `toEqual` shape
// assertions are used throughout instead of bare length checks — a loose
// length check cannot distinguish "right match, wrong line" from "right
// match, right line", which is exactly the class of mutant these are built
// to kill.
// ===========================================================================

describe("checkSubprocessShellTrue — precision", () => {
	it("MUST-FIRE: fires on a .pyi file (compound ext guard, second branch)", () => {
		const code = "subprocess.run(cmd, shell=True)";
		expect(checkSubprocessShellTrue(code, "stub.pyi").length).toBeGreaterThan(0);
	});

	it("MUST-NOT-FIRE: skips a vendored path even with shell=True present", () => {
		const code = "subprocess.run(cmd, shell=True)";
		expect(checkSubprocessShellTrue(code, "vendor/pkg/run.py")).toEqual([]);
	});

	it("MUST-NOT-FIRE: returns a genuinely empty array (not a stub entry) when nothing matches", () => {
		expect(checkSubprocessShellTrue("import os\nos.getcwd()\n", "src/a.py")).toEqual([]);
	});

	it("MUST-NOT-FIRE: shell=False is the safe form", () => {
		expect(checkSubprocessShellTrue("subprocess.run(cmd, shell=False)", "src/a.py")).toEqual([]);
	});

	it("regex tolerates a space before the call paren and around shell=True's `=`", () => {
		const code = "subprocess.run (cmd, shell = True)";
		expect(checkSubprocessShellTrue(code, "src/a.py").length).toBeGreaterThan(0);
	});

	it("anchors the reported line at `shell`, not at the end of the matched text", () => {
		const code = ["subprocess.run(x,", "shell", "=", "True)"].join("\n");
		expect(checkSubprocessShellTrue(code, "src/a.py")).toEqual([{ line: 2, text: "shell" }]);
	});

	it("caps at 10 matches and reports exact line/text for each (boundary)", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `subprocess.run(cmd${i}, shell=True)`);
		const code = lines.join("\n");
		const matches = checkSubprocessShellTrue(code, "src/many.py");
		expect(matches).toEqual(lines.slice(0, 10).map((text, i) => ({ line: i + 1, text })));
	});

	it("noqa: S602 suppresses; an unrelated bandit code does not (checkId specificity)", () => {
		expect(
			checkSubprocessShellTrue("subprocess.run(cmd, shell=True)  # noqa: S602", "src/a.py"),
		).toEqual([]);
		expect(
			checkSubprocessShellTrue("subprocess.run(cmd, shell=True)  # noqa: S301", "src/a.py").length,
		).toBeGreaterThan(0);
	});
});

describe("checkPyNoneEquality — precision", () => {
	it("MUST-FIRE: fires on a .pyi file (compound ext guard, second branch)", () => {
		expect(checkPyNoneEquality("if x == None: pass", "stub.pyi").length).toBeGreaterThan(0);
	});

	it("MUST-NOT-FIRE: wrong extension returns a genuinely empty array", () => {
		expect(checkPyNoneEquality("if x == None: pass", "src/a.ts")).toEqual([]);
	});

	it("regex requires a real multi-char identifier run, not just any single word char", () => {
		expect(checkPyNoneEquality("if config_value == None: pass", "src/a.py").length).toBeGreaterThan(
			0,
		);
	});

	it("regex matches with zero surrounding whitespace around the operator (non-Yoda)", () => {
		expect(checkPyNoneEquality("if value==None: pass", "src/a.py").length).toBeGreaterThan(0);
	});

	it("regex matches Yoda form with zero surrounding whitespace and a multi-char identifier", () => {
		expect(checkPyNoneEquality("if None==long_value: pass", "src/a.py").length).toBeGreaterThan(0);
	});

	it("regex matches Yoda form with normal spacing (kills \\S* substitution on Yoda side)", () => {
		expect(checkPyNoneEquality("if None == long_value: pass", "src/a.py").length).toBeGreaterThan(
			0,
		);
	});

	it("caps at 10 matches and reports exact line/text for each (boundary)", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `check${i} == None`);
		const code = lines.join("\n");
		const matches = checkPyNoneEquality(code, "src/many.py");
		expect(matches).toEqual(lines.slice(0, 10).map((text, i) => ({ line: i + 1, text })));
	});
});

describe("checkPyMutableDefaultArg — precision", () => {
	it("MUST-NOT-FIRE: wrong extension returns a genuinely empty array", () => {
		expect(checkPyMutableDefaultArg("def f(x=[]):\n    return x\n", "src/a.ts")).toEqual([]);
	});

	it("regex tolerates multiple spaces after `def` and a multi-char function name", () => {
		expect(
			checkPyMutableDefaultArg("def  process(x=[]):\n    return x\n", "src/a.py").length,
		).toBeGreaterThan(0);
	});

	it("regex tolerates a space before the parameter list's opening paren", () => {
		expect(
			checkPyMutableDefaultArg("def process (x=[]):\n    return x\n", "src/a.py").length,
		).toBeGreaterThan(0);
	});

	it("regex tolerates a multi-char parameter prefix before the mutable default", () => {
		expect(
			checkPyMutableDefaultArg("def process(a, b = []):\n    return b\n", "src/a.py").length,
		).toBeGreaterThan(0);
	});

	it("regex tolerates internal whitespace inside an empty list default", () => {
		expect(
			checkPyMutableDefaultArg("def process(x=[  ]):\n    return x\n", "src/a.py").length,
		).toBeGreaterThan(0);
	});

	it("regex tolerates internal whitespace inside an empty dict default", () => {
		expect(
			checkPyMutableDefaultArg("def process(x={  }):\n    return x\n", "src/a.py").length,
		).toBeGreaterThan(0);
	});

	it("caps at 10 matches and reports exact line/text for each (boundary)", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `def f${i}(x=[]):`);
		const code = lines.join("\n");
		const matches = checkPyMutableDefaultArg(code, "src/many.py");
		expect(matches).toEqual(lines.slice(0, 10).map((text, i) => ({ line: i + 1, text })));
	});
});

describe("checkTempfileMktempRace — precision", () => {
	it("MUST-FIRE: fires on a .pyi file", () => {
		expect(checkTempfileMktempRace("p = tempfile.mktemp()", "stub.pyi").length).toBeGreaterThan(0);
	});

	it("MUST-NOT-FIRE: wrong extension returns a genuinely empty array", () => {
		expect(checkTempfileMktempRace("p = tempfile.mktemp()", "src/a.ts")).toEqual([]);
	});

	it("MUST-NOT-FIRE: skips test files even with a real mktemp() call", () => {
		expect(checkTempfileMktempRace("p = tempfile.mktemp()", "tests/test_foo.py")).toEqual([]);
	});

	it("regex tolerates a space before the call's opening paren", () => {
		expect(checkTempfileMktempRace("p = tempfile.mktemp ()", "src/a.py").length).toBeGreaterThan(0);
	});

	it("caps at MATCH_LIMIT matches and reports exact line/text for each (boundary)", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `p${i} = tempfile.mktemp()`);
		const code = lines.join("\n");
		const matches = checkTempfileMktempRace(code, "src/many.py");
		expect(matches).toEqual(lines.slice(0, 10).map((text, i) => ({ line: i + 1, text })));
	});
});

describe("checkPickleUntrustedLoad — precision", () => {
	it("MUST-NOT-FIRE: wrong extension returns a genuinely empty array", () => {
		expect(checkPickleUntrustedLoad("pickle.load(f)", "src/a.ts")).toEqual([]);
	});

	it("MUST-NOT-FIRE: skips test files", () => {
		expect(checkPickleUntrustedLoad("pickle.load(f)", "tests/test_foo.py")).toEqual([]);
	});

	it("MUST-NOT-FIRE: skips vendored paths", () => {
		expect(checkPickleUntrustedLoad("pickle.load(f)", "vendor/pkg/cache.py")).toEqual([]);
	});

	it("regex tolerates a space before the pickle.load(s) paren", () => {
		expect(checkPickleUntrustedLoad("obj = pickle.load (f)", "src/a.py").length).toBeGreaterThan(0);
	});

	it("regex fires on jsonpickle.decode with zero whitespace before the paren", () => {
		expect(
			checkPickleUntrustedLoad("obj = jsonpickle.decode(payload)", "src/a.py").length,
		).toBeGreaterThan(0);
	});

	it("regex tolerates a space before the jsonpickle.decode paren", () => {
		expect(
			checkPickleUntrustedLoad("obj = jsonpickle.decode (payload)", "src/a.py").length,
		).toBeGreaterThan(0);
	});

	it("noqa: S301 suppresses; an unrelated bandit code does not (checkId specificity)", () => {
		expect(checkPickleUntrustedLoad("obj = pickle.loads(buf)  # noqa: S301", "src/a.py")).toEqual(
			[],
		);
		expect(
			checkPickleUntrustedLoad("obj = pickle.loads(buf)  # noqa: S307", "src/a.py").length,
		).toBeGreaterThan(0);
	});

	it("caps at MATCH_LIMIT matches and reports exact line/text for each (boundary)", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `x${i} = pickle.load(f)`);
		const code = lines.join("\n");
		const matches = checkPickleUntrustedLoad(code, "src/many.py");
		expect(matches).toEqual(lines.slice(0, 10).map((text, i) => ({ line: i + 1, text })));
	});
});

describe("checkXmlExternalEntity — precision", () => {
	it("MUST-NOT-FIRE: wrong extension returns a genuinely empty array", () => {
		const code = "import xml.etree.ElementTree as ET\ntree = ET.parse(path)\n";
		expect(checkXmlExternalEntity(code, "src/a.ts")).toEqual([]);
	});

	it("MUST-NOT-FIRE: skips test files", () => {
		const code = "import xml.etree.ElementTree as ET\ntree = ET.parse(path)\n";
		expect(checkXmlExternalEntity(code, "tests/test_a.py")).toEqual([]);
	});

	it("MUST-NOT-FIRE: skips vendored paths", () => {
		const code = "import xml.etree.ElementTree as ET\ntree = ET.parse(path)\n";
		expect(checkXmlExternalEntity(code, "vendor/pkg/a.py")).toEqual([]);
	});

	it("flags the import line itself, not an unrelated parse-call line (negation precision)", () => {
		const code = "import xml.etree.ElementTree as ET\nroot = ET.parse(src)";
		expect(checkXmlExternalEntity(code, "src/a.py")).toEqual([
			{ line: 1, text: "import xml.etree.ElementTree as ET" },
		]);
	});

	it("noqa: S314 suppresses; an unrelated bandit code does not (checkId specificity)", () => {
		const suppressed = "import xml.etree.ElementTree as ET  # noqa: S314\ntree = ET.parse(path)\n";
		expect(checkXmlExternalEntity(suppressed, "src/a.py")).toEqual([]);
		const notSuppressed = "import xml.etree.ElementTree as ET  # noqa: S301\ntree = ET.parse(path)\n";
		expect(checkXmlExternalEntity(notSuppressed, "src/a.py").length).toBeGreaterThan(0);
	});

	// --- XML_PARSE_CALL_RE (module-level gate regex) precision ---

	it("gate regex matches with zero extra dotted segments (xml.etree.parse direct)", () => {
		const code = "import xml.etree\ntree = xml.etree.parse(path)\n";
		expect(checkXmlExternalEntity(code, "src/a.py").length).toBeGreaterThan(0);
	});

	it("gate regex matches a multi-char dotted segment (xml.etree.ElementTree.parse)", () => {
		const code = "import xml.etree.ElementTree\ntree = xml.etree.ElementTree.parse(path)\n";
		expect(checkXmlExternalEntity(code, "src/a.py").length).toBeGreaterThan(0);
	});

	it("gate regex tolerates a space before the final dot (ET .parse)", () => {
		const code = "import xml.etree.ElementTree as ET\ntree = ET .parse(path)\n";
		expect(checkXmlExternalEntity(code, "src/a.py").length).toBeGreaterThan(0);
	});

	it("gate regex tolerates a space after the final dot (ET. parse)", () => {
		const code = "import xml.etree.ElementTree as ET\ntree = ET. parse(path)\n";
		expect(checkXmlExternalEntity(code, "src/a.py").length).toBeGreaterThan(0);
	});

	it("gate regex tolerates a space before the call's opening paren (ET.parse (path))", () => {
		const code = "import xml.etree.ElementTree as ET\ntree = ET.parse (path)\n";
		expect(checkXmlExternalEntity(code, "src/a.py").length).toBeGreaterThan(0);
	});

	it("gate regex recognizes a bare XMLPullParser() call with zero whitespace", () => {
		const code = "from xml.etree.ElementTree import XMLPullParser\nparser = XMLPullParser()\n";
		expect(checkXmlExternalEntity(code, "src/a.py").length).toBeGreaterThan(0);
	});

	it("gate regex tolerates a space before the bare XMLPullParser paren", () => {
		const code = "from xml.etree.ElementTree import XMLPullParser\nparser = XMLPullParser ()\n";
		expect(checkXmlExternalEntity(code, "src/a.py").length).toBeGreaterThan(0);
	});

	// --- import-line regex (L223-ish) whitespace precision ---

	it("import-regex tolerates multiple spaces after `import` (first branch)", () => {
		const code = "import  xml.etree.ElementTree as ET\ntree = ET.parse(x)\n";
		expect(checkXmlExternalEntity(code, "src/a.py").map((m) => m.line)).toEqual([1]);
	});

	it("import-regex fires on `from xml.dom import` with a single space (second branch)", () => {
		const code = [
			"import xml.etree.ElementTree as ET",
			"from xml.dom import minidom",
			"tree = ET.parse(path)",
		].join("\n");
		expect(checkXmlExternalEntity(code, "src/a.py").map((m) => m.line)).toEqual([1, 2]);
	});

	it("import-regex tolerates multiple spaces after `from` (xml.dom branch)", () => {
		const code = [
			"import xml.etree.ElementTree as ET",
			"from  xml.dom import minidom",
			"tree = ET.parse(path)",
		].join("\n");
		expect(checkXmlExternalEntity(code, "src/a.py").map((m) => m.line)).toEqual([1, 2]);
	});

	it("import-regex fires on `from lxml import etree` with a single space (third branch)", () => {
		const code = [
			"import xml.etree.ElementTree as ET",
			"from lxml import etree",
			"tree = ET.parse(path)",
		].join("\n");
		expect(checkXmlExternalEntity(code, "src/a.py").map((m) => m.line)).toEqual([1, 2]);
	});

	it("import-regex tolerates multiple spaces after `from` (lxml branch)", () => {
		const code = [
			"import xml.etree.ElementTree as ET",
			"from  lxml import etree",
			"tree = ET.parse(path)",
		].join("\n");
		expect(checkXmlExternalEntity(code, "src/a.py").map((m) => m.line)).toEqual([1, 2]);
	});

	it("caps at MATCH_LIMIT matches and reports exact line/text for each (boundary)", () => {
		const importLines = Array.from(
			{ length: 11 },
			(_, i) => `import xml.etree.ElementTree as ET${i}`,
		);
		const code = [...importLines, "z = ET.parse(path)"].join("\n");
		const matches = checkXmlExternalEntity(code, "src/many.py");
		expect(matches).toEqual(importLines.slice(0, 10).map((text, i) => ({ line: i + 1, text })));
	});
});

describe("checkOsSystemTainted — precision", () => {
	it("MUST-NOT-FIRE: wrong extension returns a genuinely empty array", () => {
		expect(checkOsSystemTainted("os.system(cmd)", "src/a.ts")).toEqual([]);
	});

	it("MUST-NOT-FIRE: skips test files", () => {
		expect(checkOsSystemTainted("os.system(cmd)", "tests/test_a.py")).toEqual([]);
	});

	it("MUST-NOT-FIRE: skips vendored paths", () => {
		expect(checkOsSystemTainted("os.system(cmd)", "vendor/pkg/a.py")).toEqual([]);
	});

	it("regex tolerates a space before the call's opening paren", () => {
		expect(checkOsSystemTainted("os.system (cmd)", "src/a.py").length).toBeGreaterThan(0);
	});

	it("regex tolerates a space after the opening paren, before the identifier", () => {
		expect(checkOsSystemTainted("os.system( cmd)", "src/a.py").length).toBeGreaterThan(0);
	});

	it("caps at MATCH_LIMIT matches and reports exact line/text for each (boundary)", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `os.system(cmd${i})`);
		const code = lines.join("\n");
		const matches = checkOsSystemTainted(code, "src/many.py");
		expect(matches).toEqual(lines.slice(0, 10).map((text, i) => ({ line: i + 1, text })));
	});
});

describe("checkRegexInLoopNoCompile — precision", () => {
	it("MUST-NOT-FIRE: wrong extension returns a genuinely empty array", () => {
		expect(checkRegexInLoopNoCompile("for x in y:\n    re.match(p, x)\n", "src/a.ts")).toEqual([]);
	});

	it("MUST-NOT-FIRE: skips test files", () => {
		expect(
			checkRegexInLoopNoCompile("for x in y:\n    re.match(p, x)\n", "tests/test_a.py"),
		).toEqual([]);
	});

	it("MUST-NOT-FIRE: a plain line with no loop and no regex call", () => {
		expect(checkRegexInLoopNoCompile("x = 1\ny = 2\n", "src/a.py")).toEqual([]);
	});

	it("MUST-NOT-FIRE: re.match outside any loop is not flagged", () => {
		expect(
			checkRegexInLoopNoCompile("import re\nresult = re.match(pattern, x)\n", "src/a.py"),
		).toEqual([]);
	});

	it("MUST-NOT-FIRE: re.match after the loop has dedented back out is not flagged", () => {
		const code = "for x in items:\n    pass\nre.match(p, x)\n";
		expect(checkRegexInLoopNoCompile(code, "src/a.py")).toEqual([]);
	});

	it("a blank line inside a loop does not end the loop (indent === -1 guard)", () => {
		const code = "for x in items:\n\n    re.match(p, x)\n";
		expect(checkRegexInLoopNoCompile(code, "src/a.py")).toEqual([
			{ line: 3, text: "re.match(p, x)" },
		]);
	});

	it("`for`/`while` detection requires the keyword at the true start of the line", () => {
		// "for" appears later in the line, not at (optional-indent-then-)start —
		// must NOT be treated as a loop opener.
		const code = "x = 1  for show\n    re.match(pat, x)\n";
		expect(checkRegexInLoopNoCompile(code, "src/a.py")).toEqual([]);
	});

	it("`for` detection tolerates genuine leading indentation", () => {
		const code = "def f():\n    for x in items:\n        re.match(pattern, x)\n";
		expect(checkRegexInLoopNoCompile(code, "src/a.py")).toEqual([
			{ line: 3, text: "re.match(pattern, x)" },
		]);
	});

	it("regex-call detection tolerates a space before the call's opening paren", () => {
		const code = "for x in items:\n    re.match (pat, x)\n";
		expect(checkRegexInLoopNoCompile(code, "src/a.py")).toEqual([
			{ line: 2, text: "re.match (pat, x)" },
		]);
	});

	it("caps at MATCH_LIMIT matches and reports exact line/text for each (boundary)", () => {
		const body = Array.from({ length: 11 }, (_, i) => `    re.match(p${i}, x)`);
		const code = ["for x in items:", ...body].join("\n");
		const matches = checkRegexInLoopNoCompile(code, "src/many.py");
		expect(matches).toEqual(body.slice(0, 10).map((text, i) => ({ line: i + 2, text: text.trim() })));
	});
});

describe("checkMarshalLoad — precision", () => {
	it("MUST-NOT-FIRE: wrong extension returns a genuinely empty array", () => {
		expect(checkMarshalLoad("marshal.loads(buf)", "src/a.ts")).toEqual([]);
	});

	it("MUST-NOT-FIRE: skips test files", () => {
		expect(checkMarshalLoad("marshal.loads(buf)", "tests/test_a.py")).toEqual([]);
	});

	it("MUST-NOT-FIRE: skips vendored paths", () => {
		expect(checkMarshalLoad("marshal.loads(buf)", "vendor/pkg/a.py")).toEqual([]);
	});

	it("regex fires on the singular `marshal.load(` form (optional `s` precision)", () => {
		expect(checkMarshalLoad("obj = marshal.load(f)", "src/a.py").length).toBeGreaterThan(0);
	});

	it("regex tolerates a space before the call's opening paren", () => {
		expect(checkMarshalLoad("obj = marshal.loads (buf)", "src/a.py").length).toBeGreaterThan(0);
	});

	it("caps at MATCH_LIMIT matches and reports exact line/text for each (boundary)", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `x${i} = marshal.loads(buf)`);
		const code = lines.join("\n");
		const matches = checkMarshalLoad(code, "src/many.py");
		expect(matches).toEqual(lines.slice(0, 10).map((text, i) => ({ line: i + 1, text })));
	});

	it("N1: bare `# noqa` on the call line suppresses a real marshal.loads call", () => {
		expect(checkMarshalLoad("obj = marshal.loads(buf)  # noqa", "src/a.py")).toEqual([]);
	});

	it("N2: marshal.dumps (the write direction) does not match the load(s)-only regex", () => {
		expect(checkMarshalLoad("buf = marshal.dumps(obj)", "src/a.py")).toEqual([]);
	});

	it("N3: a comment merely mentioning marshal.load is stripped before matching", () => {
		expect(checkMarshalLoad("# uses marshal.load(f) internally\nx = 1", "src/a.py")).toEqual([]);
	});
});

describe("checkShelveOpen — precision", () => {
	it("MUST-NOT-FIRE: wrong extension returns a genuinely empty array", () => {
		expect(checkShelveOpen("shelve.open(p)", "src/a.ts")).toEqual([]);
	});

	it("MUST-NOT-FIRE: skips test files", () => {
		expect(checkShelveOpen("shelve.open(p)", "tests/test_a.py")).toEqual([]);
	});

	it("MUST-NOT-FIRE: skips vendored paths", () => {
		expect(checkShelveOpen("shelve.open(p)", "vendor/pkg/a.py")).toEqual([]);
	});

	it("regex tolerates a space before the call's opening paren", () => {
		expect(checkShelveOpen("d = shelve.open (p)", "src/a.py").length).toBeGreaterThan(0);
	});

	it("caps at MATCH_LIMIT matches and reports exact line/text for each (boundary)", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `d${i} = shelve.open(p${i})`);
		const code = lines.join("\n");
		const matches = checkShelveOpen(code, "src/many.py");
		expect(matches).toEqual(lines.slice(0, 10).map((text, i) => ({ line: i + 1, text })));
	});

	it("N1: bare `# noqa` on the call line suppresses a real shelve.open call", () => {
		expect(checkShelveOpen("d = shelve.open(p)  # noqa", "src/a.py")).toEqual([]);
	});

	it("N2: shelve.Shelf(p) direct class instantiation does not match the .open(-only regex", () => {
		expect(checkShelveOpen("d = shelve.Shelf(p)", "src/a.py")).toEqual([]);
	});

	it("N3: a comment merely mentioning shelve.open is stripped before matching", () => {
		expect(checkShelveOpen("# call shelve.open(path) here\nx = 1", "src/a.py")).toEqual([]);
	});
});

describe("checkYamlUnsafeLoad — precision", () => {
	it("MUST-NOT-FIRE: wrong extension returns a genuinely empty array", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f)", "src/a.ts")).toEqual([]);
	});

	it("MUST-NOT-FIRE: skips test files", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f)", "tests/test_a.py")).toEqual([]);
	});

	it("MUST-NOT-FIRE: skips vendored paths", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f)", "vendor/pkg/a.py")).toEqual([]);
	});

	it("flags `yaml.unsafe_load(f)` with an exact line/text (first pass)", () => {
		const code = "cfg = yaml.unsafe_load(f)";
		expect(checkYamlUnsafeLoad(code, "src/a.py")).toEqual([{ line: 1, text: code }]);
	});

	it("unsafe_load regex tolerates a space before the call's opening paren", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.unsafe_load (f)", "src/a.py").length).toBeGreaterThan(0);
	});

	it("unsafe_load noqa suppresses via bare `# noqa` (first pass)", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.unsafe_load(f)  # noqa", "src/a.py")).toEqual([]);
	});

	it("first pass trims whitespace and truncates the reported text to 150 chars", () => {
		const raw = `  yaml.unsafe_load(f)${"z".repeat(200)}  `;
		expect(checkYamlUnsafeLoad(raw, "src/a.py")).toEqual([
			{ line: 1, text: raw.trim().slice(0, 150) },
		]);
	});

	it("bare `yaml.load(f, Loader=yaml.FullLoader)` fires with an exact line/text", () => {
		const code = "cfg = yaml.load(f, Loader=yaml.FullLoader)";
		expect(checkYamlUnsafeLoad(code, "src/a.py")).toEqual([{ line: 1, text: code }]);
	});

	it("load regex tolerates a space before the call's opening paren", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load (f)", "src/a.py").length).toBeGreaterThan(0);
	});

	it("load regex recognizes a `Loader=yaml.SafeLoader` kwarg as the safe form", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f, Loader=yaml.SafeLoader)", "src/a.py")).toEqual(
			[],
		);
	});

	it("load regex's Safe-loader lookahead window covers more than a single character", () => {
		const padding = "x".repeat(50);
		const code = `cfg = yaml.load(${padding}Safe)`;
		expect(checkYamlUnsafeLoad(code, "src/a.py")).toEqual([]);
	});

	it("load noqa suppresses via bare `# noqa` (second pass)", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f)  # noqa", "src/a.py")).toEqual([]);
	});

	it("dedups a single line matched by both passes (unsafe_load + bare load)", () => {
		const code = "x = yaml.unsafe_load(f); y = yaml.load(g)";
		expect(checkYamlUnsafeLoad(code, "src/a.py")).toEqual([{ line: 1, text: code }]);
	});

	it("does NOT dedup two distinct findings on two distinct lines", () => {
		const code = "yaml.unsafe_load(f)\ncfg = yaml.load(g)\n";
		expect(checkYamlUnsafeLoad(code, "src/a.py").map((m) => m.line)).toEqual([1, 2]);
	});

	it("caps the first pass at MATCH_LIMIT and reports exact line/text for each", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `x${i} = yaml.unsafe_load(f)`);
		const code = lines.join("\n");
		const matches = checkYamlUnsafeLoad(code, "src/many.py");
		expect(matches).toEqual(lines.slice(0, 10).map((text, i) => ({ line: i + 1, text })));
	});

	it("caps the second pass at MATCH_LIMIT and reports exact line/text for each", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `x${i} = yaml.load(f)`);
		const code = lines.join("\n");
		const matches = checkYamlUnsafeLoad(code, "src/many.py");
		expect(matches).toEqual(lines.slice(0, 10).map((text, i) => ({ line: i + 1, text })));
	});
});

describe("checkTorchUnsafeLoad — precision", () => {
	it("MUST-NOT-FIRE: wrong extension returns a genuinely empty array", () => {
		expect(checkTorchUnsafeLoad("torch.load(p)", "src/a.ts")).toEqual([]);
	});

	it("MUST-NOT-FIRE: skips test files", () => {
		expect(checkTorchUnsafeLoad("torch.load(p)", "tests/test_a.py")).toEqual([]);
	});

	it("MUST-NOT-FIRE: skips vendored paths", () => {
		expect(checkTorchUnsafeLoad("torch.load(p)", "vendor/pkg/a.py")).toEqual([]);
	});

	it("flags torch.load(path) with an exact line/text", () => {
		const code = "model = torch.load(path)";
		expect(checkTorchUnsafeLoad(code, "src/a.py")).toEqual([{ line: 1, text: code }]);
	});

	it("regex tolerates a space before the call's opening paren", () => {
		expect(checkTorchUnsafeLoad("model = torch.load (path)", "src/a.py").length).toBeGreaterThan(0);
	});

	it("recognizes `weights_only = True` (spaced) as the safe form", () => {
		expect(
			checkTorchUnsafeLoad("model = torch.load(path, weights_only = True)", "src/a.py"),
		).toEqual([]);
	});

	it("noqa suppresses via bare `# noqa`", () => {
		expect(checkTorchUnsafeLoad("model = torch.load(path)  # noqa", "src/a.py")).toEqual([]);
	});

	it("caps at MATCH_LIMIT matches and reports exact line/text for each (boundary)", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `m${i} = torch.load(path${i})`);
		const code = lines.join("\n");
		const matches = checkTorchUnsafeLoad(code, "src/many.py");
		expect(matches).toEqual(lines.slice(0, 10).map((text, i) => ({ line: i + 1, text })));
	});
});

describe("checkPickleWrapperLoad — precision", () => {
	it("MUST-NOT-FIRE: wrong extension returns a genuinely empty array", () => {
		expect(checkPickleWrapperLoad("joblib.load(p)", "src/a.ts")).toEqual([]);
	});

	it("MUST-NOT-FIRE: skips test files", () => {
		expect(checkPickleWrapperLoad("joblib.load(p)", "tests/test_a.py")).toEqual([]);
	});

	it("MUST-NOT-FIRE: skips vendored paths", () => {
		expect(checkPickleWrapperLoad("joblib.load(p)", "vendor/pkg/a.py")).toEqual([]);
	});

	it("flags joblib.load(p) with an exact line/text", () => {
		const code = "m = joblib.load(p)";
		expect(checkPickleWrapperLoad(code, "src/a.py")).toEqual([{ line: 1, text: code }]);
	});

	it("direct regex tolerates a space before the joblib.load paren", () => {
		expect(checkPickleWrapperLoad("m = joblib.load (p)", "src/a.py").length).toBeGreaterThan(0);
	});

	it("direct regex fires on pd.read_pickle with zero whitespace before the paren", () => {
		expect(checkPickleWrapperLoad("df = pd.read_pickle(p)", "src/a.py").length).toBeGreaterThan(0);
	});

	it("direct regex tolerates a space before the pd.read_pickle paren", () => {
		expect(checkPickleWrapperLoad("df = pd.read_pickle (p)", "src/a.py").length).toBeGreaterThan(0);
	});

	it("numpy regex requires explicit `allow_pickle=True`, not just any np.load(...)", () => {
		expect(checkPickleWrapperLoad("arr = np.load(p)", "src/a.py")).toEqual([]);
	});

	it("numpy regex fires with an exact line/text when allow_pickle=True is present", () => {
		const code = "arr = np.load(p, allow_pickle=True)";
		expect(checkPickleWrapperLoad(code, "src/a.py")).toEqual([{ line: 1, text: code }]);
	});

	it("numpy regex tolerates a space before the np.load paren", () => {
		expect(
			checkPickleWrapperLoad("arr = np.load (p, allow_pickle=True)", "src/a.py").length,
		).toBeGreaterThan(0);
	});

	it("numpy regex's allow_pickle window covers more than a handful of characters (and the negated char class is a real negation)", () => {
		const padding = "x".repeat(50);
		const code = `arr = np.load(p, ${padding}, allow_pickle=True)`;
		expect(checkPickleWrapperLoad(code, "src/a.py").length).toBeGreaterThan(0);
	});

	it("numpy regex tolerates spaces around the `=` in allow_pickle=True", () => {
		expect(
			checkPickleWrapperLoad("arr = np.load(p, allow_pickle = True)", "src/a.py").length,
		).toBeGreaterThan(0);
	});

	it("dedups a single line matched by both the direct and numpy passes", () => {
		const code = "m = joblib.load(p); arr = np.load(q, allow_pickle=True)";
		expect(checkPickleWrapperLoad(code, "src/a.py")).toEqual([{ line: 1, text: code }]);
	});

	it("does NOT dedup two distinct findings on two distinct lines", () => {
		const code = "m = joblib.load(p)\narr = np.load(q, allow_pickle=True)\n";
		expect(checkPickleWrapperLoad(code, "src/a.py").map((m) => m.line)).toEqual([1, 2]);
	});

	it("noqa suppresses the direct pass via bare `# noqa`", () => {
		expect(checkPickleWrapperLoad("m = joblib.load(p)  # noqa", "src/a.py")).toEqual([]);
	});

	it("noqa suppresses the numpy pass via bare `# noqa`", () => {
		expect(
			checkPickleWrapperLoad("arr = np.load(p, allow_pickle=True)  # noqa", "src/a.py"),
		).toEqual([]);
	});

	it("numpy pass trims whitespace and truncates the reported text to 150 chars", () => {
		const raw = `  arr = np.load(p, allow_pickle=True)${"z".repeat(200)}  `;
		expect(checkPickleWrapperLoad(raw, "src/a.py")).toEqual([
			{ line: 1, text: raw.trim().slice(0, 150) },
		]);
	});

	it("caps the direct pass at MATCH_LIMIT and reports exact line/text for each", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `m${i} = joblib.load(p${i})`);
		const code = lines.join("\n");
		const matches = checkPickleWrapperLoad(code, "src/many.py");
		expect(matches).toEqual(lines.slice(0, 10).map((text, i) => ({ line: i + 1, text })));
	});

	it("caps the numpy pass at MATCH_LIMIT and reports exact line/text for each", () => {
		const lines = Array.from(
			{ length: 11 },
			(_, i) => `arr${i} = np.load(p${i}, allow_pickle=True)`,
		);
		const code = lines.join("\n");
		const matches = checkPickleWrapperLoad(code, "src/many.py");
		expect(matches).toEqual(lines.slice(0, 10).map((text, i) => ({ line: i + 1, text })));
	});
});

describe("checkSubprocessShellTrue — mutation hardening", () => {
	it("also flags .pyi files (not just .py)", () => {
		expect(checkSubprocessShellTrue("subprocess.run(cmd, shell=True)", "a.pyi").length).toBeGreaterThan(0);
	});

	it("skips vendored/fixture paths even with a real shell=True call", () => {
		expect(checkSubprocessShellTrue("subprocess.run(cmd, shell=True)", "vendor/lib.py")).toEqual([]);
	});

	it("returns [] on content with no subprocess call at all", () => {
		expect(checkSubprocessShellTrue("print('hello world')", "a.py")).toEqual([]);
	});

	it("is whitespace-tolerant around the call and the shell= kwarg", () => {
		expect(checkSubprocessShellTrue("subprocess.run (cmd, shell = True)", "a.py").length).toBeGreaterThan(0);
	});

	it("caps at MATCH_LIMIT even with more occurrences than the cap", () => {
		const code = repeat("subprocess.run(cmd, shell=True)", MATCH_LIMIT + 5);
		expect(checkSubprocessShellTrue(code, "a.py").length).toBe(MATCH_LIMIT);
	});

	it("reports the exact line and full object shape after preamble lines", () => {
		const code = ["# preamble one", "# preamble two", "result = subprocess.run(cmd, shell=True)"].join("\n");
		expect(checkSubprocessShellTrue(code, "a.py")).toEqual([
			{ line: 3, text: "result = subprocess.run(cmd, shell=True)" },
		]);
	});

	it("anchors the reported line at `shell=True`, not the call-start line, for a multi-line call", () => {
		const code = ["def run(cmd):", "    return subprocess.run(", "        cmd,", "        shell=True,", "    )"].join(
			"\n",
		);
		expect(checkSubprocessShellTrue(code, "a.py")).toEqual([{ line: 4, text: "shell=True," }]);
	});

	it("anchors on `shell` itself, not the end of the match, when they land on different lines", () => {
		const code = ["subprocess.run(", "    cmd,", "    shell=", "        True,", ")"].join("\n");
		expect(checkSubprocessShellTrue(code, "a.py")).toEqual([{ line: 3, text: "shell=" }]);
	});

	it("does not let a noqa on an unrelated earlier line suppress a call that starts on a later line", () => {
		const code = [
			"# noqa: S602 -- unrelated comment, not attached to the call below",
			"result = subprocess.run(",
			"    cmd,",
			"    shell=True,",
			")",
		].join("\n");
		expect(checkSubprocessShellTrue(code, "a.py")).toEqual([{ line: 4, text: "shell=True," }]);
	});

	it("respects a noqa on the call-start line of a multi-line call (callStartLine range)", () => {
		const code = ["result = subprocess.run(  # noqa: S602", "    cmd,", "    shell=True,", ")"].join("\n");
		expect(checkSubprocessShellTrue(code, "a.py")).toEqual([]);
	});

	it("does NOT suppress on an unrelated bandit code", () => {
		expect(
			checkSubprocessShellTrue("subprocess.run(cmd, shell=True)  # noqa: S301", "a.py").length,
		).toBeGreaterThan(0);
	});

	it("trims leading whitespace and truncates the reported text to 150 chars", () => {
		const padding = "x".repeat(140);
		const code = `    subprocess.run(cmd, shell=True)  # ${padding}`;
		expect(checkSubprocessShellTrue(code, "a.py")).toEqual([{ line: 1, text: code.trim().slice(0, 150) }]);
	});
});

describe("checkPyNoneEquality — mutation hardening", () => {
	it("also fires for .pyi files", () => {
		expect(checkPyNoneEquality("if x == None:", "a.pyi").length).toBeGreaterThan(0);
	});

	it("gates on .py/.pyi — a non-Python file with matching content returns []", () => {
		expect(checkPyNoneEquality("value == None", "a.ts")).toEqual([]);
	});

	it("requires a real multi-char identifier on the non-Yoda side", () => {
		expect(checkPyNoneEquality("value == None", "a.py").length).toBeGreaterThan(0);
		expect(checkPyNoneEquality("value != None", "a.py").length).toBeGreaterThan(0);
	});

	it("matches Yoda-style comparisons both tightly and with surrounding whitespace", () => {
		expect(checkPyNoneEquality("None==value", "a.py").length).toBeGreaterThan(0);
		expect(checkPyNoneEquality("None == value", "a.py").length).toBeGreaterThan(0);
	});

	it("matches the non-Yoda form with zero surrounding whitespace", () => {
		expect(checkPyNoneEquality("value==None", "a.py").length).toBeGreaterThan(0);
	});

	it("returns [] for content with no None comparison", () => {
		expect(checkPyNoneEquality("if x is None:", "a.py")).toEqual([]);
	});

	it("caps at MATCH_LIMIT with more occurrences than the cap", () => {
		const code = repeat("x == None", MATCH_LIMIT + 5);
		expect(checkPyNoneEquality(code, "a.py").length).toBe(MATCH_LIMIT);
	});

	it("reports the exact line number and shape after preamble lines", () => {
		const code = ["# one", "# two", "value == None"].join("\n");
		expect(checkPyNoneEquality(code, "a.py")).toEqual([{ line: 3, text: "value == None" }]);
	});

	it("trims and truncates the reported text", () => {
		const padding = "y".repeat(140);
		const code = `   value == None  ${padding}`;
		expect(checkPyNoneEquality(code, "a.py")).toEqual([{ line: 1, text: code.trim().slice(0, 150) }]);
	});

	it("N1: a lowercase `none` identifier is not the None singleton (case-sensitive literal)", () => {
		expect(checkPyNoneEquality("if x == none: pass", "a.py")).toEqual([]);
	});

	it("N2: `NoneType` fails the trailing word-boundary — None is not a whole word here", () => {
		expect(checkPyNoneEquality("if x == NoneType: pass", "a.py")).toEqual([]);
	});

	it("N3: a `== None` comparison inside a string literal is stripped before matching", () => {
		expect(checkPyNoneEquality('msg = "if x == None: pass"', "a.py")).toEqual([]);
	});
});

describe("checkPyMutableDefaultArg — mutation hardening", () => {
	it("gates on .py only, even with matching content", () => {
		expect(checkPyMutableDefaultArg("def f(x=[]):", "a.ts")).toEqual([]);
	});

	it("requires a multi-char function name, not just one letter", () => {
		expect(checkPyMutableDefaultArg("def func(x=[]):", "a.py").length).toBeGreaterThan(0);
	});

	it("is whitespace-tolerant: extra space after def / around = / inside brackets-braces / before (", () => {
		expect(checkPyMutableDefaultArg("def  func(x = []):", "a.py").length).toBeGreaterThan(0);
		expect(checkPyMutableDefaultArg("def func(x=[  ]):", "a.py").length).toBeGreaterThan(0);
		expect(checkPyMutableDefaultArg("def func(x = {  }):", "a.py").length).toBeGreaterThan(0);
		expect(checkPyMutableDefaultArg("def func (x=[]):", "a.py").length).toBeGreaterThan(0);
	});

	it("allows a preceding positional arg before the mutable default ([^)]* boundary)", () => {
		expect(checkPyMutableDefaultArg("def func(x, y=[]):", "a.py").length).toBeGreaterThan(0);
	});

	it("returns [] for content with no mutable default", () => {
		expect(checkPyMutableDefaultArg("def f(x=None):", "a.py")).toEqual([]);
	});

	it("caps at MATCH_LIMIT with more occurrences than the cap", () => {
		const code = repeat("def func(x=[]):", MATCH_LIMIT + 5);
		expect(checkPyMutableDefaultArg(code, "a.py").length).toBe(MATCH_LIMIT);
	});

	it("reports the exact line number and shape after preamble lines", () => {
		const code = ["# one", "# two", "def func(x=[]):"].join("\n");
		expect(checkPyMutableDefaultArg(code, "a.py")).toEqual([{ line: 3, text: "def func(x=[]):" }]);
	});

	it("trims and truncates the reported text", () => {
		const padding = "z".repeat(140);
		const code = `   def func(x=[]):  ${padding}`;
		expect(checkPyMutableDefaultArg(code, "a.py")).toEqual([{ line: 1, text: code.trim().slice(0, 150) }]);
	});
});

describe("checkTempfileMktempRace — mutation hardening", () => {
	it("gates on .py/.pyi even with a real mktemp call", () => {
		expect(checkTempfileMktempRace("p = tempfile.mktemp()", "a.ts")).toEqual([]);
	});

	it("also fires for .pyi files", () => {
		expect(checkTempfileMktempRace("p = tempfile.mktemp()", "a.pyi").length).toBeGreaterThan(0);
	});

	it("skips test files even with a real mktemp call", () => {
		expect(checkTempfileMktempRace("p = tempfile.mktemp()", "test_foo.py")).toEqual([]);
	});

	it("is whitespace-tolerant before the call parens", () => {
		expect(checkTempfileMktempRace("p = tempfile.mktemp ()", "a.py").length).toBeGreaterThan(0);
	});

	it("returns [] for content with no mktemp call", () => {
		expect(checkTempfileMktempRace("p = tempfile.mkstemp()", "a.py")).toEqual([]);
	});

	it("caps at MATCH_LIMIT with more occurrences than the cap", () => {
		const code = repeat("p = tempfile.mktemp()", MATCH_LIMIT + 5);
		expect(checkTempfileMktempRace(code, "a.py").length).toBe(MATCH_LIMIT);
	});

	it("reports the exact line number and shape after preamble lines", () => {
		const code = ["# one", "# two", "p = tempfile.mktemp()"].join("\n");
		expect(checkTempfileMktempRace(code, "a.py")).toEqual([{ line: 3, text: "p = tempfile.mktemp()" }]);
	});

	it("trims and truncates the reported text", () => {
		const padding = "q".repeat(140);
		const code = `   p = tempfile.mktemp()  ${padding}`;
		expect(checkTempfileMktempRace(code, "a.py")).toEqual([{ line: 1, text: code.trim().slice(0, 150) }]);
	});
});

describe("checkPickleUntrustedLoad — mutation hardening", () => {
	it("gates on .py/.pyi, test files, and vendored paths", () => {
		expect(checkPickleUntrustedLoad("x = pickle.load(f)", "a.ts")).toEqual([]);
		expect(checkPickleUntrustedLoad("x = pickle.load(f)", "test_foo.py")).toEqual([]);
		expect(checkPickleUntrustedLoad("x = pickle.load(f)", "vendor/lib.py")).toEqual([]);
	});

	it("is whitespace-tolerant before the call parens for both alternatives", () => {
		expect(checkPickleUntrustedLoad("x = pickle.load ('f')", "a.py").length).toBeGreaterThan(0);
		expect(checkPickleUntrustedLoad("x = jsonpickle.decode(f)", "a.py").length).toBeGreaterThan(0);
		expect(checkPickleUntrustedLoad("x = jsonpickle.decode  (f)", "a.py").length).toBeGreaterThan(0);
	});

	it("returns [] for content with no pickle-family call", () => {
		expect(checkPickleUntrustedLoad("x = json.load(f)", "a.py")).toEqual([]);
	});

	it("respects `# noqa: S301` but not an unrelated bandit code", () => {
		expect(checkPickleUntrustedLoad("x = pickle.load(f)  # noqa: S301", "a.py")).toEqual([]);
		expect(checkPickleUntrustedLoad("x = pickle.load(f)  # noqa: S602", "a.py").length).toBeGreaterThan(0);
	});

	it("caps at MATCH_LIMIT with more occurrences than the cap", () => {
		const code = repeat("x = pickle.load(f)", MATCH_LIMIT + 5);
		expect(checkPickleUntrustedLoad(code, "a.py").length).toBe(MATCH_LIMIT);
	});

	it("reports the exact line number and shape after preamble lines", () => {
		const code = ["# one", "# two", "x = pickle.load(f)"].join("\n");
		expect(checkPickleUntrustedLoad(code, "a.py")).toEqual([{ line: 3, text: "x = pickle.load(f)" }]);
	});

	it("trims and truncates the reported text", () => {
		const padding = "r".repeat(140);
		const code = `   x = pickle.load(f)  ${padding}`;
		expect(checkPickleUntrustedLoad(code, "a.py")).toEqual([{ line: 1, text: code.trim().slice(0, 150) }]);
	});
});

describe("checkXmlExternalEntity — mutation hardening", () => {
	it("gates on .py/.pyi, test files, and vendored paths", () => {
		const code = "import xml.etree.ElementTree as ET\nET.parse(src)";
		expect(checkXmlExternalEntity(code, "a.ts")).toEqual([]);
		expect(checkXmlExternalEntity(code, "test_foo.py")).toEqual([]);
		expect(checkXmlExternalEntity(code, "vendor/lib.py")).toEqual([]);
	});

	it("returns [] on content with no xml-family import at all", () => {
		expect(checkXmlExternalEntity("print('hi')", "a.py")).toEqual([]);
	});

	it("respects defusedxml anywhere in the file", () => {
		const code = "import defusedxml.ElementTree as ET\nimport xml.etree.ElementTree\nET.parse(src)";
		expect(checkXmlExternalEntity(code, "a.py")).toEqual([]);
	});

	it("requires an actual parse call — import-only files are safe", () => {
		const code = "import xml.etree.ElementTree as ET\n\ndef build():\n    return ET.Element('root')";
		expect(checkXmlExternalEntity(code, "a.py")).toEqual([]);
	});

	it("is whitespace-tolerant in the import/from statement", () => {
		expect(
			checkXmlExternalEntity("import  xml.etree.ElementTree as ET\nET.parse(src)", "a.py").length,
		).toBeGreaterThan(0);
		expect(checkXmlExternalEntity("from  xml.dom import minidom\nET.parse(src)", "a.py").length).toBeGreaterThan(0);
		expect(checkXmlExternalEntity("from  lxml import etree\nET.parse(src)", "a.py").length).toBeGreaterThan(0);
	});

	it("is whitespace-tolerant around the dot and call parens in the parse-call gate", () => {
		expect(checkXmlExternalEntity("import xml.etree.ElementTree as ET\nroot = ET .parse(src)", "a.py").length).toBeGreaterThan(0);
		expect(checkXmlExternalEntity("import xml.etree.ElementTree as ET\nroot = ET. parse(src)", "a.py").length).toBeGreaterThan(0);
		expect(checkXmlExternalEntity("import xml.etree.ElementTree as ET\nroot = ET.parse (src)", "a.py").length).toBeGreaterThan(0);
	});

	it("recognizes a submodule-qualified xml.etree access, and requires the FULL submodule chain (no star truncation)", () => {
		expect(
			checkXmlExternalEntity("import xml.etree.ElementTree\nroot = xml.etree.ElementTree.parse(src)", "a.py")
				.length,
		).toBeGreaterThan(0);
		expect(
			checkXmlExternalEntity("import xml.etree.ElementTree\nroot = xml.etree.foo.bar.parse(src)", "a.py").length,
		).toBeGreaterThan(0);
	});

	it("recognizes the standalone XMLPullParser() call, tight and with a space before the parens", () => {
		expect(checkXmlExternalEntity("import xml.etree.ElementTree\np = XMLPullParser()", "a.py").length).toBeGreaterThan(0);
		expect(checkXmlExternalEntity("import xml.etree.ElementTree\np = XMLPullParser ()", "a.py").length).toBeGreaterThan(0);
	});

	it("only reports the import line, not the (non-import-shaped) parse-call line", () => {
		const code = "import xml.etree.ElementTree as ET\nroot = ET.parse(src)";
		expect(checkXmlExternalEntity(code, "a.py")).toEqual([{ line: 1, text: "import xml.etree.ElementTree as ET" }]);
	});

	it("respects `# noqa: S314` / `# noqa: S320` but not an unrelated code", () => {
		const suppressed = "import xml.etree.ElementTree as ET  # noqa: S314\nroot = ET.parse(src)";
		expect(checkXmlExternalEntity(suppressed, "a.py")).toEqual([]);
		const notSuppressed = "import xml.etree.ElementTree as ET  # noqa: S602\nroot = ET.parse(src)";
		expect(checkXmlExternalEntity(notSuppressed, "a.py").length).toBeGreaterThan(0);
	});

	it("caps at MATCH_LIMIT with more occurrences than the cap", () => {
		const code = [
			...Array.from({ length: MATCH_LIMIT + 5 }, (_, i) => `import xml.etree.ElementTree as ET${i}`),
			"root = ET.parse(src)",
		].join("\n");
		expect(checkXmlExternalEntity(code, "a.py").length).toBe(MATCH_LIMIT);
	});

	it("trims and truncates the reported text", () => {
		const padding = "s".repeat(140);
		const code = `   import xml.etree.ElementTree as ET  ${padding}\nroot = ET.parse(src)`;
		const firstLine = code.split("\n")[0] ?? "";
		expect(checkXmlExternalEntity(code, "a.py")).toEqual([{ line: 1, text: firstLine.trim().slice(0, 150) }]);
	});
});

describe("checkOsSystemTainted — mutation hardening", () => {
	it("gates on .py/.pyi, test files, and vendored paths", () => {
		expect(checkOsSystemTainted("os.system(cmd)", "a.ts")).toEqual([]);
		expect(checkOsSystemTainted("os.system(cmd)", "test_foo.py")).toEqual([]);
		expect(checkOsSystemTainted("os.system(cmd)", "vendor/lib.py")).toEqual([]);
	});

	it("is whitespace-tolerant before/after the call parens", () => {
		expect(checkOsSystemTainted("os.system (cmd)", "a.py").length).toBeGreaterThan(0);
		expect(checkOsSystemTainted("os.system( cmd)", "a.py").length).toBeGreaterThan(0);
	});

	it("fires for a single-character identifier argument", () => {
		expect(checkOsSystemTainted("os.system(x)", "a.py").length).toBeGreaterThan(0);
		expect(checkOsSystemTainted("os.popen(y)", "a.py").length).toBeGreaterThan(0);
	});

	it("returns [] for content with no os.system/popen call", () => {
		expect(checkOsSystemTainted("print('hi')", "a.py")).toEqual([]);
	});

	it("caps at MATCH_LIMIT with more occurrences than the cap", () => {
		const code = repeat("os.system(cmd)", MATCH_LIMIT + 5);
		expect(checkOsSystemTainted(code, "a.py").length).toBe(MATCH_LIMIT);
	});

	it("reports the exact line number and shape after preamble lines", () => {
		const code = ["# one", "# two", "os.system(cmd)"].join("\n");
		expect(checkOsSystemTainted(code, "a.py")).toEqual([{ line: 3, text: "os.system(cmd)" }]);
	});

	it("trims and truncates the reported text", () => {
		const padding = "t".repeat(140);
		const code = `   os.system(cmd)  ${padding}`;
		expect(checkOsSystemTainted(code, "a.py")).toEqual([{ line: 1, text: code.trim().slice(0, 150) }]);
	});
});

describe("checkRegexInLoopNoCompile — mutation hardening", () => {
	it("gates on .py/.pyi and test files", () => {
		const code = "for line in lines:\n    re.match(pat, line)";
		expect(checkRegexInLoopNoCompile(code, "a.ts")).toEqual([]);
		expect(checkRegexInLoopNoCompile(code, "test_foo.py")).toEqual([]);
	});

	it("does NOT fire on a re.* call that is not inside any loop (inLoop must start false)", () => {
		expect(checkRegexInLoopNoCompile("re.match(pat, x)", "a.py")).toEqual([]);
	});

	it("returns [] for content with no loop and no re call", () => {
		expect(checkRegexInLoopNoCompile("x = 1", "a.py")).toEqual([]);
	});

	it("resets loop-tracking once the code de-indents past the loop body", () => {
		const code = ["for line in lines:", "    pass", "re.match(pat, x)"].join("\n");
		expect(checkRegexInLoopNoCompile(code, "a.py")).toEqual([]);
	});

	it("does NOT reset loop-tracking on a blank line inside the loop body", () => {
		const code = ["for line in lines:", "", "    re.match(pat, line)"].join("\n");
		expect(checkRegexInLoopNoCompile(code, "a.py")).toEqual([{ line: 3, text: "re.match(pat, line)" }]);
	});

	it("requires the for/while keyword at the true start of the line, not merely present later on the line", () => {
		const code = ["items = [x for x in range(10)]", "    re.match(pat, line)"].join("\n");
		expect(checkRegexInLoopNoCompile(code, "a.py")).toEqual([]);
	});

	it("still recognizes an indented for/while loop start", () => {
		const code = ["    for x in y:", "        re.match(pat, x)"].join("\n");
		expect(checkRegexInLoopNoCompile(code, "a.py")).toEqual([{ line: 2, text: "re.match(pat, x)" }]);
	});

	it("is whitespace-tolerant before the re.* call parens", () => {
		const code = "for line in lines:\n    re.match (pat, line)";
		expect(checkRegexInLoopNoCompile(code, "a.py").length).toBeGreaterThan(0);
	});

	it("caps at MATCH_LIMIT with more occurrences than the cap", () => {
		const code = ["for line in lines:", ...Array.from({ length: MATCH_LIMIT + 5 }, () => "    re.match(pat, line)")].join(
			"\n",
		);
		expect(checkRegexInLoopNoCompile(code, "a.py").length).toBe(MATCH_LIMIT);
	});

	it("trims and truncates the reported text", () => {
		const padding = "u".repeat(140);
		const code = `for line in lines:\n        re.match(pat, line)  ${padding}`;
		const secondLine = code.split("\n")[1] ?? "";
		expect(checkRegexInLoopNoCompile(code, "a.py")).toEqual([{ line: 2, text: secondLine.trim().slice(0, 150) }]);
	});
});

describe("checkMarshalLoad — mutation hardening", () => {
	it("gates on .py/.pyi, test files, and vendored paths", () => {
		expect(checkMarshalLoad("obj = marshal.loads(buf)", "a.ts")).toEqual([]);
		expect(checkMarshalLoad("obj = marshal.loads(buf)", "test_foo.py")).toEqual([]);
		expect(checkMarshalLoad("obj = marshal.loads(buf)", "vendor/lib.py")).toEqual([]);
	});

	it("fires for both marshal.load and marshal.loads", () => {
		expect(checkMarshalLoad("obj = marshal.load(buf)", "a.py").length).toBeGreaterThan(0);
		expect(checkMarshalLoad("obj = marshal.loads(buf)", "a.py").length).toBeGreaterThan(0);
	});

	it("is whitespace-tolerant before the call parens", () => {
		expect(checkMarshalLoad("obj = marshal.loads (buf)", "a.py").length).toBeGreaterThan(0);
	});

	it("returns [] for content with no marshal call", () => {
		expect(checkMarshalLoad("obj = json.loads(buf)", "a.py")).toEqual([]);
	});

	it("respects a bare `# noqa` suppression", () => {
		expect(checkMarshalLoad("obj = marshal.loads(buf)  # noqa", "a.py")).toEqual([]);
	});

	it("caps at MATCH_LIMIT with more occurrences than the cap", () => {
		const code = repeat("obj = marshal.loads(buf)", MATCH_LIMIT + 5);
		expect(checkMarshalLoad(code, "a.py").length).toBe(MATCH_LIMIT);
	});

	it("reports the exact line number and shape after preamble lines", () => {
		const code = ["# one", "# two", "obj = marshal.loads(buf)"].join("\n");
		expect(checkMarshalLoad(code, "a.py")).toEqual([{ line: 3, text: "obj = marshal.loads(buf)" }]);
	});

	it("trims and truncates the reported text", () => {
		const padding = "v".repeat(140);
		const code = `   obj = marshal.loads(buf)  ${padding}`;
		expect(checkMarshalLoad(code, "a.py")).toEqual([{ line: 1, text: code.trim().slice(0, 150) }]);
	});
});

describe("checkShelveOpen — mutation hardening", () => {
	it("gates on .py/.pyi, test files, and vendored paths", () => {
		expect(checkShelveOpen("d = shelve.open(p)", "a.ts")).toEqual([]);
		expect(checkShelveOpen("d = shelve.open(p)", "test_foo.py")).toEqual([]);
		expect(checkShelveOpen("d = shelve.open(p)", "vendor/lib.py")).toEqual([]);
	});

	it("is whitespace-tolerant before the call parens", () => {
		expect(checkShelveOpen("d = shelve.open (p)", "a.py").length).toBeGreaterThan(0);
	});

	it("returns [] for content with no shelve call", () => {
		expect(checkShelveOpen("d = sqlite3.connect(p)", "a.py")).toEqual([]);
	});

	it("respects a bare `# noqa` suppression", () => {
		expect(checkShelveOpen("d = shelve.open(p)  # noqa", "a.py")).toEqual([]);
	});

	it("caps at MATCH_LIMIT with more occurrences than the cap", () => {
		const code = repeat("d = shelve.open(p)", MATCH_LIMIT + 5);
		expect(checkShelveOpen(code, "a.py").length).toBe(MATCH_LIMIT);
	});

	it("reports the exact line number and shape after preamble lines", () => {
		const code = ["# one", "# two", "d = shelve.open(p)"].join("\n");
		expect(checkShelveOpen(code, "a.py")).toEqual([{ line: 3, text: "d = shelve.open(p)" }]);
	});

	it("trims and truncates the reported text", () => {
		const padding = "w".repeat(140);
		const code = `   d = shelve.open(p)  ${padding}`;
		expect(checkShelveOpen(code, "a.py")).toEqual([{ line: 1, text: code.trim().slice(0, 150) }]);
	});
});

describe("checkYamlUnsafeLoad — mutation hardening", () => {
	it("gates on .py/.pyi, test files, and vendored paths", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f)", "a.ts")).toEqual([]);
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f)", "test_foo.py")).toEqual([]);
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f)", "vendor/lib.py")).toEqual([]);
	});

	it("is whitespace-tolerant before the call parens for both forms", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.unsafe_load  (f)", "a.py").length).toBeGreaterThan(0);
		expect(checkYamlUnsafeLoad("cfg = yaml.load  (f)", "a.py").length).toBeGreaterThan(0);
	});

	it("does not require `Safe` to be immediately adjacent — scans the whole 200-char window", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(some_long_kwarg_name_here, Safe)", "a.py")).toEqual([]);
	});

	it("recognizes `Loader=yaml.SafeLoader` anywhere before the closing paren as safe", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f, Loader=yaml.SafeLoader)", "a.py")).toEqual([]);
	});

	it("does not double-count a line that matches both the unsafe_load and bare-load patterns", () => {
		const code = "yaml.unsafe_load(f); z = yaml.load(g)";
		expect(checkYamlUnsafeLoad(code, "a.py").length).toBe(1);
	});

	it("returns [] for yaml.safe_load", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.safe_load(f)", "a.py")).toEqual([]);
	});

	it("caps at MATCH_LIMIT with more occurrences than the cap", () => {
		const code = repeat("cfg = yaml.load(f)", MATCH_LIMIT + 5);
		expect(checkYamlUnsafeLoad(code, "a.py").length).toBe(MATCH_LIMIT);
	});

	it("reports the exact line number and shape for yaml.unsafe_load after preamble lines", () => {
		const code = ["# one", "# two", "cfg = yaml.unsafe_load(f)"].join("\n");
		expect(checkYamlUnsafeLoad(code, "a.py")).toEqual([{ line: 3, text: "cfg = yaml.unsafe_load(f)" }]);
	});

	it("trims and truncates the reported text for the yaml.unsafe_load form", () => {
		const padding = "d4".repeat(70);
		const code = `   cfg = yaml.unsafe_load(f)  ${padding}`;
		expect(checkYamlUnsafeLoad(code, "a.py")).toEqual([{ line: 1, text: code.trim().slice(0, 150) }]);
	});

	it("trims and truncates the reported text for the bare yaml.load form", () => {
		const padding = "a1".repeat(70);
		const code = `   cfg = yaml.load(f)  ${padding}`;
		expect(checkYamlUnsafeLoad(code, "a.py")).toEqual([{ line: 1, text: code.trim().slice(0, 150) }]);
	});

	it("respects a bare `# noqa` on the bare yaml.load form", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f)  # noqa", "a.py")).toEqual([]);
	});
});

describe("checkTorchUnsafeLoad — mutation hardening", () => {
	it("gates on .py/.pyi, test files, and vendored paths", () => {
		expect(checkTorchUnsafeLoad("m = torch.load(p)", "a.ts")).toEqual([]);
		expect(checkTorchUnsafeLoad("m = torch.load(p)", "test_foo.py")).toEqual([]);
		expect(checkTorchUnsafeLoad("m = torch.load(p)", "vendor/lib.py")).toEqual([]);
	});

	it("is whitespace-tolerant before the call parens and around weights_only=True", () => {
		expect(checkTorchUnsafeLoad("m = torch.load  (p)", "a.py").length).toBeGreaterThan(0);
		expect(checkTorchUnsafeLoad("m = torch.load(p, weights_only = True)", "a.py")).toEqual([]);
	});

	it("returns [] for content with no torch.load call", () => {
		expect(checkTorchUnsafeLoad("m = joblib.load(p)", "a.py")).toEqual([]);
	});

	it("respects a bare `# noqa` suppression", () => {
		expect(checkTorchUnsafeLoad("m = torch.load(p)  # noqa", "a.py")).toEqual([]);
	});

	it("caps at MATCH_LIMIT with more occurrences than the cap", () => {
		const code = repeat("m = torch.load(p)", MATCH_LIMIT + 5);
		expect(checkTorchUnsafeLoad(code, "a.py").length).toBe(MATCH_LIMIT);
	});

	it("reports the exact line number and shape after preamble lines", () => {
		const code = ["# one", "# two", "m = torch.load(p)"].join("\n");
		expect(checkTorchUnsafeLoad(code, "a.py")).toEqual([{ line: 3, text: "m = torch.load(p)" }]);
	});

	it("anchors on the match's own line, not the total line count of the file, when trailing lines follow", () => {
		const code = ["m = torch.load(p)", "# trailing line one", "# trailing line two"].join("\n");
		expect(checkTorchUnsafeLoad(code, "a.py")).toEqual([{ line: 1, text: "m = torch.load(p)" }]);
	});

	it("trims and truncates the reported text", () => {
		const padding = "b2".repeat(70);
		const code = `   m = torch.load(p)  ${padding}`;
		expect(checkTorchUnsafeLoad(code, "a.py")).toEqual([{ line: 1, text: code.trim().slice(0, 150) }]);
	});
});

describe("checkPickleWrapperLoad — mutation hardening", () => {
	it("gates on .py/.pyi, test files, and vendored paths", () => {
		expect(checkPickleWrapperLoad("m = joblib.load(p)", "a.ts")).toEqual([]);
		expect(checkPickleWrapperLoad("m = joblib.load(p)", "test_foo.py")).toEqual([]);
		expect(checkPickleWrapperLoad("m = joblib.load(p)", "vendor/lib.py")).toEqual([]);
	});

	it("is whitespace-tolerant before the call parens for joblib.load and pd.read_pickle", () => {
		expect(checkPickleWrapperLoad("m = joblib.load  (p)", "a.py").length).toBeGreaterThan(0);
		expect(checkPickleWrapperLoad("m = pd.read_pickle  (p)", "a.py").length).toBeGreaterThan(0);
	});

	it("flags numpy.load only when allow_pickle=True is present, whitespace-tolerant", () => {
		expect(checkPickleWrapperLoad("arr = np.load(p)", "a.py")).toEqual([]);
		expect(checkPickleWrapperLoad("arr = np.load (p, allow_pickle=True)", "a.py").length).toBeGreaterThan(0);
		expect(checkPickleWrapperLoad("arr = np.load(p,   allow_pickle = True)", "a.py").length).toBeGreaterThan(0);
	});

	it("returns [] for content with no pickle-wrapper call", () => {
		expect(checkPickleWrapperLoad("x = json.load(f)", "a.py")).toEqual([]);
	});

	it("respects a bare `# noqa` suppression", () => {
		expect(checkPickleWrapperLoad("m = joblib.load(p)  # noqa", "a.py")).toEqual([]);
	});

	it("dedupes when a line matches both the direct and numpy patterns (only one entry per line)", () => {
		const code = "joblib.load(p); arr = np.load(q, allow_pickle=True)";
		expect(checkPickleWrapperLoad(code, "a.py").length).toBe(1);
	});

	it("caps at MATCH_LIMIT with more occurrences than the cap", () => {
		const code = repeat("m = joblib.load(p)", MATCH_LIMIT + 5);
		expect(checkPickleWrapperLoad(code, "a.py").length).toBe(MATCH_LIMIT);
	});

	it("reports the exact line number and shape after preamble lines", () => {
		const code = ["# one", "# two", "m = joblib.load(p)"].join("\n");
		expect(checkPickleWrapperLoad(code, "a.py")).toEqual([{ line: 3, text: "m = joblib.load(p)" }]);
	});

	it("anchors on the match's own line, not the total line count of the file, when trailing lines follow", () => {
		const code = ["m = joblib.load(p)", "# trailing line one", "# trailing line two"].join("\n");
		expect(checkPickleWrapperLoad(code, "a.py")).toEqual([{ line: 1, text: "m = joblib.load(p)" }]);
	});

	it("trims and truncates the reported text", () => {
		const padding = "c3".repeat(70);
		const code = `   m = joblib.load(p)  ${padding}`;
		expect(checkPickleWrapperLoad(code, "a.py")).toEqual([{ line: 1, text: code.trim().slice(0, 150) }]);
	});
});

// ===========================================================================
// Adversarial-audit finding (2026-08-01): `checkXmlExternalEntity` misses the
// `import lxml.etree` direct-import form entirely — a real detection gap, not
// just an untested branch. `XML_PARSE_CALL_RE` (the gate) DOES recognize
// `lxml.etree.parse(...)` / `lxml.etree.fromstring(...)` as a parse call, but
// the *import-line* regex that decides what to REPORT only recognizes
// `import xml.(etree|dom|sax)`, `from xml.(etree|dom|sax)`, and `from lxml`
// (i.e. `from lxml import etree`) — there is no alternative for a bare
// `import lxml.etree` / `import lxml`. A file that does
// `import lxml.etree` and then `lxml.etree.parse(untrusted)` is a textbook
// XXE-vulnerable pattern that this check silently passes over, while the
// semantically identical `from lxml import etree` + `etree.parse(...)` form
// IS correctly flagged. No test in this file (before or after the hardening
// pass) ever uses the direct `import lxml.etree` form, so this gap was
// invisible to the whole suite. `it.fails` documents it as a known defect —
// it will start reporting as an unexpected pass once the import-line regex
// grows an `import\s+lxml\b` (or `import\s+lxml\.etree`) alternative.
// ===========================================================================

describe("checkXmlExternalEntity — adversarial-audit finding: direct `import lxml.etree` is invisible", () => {
	it.fails("SHOULD flag `import lxml.etree` + `lxml.etree.parse(untrusted)` (currently misses it)", () => {
		const code = "import lxml.etree\n\ndef load(path):\n    return lxml.etree.parse(path)\n";
		expect(checkXmlExternalEntity(code, "app.py").length).toBeGreaterThan(0);
	});

	it.fails("SHOULD flag `import lxml.etree` + `lxml.etree.fromstring(untrusted)` (currently misses it)", () => {
		const code = "import lxml.etree\n\ndef parse_payload(data):\n    return lxml.etree.fromstring(data)\n";
		expect(checkXmlExternalEntity(code, "app.py").length).toBeGreaterThan(0);
	});

	it("control: the semantically identical `from lxml import etree` form IS flagged (proves this is a gap, not a design choice)", () => {
		const code = "from lxml import etree\n\ndef load(path):\n    return etree.parse(path)\n";
		expect(checkXmlExternalEntity(code, "app.py").length).toBeGreaterThan(0);
	});
});

// ===========================================================================
// Survivor-classification finding (mutation sweep, 2026-08-01): the checkId
// string passed to `lineHasNoqaSuppression` is CURRENTLY unobservable at 7
// call sites in this file (a StringLiteral -> "" mutant survives at each).
// For `checkShelveOpen` / `checkTorchUnsafeLoad` / `checkPickleWrapperLoad`
// this is genuine equivalence: no Bandit/Ruff flake8-bandit "S" code exists
// for shelve.open, torch.load, or the joblib/pandas/numpy pickle wrappers at
// all, so no correct fix to the map could ever make those call sites'
// checkId argument observable.
//
// For `checkMarshalLoad` and `checkYamlUnsafeLoad`, it is NOT equivalence —
// it is the SAME class of gap as the `import lxml.etree` finding above, one
// layer removed: `BANDIT_TO_CHECK_ID` (src/harness/checks/shared.ts) already
// maps S301 (pickle), S314/S320 (xml), S602/603 (subprocess), S307 (eval),
// S310 (urlopen), and S324 (hash) to their matching checkIds here, but has NO
// entry for S302 ("suspicious-marshal-usage") — the Ruff/Bandit code that
// corresponds exactly to the marshal detector. (S506, "unsafe-yaml-load", was
// added to the map by the 2026-10-21 adversarial review; its pins below are
// now plain `it`.) The marshal call site already passes the CORRECT checkId
// string; the gap is entirely in shared.ts's map, which is out of scope for
// this file/companion pair. `it.fails` documents it as a known defect,
// matching the convention above — it will start reporting an unexpected pass
// once shared.ts grows the S302 entry.
// ===========================================================================

describe("checkMarshalLoad — finding: noqa: S302 (Ruff/Bandit's marshal-usage code) is not recognized", () => {
	it.fails("SHOULD respect `# noqa: S302` as suppression, the same way S301 suppresses pickle", () => {
		expect(checkMarshalLoad("obj = marshal.loads(buf)  # noqa: S302", "a.py")).toEqual([]);
	});

	it("control: an unrelated mapped code (S602, subprocess) correctly does NOT suppress — proves the checkId-specificity mechanism itself works and this is a missing map entry, not a broken mechanism", () => {
		expect(checkMarshalLoad("obj = marshal.loads(buf)  # noqa: S602", "a.py").length).toBeGreaterThan(0);
	});
});

describe("checkYamlUnsafeLoad — noqa: S506 (Ruff/Bandit's unsafe-yaml-load code) is recognized (map entry added 2026-10-21)", () => {
	it("respects `# noqa: S506` on the yaml.unsafe_load form", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.unsafe_load(f)  # noqa: S506", "a.py")).toEqual([]);
	});

	it("respects `# noqa: S506` on the bare yaml.load form", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f)  # noqa: S506", "a.py")).toEqual([]);
	});

	it("control: an unrelated mapped code (S301, pickle) correctly does NOT suppress — proves this is a missing map entry, not a broken mechanism", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f)  # noqa: S301", "a.py").length).toBeGreaterThan(0);
	});
});

// ===========================================================================
// Survivor-classification findings (mutation sweep, 2026-08-01): the last 4
// survivors in this file (of 579 measured mutants) are genuine equivalents —
// no test can distinguish them because no input string produces a different
// boolean/observable result under the mutation. Each was verified two ways:
// (1) an algebraic argument about the surrounding control flow / regex
// grammar, and (2) an empirical replay — every assertion in this file that
// exercises the affected function, run against a transcribed mutated copy,
// still passes; see scratch/mutant-python-checks-final11-probe.mts (0
// failures across all four). No `it.fails` pairing here — unlike the
// checkId findings above, there is no missing feature that would ever make
// these observable; documented as characterization, not left silent.
//
//   - checkPyNoneEquality's Yoda-side alternative ends in a bare `\w+` with
//     nothing after it in the pattern. Mutating it to `\w` (drop the `+`)
//     is unobservable via `.test()`: both require "at least one word char
//     present here" (`\w+` backtracks to one; `\w` matches exactly one),
//     so a lone available char satisfies both, and zero available chars
//     satisfies neither. A trailing unanchored `X+` and `X` are the same
//     boolean atom.
//   - checkOsSystemTainted's call-argument pattern ends in a mandatory
//     `[A-Za-z_]` followed by an OPTIONAL `\w*`. Mutating the optional
//     group to `\W*` (negated class) is unobservable: `X*` always accepts
//     zero repetitions regardless of what X is, so the trailing group can
//     never affect whether the overall pattern matches — only the
//     mandatory `[A-Za-z_]` gates that.
//   - checkRegexInLoopNoCompile's `loopIndent` is initialized to -1 and
//     reset to -1 on dedent, but EVERY read of `loopIndent` is guarded by
//     `inLoop && …`, and the only place `inLoop` transitions false->true
//     (`for`/`while` detection) simultaneously assigns `loopIndent =
//     indent` — a fresh, real value. So neither the initial nor the reset
//     -1 is ever read before being overwritten; -1 vs +1 at either site is
//     dead payload, exhaustively (not just for this file's test cases).
// ===========================================================================

