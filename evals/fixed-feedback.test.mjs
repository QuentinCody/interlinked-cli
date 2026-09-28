import { test } from "node:test";
import assert from "node:assert/strict";
import { denied } from "./fixed-feedback.mjs";
test("recognizes native permission denials and post-tool blocks", () => {
    assert.equal(denied({ code: 0, stdout: '{"hookSpecificOutput":{"permissionDecision":"deny"}}' }), true);
    assert.equal(denied({ code: 0, stdout: '{"decision":"block"}' }), true);
    assert.equal(denied({ code: 0, stdout: '{}' }), false);
    assert.equal(denied({ code: 2, stdout: '' }), true);
});
