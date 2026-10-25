import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codeScores, type Category } from "./adapters.mjs";
import { decisionScores } from "./decision.mjs";
import { headTail, selectOutput, type Receipt, type View } from "./selection.mjs";
import { createLoggedClient } from "../claim-verification/eval-client.mjs";
import { resolveApiKey } from "../../src/harness/policy-classifier.js";
interface Fixture { id: string; category: Category; question: string; required: string[]; receipt: Receipt; }
export function fixtures(): Fixture[] {
    const examples: Array<[Category,string,string[]]> = [
        ["mixed","How many additional attempts are allowed after the first attempt, and which cases are excluded?",
            ["The retry limit is three additional attempts after the initial attempt.", "Authentication failures are never retried."]],
        ["file_reads","Which rule determines whether the caller may update a record?",
            ["if (record.ownerId !== actor.id) return denied();", "Administrators may update records belonging to other users."]],
        ["search","Where are expired sessions removed?",
            ["src/session-cleanup.ts:42: await store.removeExpired(now);", "src/session-cleanup.ts:43: // Active leases postpone removal."]],
        ["test_build","What failed in the test run?",
            ["FAIL permissions.test.ts: expected denial, received success", "Tests: 1 failed, 72 passed; exit code 1"]],
        ["structured_data","What is the next page token and how many records are available?",
            ['"next_cursor": "page-7",', '"total": 814,']],
        ["history","Which execution checked this exact source revision?",
            ["receipt r17: command npm test; source revision abc123; completed", "receipt r17: 14 passed, 0 failed; test selection permissions"]],
    ];
    return examples.flatMap(([category,question,required],example) => [0,1].map(variant => {
        const filler = (section:number) => Array.from({length:16},(_,i)=>"section "+section+" entry "+i+": informational progress for unrelated packaging assets.").join("\n")+"\n";
        const parts = Array.from({length:10},(_,i)=>filler(i));
        parts[variant ? 6 : 3] = required[0] + "\n" + filler(20).split("\n").slice(0,15).join("\n") + "\n";
        parts[variant ? 8 : 5] = required[1] + "\n" + filler(21).split("\n").slice(0,15).join("\n") + "\n";
        const id = category+"-"+variant;
        return {id,category,question,required,receipt:{id,text:parts.join(""),source:"synthetic:"+example,version:"v1",callId:id,capturedComplete:true}};
    }));
}
export function evaluateView(fixture: Fixture, view: View) {
    const text = view.fullText ?? view.baseline ?? view.spans?.map(span=>span.text).join("\n") ?? "";
    const retained = fixture.required.filter(passage=>text.includes(passage)).length;
    return { recall: retained/fixture.required.length, retained, required: fixture.required.length,
        contentChars: text.length, responseChars: JSON.stringify(view).length, mode:view.mode, omittedChars:view.omittedChars ?? null };
}
export async function runExperiment(directory: string, live: boolean): Promise<void> {
    mkdirSync(directory,{recursive:false});
    const cases=fixtures(); writeFileSync(join(directory,"fixtures.json"),JSON.stringify(cases,null,2),{flag:"wx"});
    const key=live ? resolveApiKey("TYPESAFE_API_KEY") : null;
    const client=key ? createLoggedClient({apiKey:key,maxSpendUsd:0.25,save:(name,value)=>writeFileSync(join(directory,name),JSON.stringify(value,null,2),{flag:"wx"})}) : null;
    const results: unknown[]=[];
    for(const fixture of cases){
        const baseline=headTail(fixture.receipt.text,2600);
        const rawView: View={receiptId:fixture.id,source:fixture.receipt.source,version:"v1",capturedComplete:true,mode:"head-tail",baseline,expand:"available",offsets:"UTF-16"};
        results.push({fixture:fixture.id,arm:"head-tail",...evaluateView(fixture,rawView),view:rawView});
        for(const arm of client ? ["code","jev"] : ["code"]){
            const start=performance.now();
            const view=await selectOutput(fixture.receipt,{question:fixture.question,budgetChars:2600,minChars:0,baseline},
                (blocks,question)=>arm==="code" ? Promise.resolve(codeScores(fixture.category,blocks,question)) : decisionScores(blocks,question,(state,questions)=>client!.ask(state,questions)));
            results.push({fixture:fixture.id,arm,...evaluateView(fixture,view),latencyMs:performance.now()-start,view});
        }
        console.log(JSON.stringify({fixture:fixture.id,complete:true}));
    }
    writeFileSync(join(directory,"results.json"),JSON.stringify({kind:"authored_controls",results,spend:client?.spend() ?? null,
        model:client ? "jev-1.13.0" : null,embeddingArm:"not run: requires actual embedding vectors",liveTaskSuccess:null},null,2),{flag:"wx"});
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    const directory=process.argv[2];
    if(!directory) throw new Error("Usage: experiment.mts NEW_OUTPUT_DIRECTORY [--jev]");
    await runExperiment(directory,process.argv.includes("--jev"));
}

