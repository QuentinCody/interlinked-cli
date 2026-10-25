import test from "node:test";
import assert from "node:assert/strict";
import { replayCase } from "./replay.mjs";
test("replay leaves its source intact and records a declared baseline",async()=>{
    const row={id:"c",category:"mixed",question:"target",text:"filler\n".repeat(1000)+"target evidence\n",blocks:[]};
    const result=await replayCase(row);
    assert.equal(result.text,row.text);
    assert.equal(result.views["head-tail"].mode,"head-tail");
    assert.equal(result.views.code.mode,"selected");
});

