"""Frozen, local-only session measurement. Run from this folder or the repo root."""
import argparse, collections, hashlib, json, os, re, resource, sqlite3, time
from pathlib import Path
from classify import commands, edited_paths
from native import events
from tokens import blocks, digest, normalized_line, paths, serialize, shingles, tokens
BASE = Path(__file__).resolve().parent
PROJECT = str(BASE.parents[1])
def later_use(text, named, quoted, edited, executed):
    if (paths(text) | named) & edited: return True
    if any(s in quoted for s in shingles(text)): return True
    for line in text.splitlines():
        command = re.sub(r"^\s*[$>]\s*", "", line.strip()).strip(chr(96))
        if command in executed and command: return True
    return False
def repeat_kind(prior, epoch, output_id, other):
    if prior and prior[1] == output_id: return "within_output"
    if prior: return "same_epoch" if prior[0] == epoch else "across_compaction"
    return "between_agents" if other else "first"
def choose_winner(categories):
    return sorted(categories, key=lambda k: (-categories[k]["unused_tokens"], k))[0]
def session_identity(provider, path):
    with path.open("rb") as f: header = f.read(131072)
    rows = []
    for raw in header.splitlines():
        try: rows.append(json.loads(raw))
        except (ValueError, UnicodeError): continue
    if provider == "codex":
        meta = next((r["payload"] for r in rows if r.get("type")=="session_meta"), {})
        ident = meta.get("id", path.stem); cwd = meta.get("cwd", "")
        child = meta.get("thread_source") == "subagent" or isinstance(meta.get("source"),dict) and "subagent" in meta["source"]
    else:
        ident = path.stem; cwd = next((r["cwd"] for r in rows if r.get("cwd")), "")
        child = "/subagents/" in str(path) or path.name.startswith("agent-")
    return ident, cwd, child, rows
def freeze(out, parent_ids=None):
    prior = json.loads(Path(parent_ids or BASE/".local/previous-parent-ids.json").read_text())
    allowed = {(x["provider"], x["id"]) for x in prior}
    now = time.time(); inventory = []; excluded = collections.Counter()
    for provider, root in (("claude",Path.home()/".claude/projects"), ("codex",Path.home()/".codex/sessions"), ("codex",Path.home()/".codex/archived_sessions")):
        for path in root.rglob("*.jsonl"):
            stat = path.stat()
            try:
                ident, cwd, child, rows = session_identity(provider, path)
                primary = (provider,ident) in allowed
                if not primary and not (child and cwd == PROJECT): continue
                if stat.st_mtime > now-86400:
                    excluded["modified_within_24h"] += 1; continue
                inventory.append({"path":str(path),"provider":provider,"id":ident,"primary":primary,
                    "bytes":stat.st_size,"mtime_ns":stat.st_mtime_ns,"first":next((r.get("timestamp","") for r in rows if r.get("timestamp")),"")})
            except OSError: excluded["unreadable_header"] += 1
    manifest = {"frozen_at":now,"protocol_sha256":digest((BASE/"RESULTS.md").read_text()),
        "prior_ids_sha256":digest(serialize(prior)),"excluded":dict(excluded),"files":sorted(inventory,key=lambda x:(x["first"],x["path"]))}
    (out/"manifest.json").write_text(json.dumps(manifest,indent=2))
    return manifest
def usage_index(sequence):
    quoted=set(); edited=set(); executed=set(); used={}
    for index in range(len(sequence)-1,-1,-1):
        event=sequence[index]; kind=event["kind"]
        if kind=="assistant": quoted.update(shingles(event["text"]))
        elif kind=="input":
            edited.update(edited_paths(event["name"],event["args"]))
            if event["name"].lower() in ("exec","bash","exec_command","shell","shell_command","run_command"):
                executed.update(c.strip() for c in commands(event["name"],event["args"]) if c.strip())
        elif kind=="output":
            named=paths(serialize(event["args"])) if event["category"] in ("file_reads","mixed") else set()
            used[index]=[(offset,chunk,later_use(chunk,named,quoted,edited,executed)) for offset,chunk in blocks(event["text"])]
    return used
def count_repeats(event,index,session,local,db,counts):
    current = {}
    for line in event["text"].splitlines():
        value=normalized_line(line)
        if len(re.sub(r"\s","",value))<20: continue
        key=bytes.fromhex(digest(value)); size=tokens(value)
        prior=local.get(key)
        rows=db.execute("SELECT actor,ts FROM seen WHERE hash=?", (key,)).fetchall()
        other=any(actor!=session and ts and event["timestamp"] and ts<event["timestamp"] for actor,ts in rows)
        kind=repeat_kind(prior,event["epoch"],index,other)
        counts["repeat_"+kind+"_tokens"]+=size
        if kind=="same_epoch" and event["category"] in ("file_reads","search"):
            counts["same_epoch_read_search_tokens"]+=size
        if any(actor!=session and (not ts or not event["timestamp"] or ts>=event["timestamp"]) for actor,ts in rows) and not other:
            counts["cross_agent_order_unknown_tokens"]+=size
        local[key]=(event["epoch"],index); current[key]=(session,event["timestamp"])
    for key,(actor,ts) in current.items():
        db.execute("INSERT OR IGNORE INTO seen VALUES (?,?,?)", (key,actor,ts))
def measure_session(item, totals, families, details, db):
    seq=list(events(item)); used=usage_index(seq); local={}; repetitions=collections.Counter()
    own=collections.defaultdict(collections.Counter); actor=item["provider"]+":"+item["id"]
    for index,event in enumerate(seq):
        if event["kind"]!="output": continue
        cat=event["category"]; cat="other" if cat=="edits" else cat
        cohort="parent" if item["primary"] else "child"
        key=item["provider"]+":"+cohort+":"+cat
        for offset,chunk,is_used in used[index]:
            n=tokens(chunk); row={"tokens":n,"unused_tokens":0 if is_used else n,"blocks":1}
            totals[key].update(row); own[cat].update(row)
            if item["primary"]: families[cat+":"+event["name"]].update(row)
            details.write(serialize({"actor":actor,"primary":item["primary"],"path":item["path"],
                "line":event["line"],"call":event["call"],"category":cat,"name":event["name"],
                "offset":offset,"length":len(chunk),"tokens":n,"used":is_used,"sha256":digest(chunk)})+"\n")
        own[cat]["outputs"]+=1
        count_repeats(event,index,actor,local,db,repetitions)
    db.commit()
    return {"actor":actor,"primary":item["primary"],"categories":dict(own),"repetitions":dict(repetitions),**seq[-1]}

def run(out, manifest):
    db=sqlite3.connect(out/"repeat-hashes.sqlite")
    db.execute("PRAGMA cache_size=-16384")
    db.execute("CREATE TABLE seen(hash BLOB,actor TEXT,ts TEXT,PRIMARY KEY(hash,actor)) WITHOUT ROWID")
    totals=collections.defaultdict(collections.Counter); families=collections.defaultdict(collections.Counter)
    sessions=[]; failures=[]; started=time.time()
    with (out/"blocks.jsonl").open("x") as details:
        for number,item in enumerate(manifest["files"],1):
            try:
                sessions.append(measure_session(item,totals,families,details,db))
            except (OSError,ValueError,KeyError,TypeError) as error:
                failures.append({"path":item["path"],"error":type(error).__name__})
            if number%25==0:
                print(json.dumps({"sessions":number,"total":len(manifest["files"]),"seconds":round(time.time()-started),
                    "peak_rss_mb":round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024**2)}),flush=True)
    primary=collections.defaultdict(collections.Counter)
    for key,value in totals.items():
        if ":parent:" in key: primary[key.split(":")[-1]].update(value)
    report={"categories":dict(primary),"cohorts":dict(totals),"families":dict(families),"winner":choose_winner(primary),
        "sessions":sessions,"failures":failures,"cost_usd":None,"cost_reason":"Historical model prices and billing revisions not reconstructed.",
        "peak_rss_mb":round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024**2),"seconds":round(time.time()-started)}
    (out/"measurement.json").write_text(json.dumps(report,indent=2)); db.close()
    print(json.dumps({k:v for k,v in report.items() if k not in ("sessions","cohorts","families")}),flush=True)
if __name__=="__main__":
    parser=argparse.ArgumentParser(); parser.add_argument("--out",required=True)
    parser.add_argument("--parent-ids"); parser.add_argument("--manifest"); args=parser.parse_args()
    directory=Path(args.out); directory.mkdir(parents=True,exist_ok=False)
    if args.manifest:
        manifest=json.loads(Path(args.manifest).read_text())
        (directory/"manifest.json").write_text(json.dumps(manifest,indent=2))
    else: manifest=freeze(directory,args.parent_ids)
    run(directory,manifest)

