import { expect, it } from "vitest";
import { CATALOG, questionSet, selectEvidence } from "./contracts.js";

it("selects only declared evidence and distinguishes absent from empty", () => {
    expect(selectEvidence({ body: "code", tests: [] }, ["/body", "/tests"])).toEqual({
        body: "code",
        tests: [],
    });
    expect(() => selectEvidence({ body: "code" }, ["/tests"])).toThrow(/missing evidence/);
    expect(selectEvidence({ "a/b": { "~x": false } }, ["/a~1b/~0x"])).toEqual({ "~x": false });
    expect(() => selectEvidence({}, ["/__proto__"])).toThrow();
});

it("compiles contracts into ThinkThen question sets", () => {
    expect(questionSet([CATALOG.name_matches!], [0.2, 0.8])).toMatchObject({
        version: 1,
        threshold: "0.2:0.8",
        questions: { name_matches: { on: ["/signature", "/body"] } },
    });
    for (const q of Object.values(CATALOG)) {
        expect(q.validation.length).toBeGreaterThan(5);
        expect(q.version).toBe("1");
        expect(q.population).toBeTruthy();
    }
});
