import test from "node:test";
import assert from "node:assert/strict";
import { decisionScores } from "./decision.mjs";
import { splitBlocks } from "./selection.mjs";
test("decision scoring uses independent evidence and exception questions",async()=>{
    let count=0;
    const ask=async(_state:unknown,questions:Record<string,unknown>)=>{
        count=Object.keys(questions).length;
        return {model:"jev-1.13.0",answers:Object.fromEntries(Object.keys(questions).map(k=>[k,{type:"noul",noul:k.startsWith("exception")?0.9:0.1}]))};
    };
    const blocks=splitBlocks("Retry three times except authentication failures.");
    const scores=await decisionScores(blocks,"How many retries?",ask);
    assert.equal(count,2); assert.equal(scores[blocks[0]!.id],0.9);
});
test("malformed probabilities and missing answers are errors",async()=>{
    await assert.rejects(()=>decisionScores(splitBlocks("evidence"),"question",async()=>({answers:{}})));
});

