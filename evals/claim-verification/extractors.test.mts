import assert from "node:assert/strict";
import test from "node:test";
import { legacyCandidates, spanCandidates, normalize, retains, spanValid } from "./extractors.mjs";

test("short claims and the thirteenth sentence survive without rewriting the source", () => {
    const source = "Tests pass. Build failed. " + "The parser inspection found no missing configuration entries. ".repeat(12) + "The final test suite passed all fourteen tests.";
    const candidates = spanCandidates(source);
    assert.equal(candidates.length, 15);
    assert.equal(legacyCandidates("Tests pass. Build failed.").length, 0);
    assert.equal(legacyCandidates(source).length, 12);
    assert(candidates.every(candidate => spanValid(source, candidate)));
    assert.equal(candidates.at(-1)?.text, "The final test suite passed all fourteen tests.");
});

test("Unicode, CRLF, repeated occurrences, negation and tables retain exact source locations", () => {
    const source = "🧬 cafe\u0301\r\n- Do not modify the public API.\r\nTests pass. Tests pass.\r\n| Result | 14 passed |\r\n| --- | --- |";
    const candidates = spanCandidates(source);
    assert(candidates.every(candidate => spanValid(source, candidate)));
    const repeated = candidates.filter(candidate => candidate.text === "Tests pass.");
    assert.equal(repeated.length, 2);
    assert.notDeepEqual(repeated[0]?.span, repeated[1]?.span);
    assert(retains(candidates, ["Do not modify the public API", "14 passed"]));
    assert.equal(candidates.filter(candidate => candidate.kind === "table").length, 1);
});

test("headings and fenced examples are not treated as prose candidates", () => {
    assert.deepEqual(spanCandidates("# Status\n```ts\nthrow new Error('failed');\n```\nTests pass.").map(candidate => candidate.text), ["Tests pass."]);
    assert.equal(normalize("**Tests**   `pass`."), "Tests pass.");
    assert.equal(spanValid("abc", { text: "abc", span: [-1, 3], kind: "sentence" }), false);
    assert.equal(spanValid("abc", { text: "abc", span: [0, 2], kind: "sentence" }), false);
});

test("Markdown table headers are context, not standalone claim candidates", () => {
    const source = "| Check | Result |\n| --- | --- |\n| Tests | 14 passed |";
    assert.deepEqual(spanCandidates(source).map(candidate => candidate.text), ["| Tests | 14 passed |"]);
});
