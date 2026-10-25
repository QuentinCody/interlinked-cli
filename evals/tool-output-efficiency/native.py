"""Read frozen native transcripts; deduplicate storage copies, retain real repeats."""
import collections, json, re
from classify import category
from tokens import digest, serialize, text_of
def records(item, audit):
    with open(item["path"], "rb") as handle:
        remaining = item["bytes"]
        while remaining:
            raw = handle.readline(min(remaining, 32*1024*1024)); remaining -= len(raw)
            if not raw: break
            if not raw.endswith(b"\n"):
                audit["incomplete_or_oversized"] += 1; continue
            try: value = json.loads(raw)
            except (ValueError, UnicodeError): audit["malformed"] += 1; continue
            if isinstance(value, dict): yield value
class NativeEventReader:
    def __init__(self):
        self.audit = collections.Counter(); self.seen = set(); self.calls = {}; self.cells = {}; self.procs = {}
        self.usage = {}; self.fallback = {}; self.epoch = 0; self.model = "unknown"

    def call(self, name, args, ident):
        cat = category(name, args); raw = args if isinstance(args, str) else serialize(args)
        if name == "wait":
            try: cat = self.cells.get(str(json.loads(raw).get("cell_id")), cat)
            except ValueError: pass
        ids = re.findall(r'["\']?session_id["\']?\s*:\s*["\']?(\d+)', raw)
        known = {self.procs[i] for i in ids if i in self.procs}
        if known: cat = next(iter(known)) if len(known) == 1 else "mixed"
        self.calls[ident] = (name, args, cat)
        return {"kind":"input", "name":name, "args":args, "text":raw, "category":cat, "call":ident}

    def output(self, ident, value):
        name, args, cat = self.calls.get(ident, ("unmatched", {}, "other")); text = text_of(value)
        for cell in re.findall(r"Script running with cell ID (\S+)", text): self.cells[cell] = cat
        for group in re.findall(r'["\']?session_id["\']?\s*:\s*["\']?(\d+)|Process running with session ID (\d+)|Session ID:\s*(\d+)', text):
            for process in group:
                if process: self.procs[process] = cat
        return {"kind":"output", "name":name, "args":args, "text":text, "category":cat, "call":ident}

    def codex_row(self, row, line_number):
        emitted = []; kind = row.get("type"); data = row.get("payload") or {}
        if not isinstance(data, dict): return emitted
        if kind == "turn_context": self.model = data.get("model", self.model)
        if kind == "compacted": self.epoch += 1
        if kind == "token_usage_record":
            self.usage[data.get("response_id") or str(line_number)] = (self.model, data.get("usage") or {})
        if kind == "event_msg" and data.get("type") == "token_count":
            info = data.get("info") or {}
            if info.get("last_token_usage"): self.fallback[serialize(info.get("total_token_usage"))] = (self.model, info["last_token_usage"])
        if kind != "response_item": return emitted
        typ = data.get("type"); ident = data.get("call_id") or data.get("id")
        key = (typ, data.get("id") or ident, digest(serialize(data)))
        if key in self.seen:
            self.audit["duplicates"] += 1; return emitted
        self.seen.add(key)
        if typ in ("function_call", "custom_tool_call"):
            emitted.append(self.call(data.get("name", ""), data.get("arguments", data.get("input", "")), ident))
        elif typ in ("function_call_output", "custom_tool_call_output"): emitted.append(self.output(ident, data.get("output", "")))
        elif typ == "message":
            emitted.append({"kind":"assistant" if data.get("role") == "assistant" else "other", "text":text_of(data.get("content", []))})
        return emitted

    def claude_row(self, row):
        emitted = []; kind = row.get("type"); uid = row.get("uuid")
        if uid and uid in self.seen:
            self.audit["duplicates"] += 1; return emitted
        if uid: self.seen.add(uid)
        if kind == "system" and row.get("subtype") == "compact_boundary": self.epoch += 1
        message = row.get("message") or {}
        if not isinstance(message, dict): return emitted
        if kind == "assistant" and message.get("usage"):
            mid = message.get("id") or uid; prior = self.usage.get(mid, ("", {}))[1]
            if message["usage"].get("output_tokens", 0) >= prior.get("output_tokens", 0):
                self.usage[mid] = (message.get("model", "unknown"), message["usage"])
        content = message.get("content", [])
        if isinstance(content, str):
            if kind == "assistant": emitted.append({"kind":"assistant", "text":content})
        elif isinstance(content, list):
            for i, block in enumerate(content):
                if not isinstance(block, dict): continue
                typ = block.get("type")
                key = (message.get("id") or uid, row.get("apiBlockIndex", i), typ, digest(serialize(block)))
                if key in self.seen:
                    self.audit["duplicates"] += 1; continue
                self.seen.add(key)
                if typ == "tool_use": emitted.append(self.call(block.get("name", ""), block.get("input", {}), block.get("id")))
                elif typ == "tool_result": emitted.append(self.output(block.get("tool_use_id"), block.get("content", "")))
                elif typ == "text" and kind == "assistant": emitted.append({"kind":"assistant", "text":text_of(block)})
        return emitted

    def summary(self, provider):
        chosen = self.usage if len(self.usage) >= len(self.fallback) else self.fallback
        totals = collections.Counter(); peak = 0
        for model, data in chosen.values():
            inp = data.get("input_tokens", 0)
            cached = data.get("cached_input_tokens", data.get("cache_read_input_tokens", 0))
            write = data.get("cache_write_input_tokens", data.get("cache_creation_input_tokens", 0))
            if provider == "claude": inp += cached + write
            totals.update(input=inp, cached=cached, cache_write=write, output=data.get("output_tokens", 0), calls=1)
            peak = max(peak, inp)
        return {"kind":"end", "usage":dict(totals), "peak_input":peak, "audit":dict(self.audit), "compactions":self.epoch}

def events(item):
    reader = NativeEventReader()
    for line_number, row in enumerate(records(item, reader.audit), 1):
        emitted = reader.codex_row(row, line_number) if item["provider"] == "codex" else reader.claude_row(row)
        for event in emitted:
            yield {**event, "epoch":reader.epoch, "timestamp":row.get("timestamp", ""), "line":line_number}
    yield reader.summary(item["provider"])
