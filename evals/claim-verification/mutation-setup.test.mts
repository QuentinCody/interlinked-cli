import assert from "node:assert/strict";
import test from "node:test";
import { enumerateMutants, rankMutants } from "./mutation-setup.mjs";

test("enumeration ignores numbers in comments and strings and retains exact changed spans", () => {
    const source = "// timeout 999\nconst label = '123';\nconst limit = 3;\nfunction read() { return limit; }";
    const mutants = enumerateMutants(source);
    assert.equal(mutants.length, 4);
    for (const m of mutants) {
        assert.equal(source.slice(m.start, m.end), m.before);
        assert.equal(m.source, source.slice(0, m.start) + m.after + source.slice(m.end));
        assert(m.source.includes("timeout 999")); assert(m.source.includes("'123'"));
    }
    assert.equal(new Set(mutants.map(m => m.id)).size, mutants.length);
});

test("both rankings use the identical pool and seeded random order is reproducible", () => {
    const pool = enumerateMutants("const limit = 3; function read() { return limit; }");
    const random = rankMutants(pool, "random", "seed"); const heuristic = rankMutants(pool, "heuristic", "seed");
    assert.deepEqual(random.map(m => m.id).sort(), heuristic.map(m => m.id).sort());
    assert.deepEqual(random, rankMutants(pool, "random", "seed"));
    assert.equal(heuristic[0]?.operator, "return_undefined");
});
