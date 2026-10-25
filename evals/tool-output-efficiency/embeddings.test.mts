import test from "node:test";
import assert from "node:assert/strict";
import { parseVectors } from "./embeddings.mjs";
test("embedding envelopes require one finite vector per input",()=>{
    assert.deepEqual(parseVectors({success:true,result:{data:[[1,0],[0,1]]}},2),[[1,0],[0,1]]);
    assert.throws(()=>parseVectors({success:true,result:{data:[[1,0]]}},2));
    assert.throws(()=>parseVectors({success:true,result:{data:[[1,NaN]]}},1));
});
