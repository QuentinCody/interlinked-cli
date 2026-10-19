import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "../types.js";
import { detectInterpreterWrite, evaluateInterpreterWriteGuard } from "./interpreter-write-guard.js";

const ROOT = "/Users/dev/project";
const python = (...lines: string[]) => ["python3 - <<'PY'", ...lines, "PY"].join("\n");
const detect = (command: string) => detectInterpreterWrite(command, ROOT);

describe("inline writes require evidence about the destination", () => {
    it("allows continuation bookkeeping that hashes code and writes JSON ledgers", () => {
        // 2026-10-15: the guard associated ledger.write_text with runner/native.py,
        // although that filename was only read to record its hash in FROZEN.json.
        const command = python(
            "from pathlib import Path",
            "import hashlib, json",
            "p = Path('scratch/repair-evidence-push-pilot').resolve()",
            "def sha(f): return hashlib.sha256(Path(f).read_bytes()).hexdigest()",
            "f = json.loads((p/'FROZEN.json').read_text())",
            "for rel in ['runner/native.py', 'controller/run.py']:",
            "    f['hashes'][str(p/rel)] = sha(p/rel)",
            "(p/'FROZEN.json').write_text(json.dumps(f))",
            "(p/'GO.json').write_text(json.dumps({'frozen_sha256': sha(p/'FROZEN.json')}))",
            "ledger = p.parent/'pending-work-routing/JEV-CREDIT-LEDGER.json'",
            "r = json.loads(ledger.read_text())",
            "ledger.write_text(json.dumps(r))",
        );
        const event: HarnessEvent = {
            hook_event: "PreToolUse", session_id: "bookkeeping-regression", agent_source: "codex",
            tool_name: "Bash", tool_input: { command }, cwd: ROOT, timestamp: "2026-10-15T20:31:55Z",
        };
        expect(detect(command)).toBeNull();
        expect(evaluateInterpreterWriteGuard(event, "Bash", { command }, [])).toBeNull();
    });

    it.each([
        ["Python open", python("source = open('src/a.ts').read()", "dest = 'scratch/result.json'", "open(dest, 'w').write(source)")],
        ["Python Path", python("source = Path('src/a.ts').read_text()", "dest = Path('scratch/result.json')", "dest.write_text(source)")],
        ["Node", "node -e 'const source = fs.readFileSync(\"src/a.ts\"); const dest = \"scratch/result.json\"; fs.writeFileSync(dest, source)'"],
        ["Ruby", "ruby -e 'source = File.read(\"src/app.rb\"); dest = \"scratch/result.json\"; File.write(dest, source)'"],
        ["Perl", "perl -e 'my $source = \"src/tool.ts\"; my $dest = \"scratch/result.json\"; open(my $fh, \">\", $dest)'"],
    ])("does not pair a %s data write with an unrelated source reference", (_name, command) => {
        expect(detect(command)).toBeNull();
    });

    it.each([
        ["Python open", python("dest = 'src/a.ts'", "open(dest, 'w').write(body)")],
        ["Python Path constructor", python("dest = 'src/a.ts'", "Path(dest).write_text(body)")],
        ["Python Path receiver", python("dest = Path('src/a.ts')", "dest.write_bytes(body)")],
        ["Node", "node -e 'const dest = \"src/a.ts\"; fs.writeFileSync(dest, body)'"],
        ["Ruby", "ruby -e 'dest = \"src/a.ts\"; File.write(dest, body)'"],
        ["Perl", "perl -e 'my $dest = \"src/a.ts\"; open(my $fh, \">\", $dest)'"],
    ])("still blocks a %s write with a destination bound to source", (_name, command) => {
        const hit = detect(command);
        expect(hit?.resolved).toBe(`${ROOT}/src/a.ts`);
        expect(hit?.indirect).toBe(true);
    });

    it.each([
        python("dest = 'src/a.ts'", "dest = 'scratch/result.json'", "open(dest, 'w').write(body)"),
        python("dest = 'src/a.ts'", "dest += '.json'", "open(dest, 'w').write(body)"),
        python("dest = 'src/a.ts'", "dest, other = 'scratch/result.json', None", "open(dest, 'w').write(body)"),
        python("dest = 'src/a.ts'", "def save(dest):", "    open(dest, 'w').write(body)", "save('scratch/result.json')"),
        python("# dest = 'src/a.ts'", "open(dest, 'w').write(body)"),
        python("example = \"dest = 'src/a.ts'\"", "open(dest, 'w').write(body)"),
        python("open(dest, 'w').write(body)", "dest = 'src/a.ts'"),
        python("source = 'src/a.ts'", "dest = get_output_path()", "open(dest, 'w').write(body)"),
    ])("does not infer a source destination from an ambiguous binding: %s", (command) => {
        expect(detect(command)).toBeNull();
    });

    // 2026-10-15 review: the two most idiomatic Python write forms and a
    // one-letter Node binding were exempt from the indirect pass.
    it.each([
        ["with-statement", python("dest = 'src/a.ts'", "with open(dest, 'w') as f:", "    f.write(body)")],
        ["triple-quoted body", python("dest = 'src/a.ts'", 'body = """hello"""', "open(dest, 'w').write(body)")],
        ["multi-line triple-quoted body", python("dest = 'src/a.ts'", 'body = """', "line one", 'line two"""', "open(dest, 'w').write(body)")],
        ["Node one-letter name", "node -e 'const s = \"src/a.ts\"; fs.writeFileSync(s, body)'"],
        ["Node template body", "node -e 'const dest = \"src/a.ts\"; const body = `x ${y}`; fs.writeFileSync(dest, body)'"],
    ])("still blocks a %s write with a destination bound to source", (_name, command) => {
        const hit = detect(command);
        expect(hit?.resolved).toBe(`${ROOT}/src/a.ts`);
        expect(hit?.indirect).toBe(true);
    });

    it.each([
        ["a binding inside a triple-quoted string", python('doc = """', "dest = 'src/a.ts'", '"""', "open(dest, 'w').write(body)")],
        ["an earlier with-block (a scope this pass does not model)", python("dest = 'src/a.ts'", "with open('scratch/in.txt') as g:", "    body = g.read()", "with open(dest, 'w') as f:", "    f.write(body)")],
        ["an unterminated triple quote", python("dest = 'src/a.ts'", 'body = """', "open(dest, 'w').write(body)")],
    ])("does not infer a destination through %s", (_name, command) => {
        expect(detect(command)).toBeNull();
    });

    it("checks every write rather than stopping at a harmless ledger write", () => {
        expect(detect(python(
            "ledger = Path('scratch/result.json')",
            "ledger.write_text('{}')",
            "dest = 'src/a.ts'",
            "open(dest, 'w').write(body)",
        ))?.resolved).toBe(`${ROOT}/src/a.ts`);
    });
});
