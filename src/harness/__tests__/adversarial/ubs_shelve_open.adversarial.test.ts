// Independent adversarial review (2026-10-21) of `ubs_shelve_open`, a
// pre_block check. Each negative case is legitimate Python the original
// line regex blocked. Probe: scratch/2026-10-21-adversarial/ubs_shelve_open.probe.mts.

import { describe, expect, it } from "vitest";
import { checkShelveOpen } from "../../checks/ubs-language-specific.js";

const lines = (...parts: string[]): string => parts.join("\n");

describe("ubs_shelve_open — negative (must not fire)", () => {
	it("N1: a multi-line function docstring that mentions shelve.open(path)", () => {
		const code = lines(
			"def load(path):",
			'    """Load the cache.',
			"",
			"    Earlier versions used shelve.open(path); this one reads JSON.",
			'    """',
			"    return json.load(open(path))",
		);
		expect(checkShelveOpen(code, "src/store.py")).toEqual([]);
	});

	it("N2: a module docstring with a 'do not do this' code example", () => {
		const code = lines(
			'"""Key-value helpers.',
			"",
			"Do not do this::",
			"",
			"    with shelve.open(p) as d:",
			"        d['k'] = v",
			'"""',
			"import sqlite3",
		);
		expect(checkShelveOpen(code, "src/store.py")).toEqual([]);
	});

	it("N3: Bandit's bare `# nosec`", () => {
		expect(checkShelveOpen("d = shelve.open(p)  # nosec", "src/store.py")).toEqual([]);
	});

	it("N4: an object attribute named shelve is not the module", () => {
		expect(checkShelveOpen("self.shelve.open(path)", "src/store.py")).toEqual([]);
	});

	it("N5: a textwrap.dedent triple-quoted code sample", () => {
		const code = lines("SAMPLE = textwrap.dedent('''", "    import shelve", '    db = shelve.open("cache")', "''')");
		expect(checkShelveOpen(code, "src/docs_gen.py")).toEqual([]);
	});

	it("N6: a one-line triple-quoted help string with quotes inside", () => {
		const code = lines("HELP = '''Usage: don't call shelve.open(\"x\")'''", "db = sqlite3.connect(p)");
		expect(checkShelveOpen(code, "src/docs_gen.py")).toEqual([]);
	});

	it("N7: ruff's `# noqa: S301` (suspicious-pickle-usage lists shelve.open)", () => {
		const code = "db = shelve.open(CACHE_PATH)  # noqa: S301 -- private per-user cache";
		expect(checkShelveOpen(code, "src/cache.py")).toEqual([]);
	});

	it("N8: Bandit's `# nosec B301`", () => {
		expect(checkShelveOpen("db = shelve.open(CACHE_PATH)  # nosec B301", "src/cache.py")).toEqual([]);
	});

	it("N9: a docstring with an odd number of double quotes inside", () => {
		const code = lines("def g():", '    """Say "hi.', "", "    Never shelve.open(p) here.", '    """');
		expect(checkShelveOpen(code, "src/store.py")).toEqual([]);
	});
});

describe("ubs_shelve_open — positive (must fire)", () => {
	it("P1: a real call after a one-line docstring with an apostrophe", () => {
		const code = lines("def f():", '    """Don\'t."""', "    pass", "", "d = shelve.open(path)");
		expect(checkShelveOpen(code, "src/store.py")).toEqual([{ line: 5, text: "d = shelve.open(path)" }]);
	});

	it("P2: an unrelated Bandit code does not suppress", () => {
		expect(checkShelveOpen("db = shelve.open(CACHE_PATH)  # noqa: S602", "src/cache.py")).toHaveLength(1);
		expect(checkShelveOpen("db = shelve.open(CACHE_PATH)  # nosec B602", "src/cache.py")).toHaveLength(1);
	});

	it("P3: a call after a multi-line docstring", () => {
		const code = lines('"""Cache.', "", 'Uses a shelf."""', "d = shelve.open(tmp_path / 'db')");
		expect(checkShelveOpen(code, "src/fixtures.py")).toEqual([{ line: 4, text: "d = shelve.open(tmp_path / 'db')" }]);
	});
});
