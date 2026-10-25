import test from "node:test";
import assert from "node:assert/strict";
import { selectOutput, splitBlocks, headTail, type Receipt } from "./selection.mjs";
const receipt: Receipt = { id: "x", text: "first\n".repeat(30)+"ERROR: failed authentication\n"+"last\n".repeat(30),
    source: "log", version: "v1", callId: "c", capturedComplete: true };
test("no question, small output, and full requests never invoke the scorer", async () => {
    const scorer = async () => { throw new Error("must not be called"); };
    assert.equal((await selectOutput(receipt,{budgetChars:80,baseline:"native bounded result"},scorer)).baseline, "native bounded result");
    assert.equal((await selectOutput(receipt,{question:"why?",budgetChars:80,full:true},scorer)).fullText,receipt.text);
    assert.equal((await selectOutput({...receipt,text:"small"},{question:"why?",budgetChars:80},scorer)).fullText,"small");
});
test("failure blocks survive a low score and budget overflow stays explicit", async () => {
    const result = await selectOutput(receipt,{question:"why?",budgetChars:40,minChars:0},async blocks => Object.fromEntries(blocks.map(b=>[b.id,0])));
    assert.ok(result.spans?.some(s=>s.text.includes("ERROR:")));
    assert.equal(result.budgetExceeded,true);
    for(const span of result.spans ?? []) assert.equal(receipt.text.slice(span.start,span.end),span.text);
    assert.ok((result.omittedBlocks ?? 0)>0);
});
test("missing or invalid model scores fall back to the declared baseline",async()=>{
    const result = await selectOutput(receipt,{question:"why?",budgetChars:80,minChars:0,baseline:"known baseline"},async()=>({}));
    assert.equal(result.baseline,"known baseline");
    assert.equal(result.mode,"fallback");
    assert.ok(result.spans?.some(span=>span.text.includes("ERROR:")));
});
test("head/tail never splits a Unicode surrogate pair",()=>{
    for(const ch of headTail("😀abc😀",1)) {
        const point=ch.codePointAt(0)!;
        assert.ok(point<0xD800 || point>0xDFFF);
    }
});
test("blocks retain contiguous offsets, Unicode and line endings",()=>{
    const text="😀".repeat(2000)+"\r\nend";
    assert.equal(splitBlocks(text).map(b=>b.text).join(""),text);
});
test("nonzero structured exit codes remain visible and incomplete capture stays unknown", async()=>{
    const input={...receipt,text:'{"exit_code":2,"output":""}\n'+"unrelated\n".repeat(100),capturedComplete:false};
    const result=await selectOutput(input,{question:"result?",budgetChars:40,minChars:0},async blocks=>Object.fromEntries(blocks.map(b=>[b.id,0])));
    assert.equal(result.capturedComplete,false);
    assert.ok(result.spans?.some(span=>span.text.includes('"exit_code":2')));
});

