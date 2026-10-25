"""Replay the declared head/tail baseline and local lexical selector on saved blocks."""
import collections, json, re, sys
from pathlib import Path
from native import events
from tokens import digest, serialize, tokens
def head_tail_retained(offset,length,total,budget):
    return offset+length<= (budget+1)//2 or offset>=total-budget//2
def summary_metrics(rows):
    used=sum(r["tokens"] for r in rows if r["used"])
    retained=sum(r["tokens"] for r in rows if r["used"] and r["retained"])
    return {"used_token_recall":retained/used if used else None,"omitted_used_tokens":used-retained}
def prepare(run_dir,out_dir):
    out_dir.mkdir(exist_ok=False)
    manifest=json.loads((run_dir/"manifest.json").read_text())
    by_session=collections.defaultdict(lambda:collections.defaultdict(list))
    with (run_dir/"blocks.jsonl").open() as handle:
        for line in handle:
            block=json.loads(line)
            if block["primary"]: by_session[block["actor"]][(block["line"],block["call"])].append(block)
    cases=0
    with (out_dir/"cases.jsonl").open("x") as writer:
        for item in manifest["files"]:
            if not item["primary"]: continue
            actor=item["provider"]+":"+item["id"]; groups=by_session[actor]
            candidates=[key for key,bs in groups.items() if sum(b["length"] for b in bs)>6000]
            selected=set(sorted(candidates,key=lambda k:digest(serialize([actor,k])))[:8])
            for event in events(item):
                if event["kind"]!="output" or (event["line"],event["call"]) not in selected: continue
                bs=groups[(event["line"],event["call"])]
                if any(digest(event["text"][b["offset"]:b["offset"]+b["length"]])!=b["sha256"] for b in bs):
                    raise ValueError("Source changed since frozen measurement")
                writer.write(serialize({"id":actor+":"+str(event["line"]),"category":event["category"],"text":event["text"],
                    "question":serialize(event["args"])[:2000],"blocks":bs})+"\n"); cases+=1
    print(json.dumps({"prepared_cases":cases,"query":"tool arguments, NOT known agent intent"}))
def summarize(directory, filename="replayed.jsonl"):
    groups=collections.defaultdict(collections.Counter); totals=collections.defaultdict(collections.Counter)
    with (directory/filename).open() as handle:
        for line in handle:
            case=json.loads(line)
            units=[0]
            for character in case["text"]: units.append(units[-1]+(2 if ord(character)>65535 else 1))
            for arm,view in case["views"].items():
                content=view.get("baseline") or view.get("fullText") or "".join(s["text"] for s in view.get("spans",[]))
                spans=view.get("spans",[])
                rows=[]
                for block in case["blocks"]:
                    start=units[block["offset"]]; end=units[block["offset"]+block["length"]]
                    retained=(arm=="native" or head_tail_retained(start,end-start,units[-1],4000)) if arm in ("native","head-tail") else any(s["start"]<=start and s["end"]>=end for s in spans)
                    rows.append({**block,"retained":retained})
                metrics=collections.Counter(cases=1,original_tokens=tokens(case["text"]),response_tokens=tokens(case["text"]) if arm=="native" else tokens(serialize(view)),
                    content_tokens=tokens(content),used_tokens=sum(b["tokens"] for b in rows if b["used"]),
                    retained_used_tokens=sum(b["tokens"] for b in rows if b["used"] and b["retained"]),
                    omitted_used_tokens=sum(b["tokens"] for b in rows if b["used"] and not b["retained"]))
                metrics["outputs_needing_expansion"]=int(metrics["omitted_used_tokens"]>0)
                metrics["outputs_budget_exceeded"]=int(view.get("budgetExceeded",False))
                totals[arm].update(metrics); groups[case["category"]+":"+arm].update(metrics)
    result={"totals":dict(totals),"categories":dict(groups),"limitations":["Offline recall proxy; no agent actions changed.",
        "Tool arguments used as a query proxy, not an explicit read purpose.","Head/tail is a declared fallback, not a verified native formatter.",
        "Expansion demand is inferred from later-use matches, not observed expansion behavior."]}
    (directory/"summary.json").write_text(json.dumps(result,indent=2)); print(json.dumps(result))
if __name__=="__main__":
    if sys.argv[1]=="prepare": prepare(Path(sys.argv[2]),Path(sys.argv[3]))
    elif sys.argv[1]=="summarize": summarize(Path(sys.argv[2]),sys.argv[3] if len(sys.argv)>3 else "replayed.jsonl")
