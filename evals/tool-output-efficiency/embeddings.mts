import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtures, evaluateView } from "./experiment.mjs";
import { splitBlocks, selectOutput } from "./selection.mjs";
import { vectorShortlist } from "./adapters.mjs";
import { decisionScores } from "./decision.mjs";
import { createLoggedClient } from "../claim-verification/eval-client.mjs";
import { resolveApiKey } from "../../src/harness/policy-classifier.js";
export function parseVectors(raw: unknown, expected: number): number[][] {
    const envelope=raw as {success?:boolean;result?:{data?:unknown}};
    const data=envelope?.result?.data;
    if(envelope?.success!==true || !Array.isArray(data) || data.length!==expected ||
        data.some(vector=>!Array.isArray(vector) || !vector.length || !vector.every(v=>typeof v==="number" && Number.isFinite(v)))) {
        throw new Error("Malformed embedding response");
    }
    const vectors=data as number[][];
    if(vectors.some(v=>v.length!==vectors[0]?.length)) throw new Error("Inconsistent vector dimensions");
    return vectors;
}
async function requestVectors(directory: string, account: string, token: string, texts: string[]) {
    const start=performance.now();
    const response=await fetch("https://api.cloudflare.com/client/v4/accounts/"+encodeURIComponent(account)+"/ai/run/@cf/baai/bge-small-en-v1.5",
        {method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
            body:JSON.stringify({text:texts}),signal:AbortSignal.timeout(30_000)});
    const raw: unknown=await response.json();
    writeFileSync(join(directory,"embedding-call.json"),JSON.stringify({model:"@cf/baai/bge-small-en-v1.5",
        request:{text:texts},response:raw,httpStatus:response.status,latencyMs:performance.now()-start,costUsd:null},null,2),{flag:"wx",mode:0o600});
    if(!response.ok) throw new Error("Embedding HTTP "+response.status);
    const vectors=parseVectors(raw,texts.length);
    return new Map(texts.map((text,i)=>[text,vectors[i]!]));
}

async function evaluateCases(cases: ReturnType<typeof fixtures>, indexed: Map<string, number[]>,
    client: ReturnType<typeof createLoggedClient>) {
    const results=[];
    for(const fixture of cases){
        const blocks=splitBlocks(fixture.receipt.text);
        const shortlist=vectorShortlist(indexed.get(fixture.question)!,Object.fromEntries(blocks.map(b=>[b.id,indexed.get(b.text)!])),4,blocks.filter(b=>b.mandatory).map(b=>b.id));
        for(const arm of ["embedding","embedding+jev"]){
            const started=performance.now();
            const view=await selectOutput(fixture.receipt,{question:fixture.question,budgetChars:2600,minChars:0},async all=>{
                const scores=Object.fromEntries(all.map(b=>[b.id,0]));
                if(arm==="embedding") shortlist.forEach((id,i)=>{scores[id]=1-i/(shortlist.length+1);});
                else Object.assign(scores,await decisionScores(all.filter(b=>shortlist.includes(b.id)),fixture.question,(state,questions)=>client.ask(state,questions)));
                return scores;
            });
            results.push({fixture:fixture.id,arm,...evaluateView(fixture,view),latencyMs:performance.now()-started,view});
        }
    }
    return results;
}

async function main() {
    const directory=process.argv[2]; const account=process.argv[3];
    if(!directory || !account) throw new Error("Usage: embeddings.mts NEW_OUTPUT_DIRECTORY ACCOUNT_ID");
    mkdirSync(directory,{recursive:false});
    const token=process.env.CLOUDFLARE_API_TOKEN ?? execFileSync("python3",["-c",
        "import pathlib,tomllib;print(tomllib.loads((pathlib.Path.home()/'.cf/config.toml').read_text())['access_token'])"],{encoding:"utf8",maxBuffer:65536}).trim();
    const cases=fixtures(); const texts=[...new Set(cases.flatMap(c=>[c.question,...splitBlocks(c.receipt.text).map(b=>b.text)]))];
    const indexed=await requestVectors(directory,account,token,texts);
    const key=resolveApiKey("TYPESAFE_API_KEY");
    if(!key) throw new Error("Missing TYPESAFE_API_KEY");
    const client=createLoggedClient({apiKey:key,maxSpendUsd:0.25,save:(name,value)=>writeFileSync(join(directory,name),JSON.stringify(value,null,2),{flag:"wx"})});
    const results=await evaluateCases(cases,indexed,client);
    writeFileSync(join(directory,"results.json"),JSON.stringify({results,spend:client.spend(),embeddingCostUsd:null,
        limitation:"Authored controls; embedding checkpoint alias is not an immutable provider revision."},null,2),{flag:"wx"});
    console.log(JSON.stringify({cases:cases.length,embeddingRequests:1,decisionCalls:client.spend().calls}));
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
