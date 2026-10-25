// Independent adversarial review of `ubs_py_none_equality` (pre_block).
// Each negative is idiomatic Python a reviewer would accept; each positive
// pins that the refinement did not widen the exemption past the real defect.

import { describe, expect, it } from "vitest";
import { checkPyNoneEquality } from "../../checks/ubs-language-specific/python-checks.js";

const fires = (src: string): number => checkPyNoneEquality(src, "pkg/mod.py").length;

describe("ubs_py_none_equality — negative (must not fire)", () => {
	it("N1: a multi-line docstring whose prose mentions `x == None`", () => {
		const src =
			'def f(x):\n    """Return True when the value is unset.\n\n    Unlike x == None, this does not call __eq__.\n    """\n    return x is None\n';
		expect(fires(src)).toBe(0);
	});

	it("N2: a multi-line ''' docstring mentioning `value == None`", () => {
		const src = "def f(x):\n    '''Docs.\n    Avoid value == None in user code.\n    '''\n    return x\n";
		expect(fires(src)).toBe(0);
	});

	it("N3: a raw r\"\"\" docstring mentioning `x == None`", () => {
		const src = 'def f(x):\n    r"""Regex docs.\n    pattern: x == None\n    """\n    return x\n';
		expect(fires(src)).toBe(0);
	});

	it("N4: a module-qualified SQLAlchemy model column `models.User.deleted_at == None`", () => {
		const src = "rows = session.query(models.User).filter(models.User.deleted_at == None).all()\n";
		expect(fires(src)).toBe(0);
	});

	it("N5: an aliased-module model column `m.Order.cancelled_at != None`", () => {
		const src = "from app import models as m\nq = q.filter(m.Order.cancelled_at != None)\n";
		expect(fires(src)).toBe(0);
	});

	it("N6: SQLAlchemy Core `table.columns.email == None` (alias of `table.c`)", () => {
		const src = "stmt = select(users).where(users.columns.email == None)\n";
		expect(fires(src)).toBe(0);
	});

	it("N7: a `\"\"\"` inside an ordinary string does not unbalance a later docstring", () => {
		const src = "SEP = '\"\"\"'\ndef g(x):\n    \"\"\"Docs\n    x == None is wrong\n    \"\"\"\n    return x\n";
		expect(fires(src)).toBe(0);
	});
});

describe("ubs_py_none_equality — positive (must fire)", () => {
	it("P1: an instance attribute `self.cache == None` stays flagged", () => {
		expect(fires("if self.cache == None:\n    self.cache = {}\n")).toBe(1);
	});

	it("P2: a lowercase dotted chain with no model segment `record.parent.child == None`", () => {
		expect(fires("if record.parent.child == None:\n    pass\n")).toBe(1);
	});

	it("P3: code after a closed multi-line docstring is still scanned", () => {
		const src = 'def f(x):\n    """Docs.\n    More.\n    """\n    return x == None\n';
		expect(checkPyNoneEquality(src, "pkg/mod.py").map((m) => m.line)).toEqual([5]);
	});

	it("P4: a line mixing a model column and a plain name still fires", () => {
		expect(fires("ok = User.email == None and value == None\n")).toBe(1);
	});
});
