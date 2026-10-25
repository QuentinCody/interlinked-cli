import assert from "node:assert/strict";
import test from "node:test";
import { fixtures } from "./fixtures.mjs";

test("development fixtures carry unique identities and source-grounded target fragments", () => {
    assert.equal(new Set(fixtures.map(fixture => fixture.id)).size, fixtures.length);
    assert(fixtures.length >= 8);
    for (const fixture of fixtures) {
        assert(fixture.evidence.length > 0);
        for (const claim of fixture.claims) {
            assert(claim.parts.length > 0);
            for (const part of claim.parts) assert(fixture.source.includes(part));
        }
    }
});
