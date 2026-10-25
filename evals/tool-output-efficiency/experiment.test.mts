import test from "node:test";
import assert from "node:assert/strict";
import { fixtures, evaluateView } from "./experiment.mjs";
import { selectOutput } from "./selection.mjs";
test("fixture evidence is present and full expansion recovers every required passage",async()=>{
    for(const fixture of fixtures()){
        assert.ok(fixture.required.every(text=>fixture.receipt.text.includes(text)));
        const view=await selectOutput(fixture.receipt,{full:true,budgetChars:100},async()=>({}));
        assert.equal(evaluateView(fixture,view).recall,1);
    }
});

