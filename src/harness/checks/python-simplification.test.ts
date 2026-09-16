import { describe, expect, it } from "vitest";
import { checkPythonSimplification, checkPythonTrivialHelper } from "./python-simplification.js";

describe("bounded Python design advice", () => {
    it("MUST-FIRE: locates the redundant statement rather than blaming its enclosing block", () => {
        expect(checkPythonSimplification("for item in items:\n    print(item)\n    continue\n", "code.py")[0]?.line).toBe(3);
        expect(checkPythonSimplification("def f(x):\n    if x:\n        return 1\n    elif x is None:\n        return 2\n", "code.py")[0]?.line).toBe(4);
    });
    it("MUST-NOT-FIRE: conditional continue, useful validation, dataclasses, comments or strings", () => {
        const source = 'from dataclasses import dataclass\n@dataclass\nclass Value:\n    value: int\n\ndef read(x):\n    if not isinstance(x, int):\n        raise ValueError("invalid")\n    return x, None\n\nfor x in items:\n    if x:\n        continue\n    print(x)\n# ---- public section ----\n';
        expect(checkPythonSimplification(source, "code.py")).toEqual([]);
    });
    it("reviews private forwarding while preserving named domain rules and public helpers", () => {
        expect(checkPythonTrivialHelper("def _process_data(x):\n    return transform(x)\nanswer = _process_data(data)\n", "code.py")).toHaveLength(1);
        expect(checkPythonTrivialHelper("def eligible_for_refund(x):\n    return policy(x)\nanswer = eligible_for_refund(data)\n", "code.py")).toEqual([]);
        expect(checkPythonTrivialHelper("def _process_data(x):\n    return transform(x)\nregister(_process_data)\n", "code.py")).toEqual([]);
        expect(checkPythonTrivialHelper("@boundary\ndef _process_data(x):\n    return transform(x)\nanswer = _process_data(data)\n", "code.py")).toEqual([]);
    });
    it("flags forwarding a large shared parameter set", () => {
        expect(checkPythonSimplification("def dispatch(a,b,c,d,e,f,g):\n    return target(a,b,c,d,e,f,g)\n", "code.py")[0]?.text).toContain("state ownership");
    });
    it("reports parse missingness and ignores other languages", () => {
        expect(checkPythonSimplification("def broken(", "code.py")[0]?.text).toContain("NOT CHECKED");
        expect(checkPythonSimplification("def broken(", "code.ts")).toEqual([]);
    });
});
