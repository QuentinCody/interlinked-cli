import test from "node:test";
import assert from "node:assert/strict";
import { codeScores, vectorShortlist, projectJson } from "./adapters.mjs";
import { splitBlocks } from "./selection.mjs";
test("log adapter retains failures and runner summaries",()=>{
    const blocks=splitBlocks("PASS one\n".repeat(20)+"Tests: 1 failed, 20 passed\n");
    const scores=codeScores("test_build",blocks,"failure");
    assert.ok((scores[blocks.at(-1)!.id] ?? 0)>(scores[blocks[0]!.id] ?? 0));
});
test("embedding retrieval validates vectors and retains explicit pins",()=>{
    assert.deepEqual(vectorShortlist([1,0],{a:[1,0],b:[0,1]},1,["b"]),["a","b"]);
    assert.throws(()=>vectorShortlist([1,0],{bad:[1]},1,[]));
});
test("JSON projection reports omissions and keeps literal types",()=>{
    assert.deepEqual(projectJson('{"count":0,"next":null,"unused":false}',["count","next"]),{value:{count:0,next:null},omittedFields:1});
    assert.throws(()=>projectJson("[1,2]",["count"]));
});
