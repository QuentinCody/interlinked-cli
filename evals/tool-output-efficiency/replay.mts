import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codeScores, type Category } from "./adapters.mjs";
import { headTail, selectOutput, type View } from "./selection.mjs";
interface Case { id:string; category:string; question:string; text:string; blocks:unknown[]; }
export async function replayCase(row: Case) {
    const receipt={id:row.id,text:row.text,source:"native-transcript",version:"frozen",callId:row.id};
    const baseline: View={receiptId:row.id,source:receipt.source,version:receipt.version,capturedComplete:null,
        mode:"head-tail",baseline:headTail(row.text,4000),expand:"available",offsets:"UTF-16"};
    const code=await selectOutput(receipt,{question:row.question,budgetChars:4000,minChars:0},
        (blocks,question)=>Promise.resolve(codeScores(row.category as Category,blocks,question)));
    const pinned=await selectOutput(receipt,{question:row.question,budgetChars:4000,minChars:0},
        async blocks=>Object.fromEntries(blocks.map((block,i)=>[block.id,1-Math.min(i,blocks.length-1-i)/Math.max(1,blocks.length)])));
    const native: View={...baseline,mode:"as-delivered",fullText:row.text}; delete native.baseline;
    return {...row,views:{native,"head-tail":baseline,"head-tail+pinned":pinned,code}};
}
async function main() {
    const input=process.argv[2]; const output=process.argv[3];
    if(!input || !output) throw new Error("Usage: replay.mts INPUT_JSONL NEW_OUTPUT_JSONL");
    const writer=createWriteStream(output,{flags:"wx",mode:0o600});
    let count=0;
    try {
        for await(const line of jsonLines(input)){
            let row: Case;
            try { row=JSON.parse(line) as Case; }
            catch { throw new Error("Invalid replay JSON at record " + (count + 1)); }
            if(!writer.write(JSON.stringify(await replayCase(row))+"\n")) await once(writer,"drain");
            count++;
        }
    } finally { writer.end(); await once(writer,"finish"); }
    console.log(JSON.stringify({replayed:count}));
}
async function* jsonLines(path: string): AsyncGenerator<string> {
    let pending = "";
    for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end); pending = pending.slice(end + 1);
            if (line) yield line;
        }
    }
    if (pending) throw new Error("Incomplete trailing replay record");
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
