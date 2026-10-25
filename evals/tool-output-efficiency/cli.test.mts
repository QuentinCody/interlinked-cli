import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
test("CLI retains exact bytes and supports full recovery without a model",()=>{
    const dir=mkdtempSync(join(tmpdir(),"output-cli-"));
    try {
        const input=join(dir,"input.txt"); const text="😀\r\n"+"sample line\n".repeat(100);
        writeFileSync(input,text);
        const run=(args:string[])=>spawnSync(process.execPath,["--import","tsx","evals/tool-output-efficiency/cli.mts",...args],{encoding:"utf8"});
        const captured=run(["capture","--store",dir,"--input",input,"--source","fixture","--version","v1","--call-id","c","--budget-chars","100"]);
        assert.equal(captured.status,0,captured.stderr);
        const view=JSON.parse(captured.stdout);
        assert.equal(view.mode,"baseline"); assert.ok(view.expand.includes(view.receiptId));
        const expanded=run(["expand","--store",dir,"--id",view.receiptId]);
        assert.equal(expanded.status,0,expanded.stderr); assert.equal(expanded.stdout,readFileSync(input,"utf8"));
        const bad=run(["expand","--store",dir,"--id","../input"]);
        assert.notEqual(bad.status,0);
    } finally { rmSync(dir,{recursive:true,force:true}); }
});

