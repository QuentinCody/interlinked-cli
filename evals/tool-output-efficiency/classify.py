"""Conservative tool-family classification; mixed shell calls stay mixed."""
import ast, json, re
from tokens import serialize
def arguments(value):
    if isinstance(value, str):
        try: return json.loads(value)
        except ValueError: return value
    return value
def commands(name, value):
    value = arguments(value)
    if isinstance(value, dict): return [str(value.get("cmd") or value.get("command") or "")]
    text = str(value)
    pattern = r"""(?:["']?cmd["']?|["']?command["']?)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60[^\x60]*\x60)"""
    found = []
    for match in re.finditer(pattern, text):
        literal = match[1]
        try: found.append(literal[1:-1] if literal[0] == chr(96) else ast.literal_eval(literal))
        except (ValueError, SyntaxError): found.append(literal[1:-1])
    return found or [text]
def shell_category(command):
    cats = set()
    pattern = r"(?:^|[;\n|&])\s*(?:(?:[A-Za-z_]\w*=\S+|command|env)\s+)*(?:[^\s;|&]*/)?(cat|rg|grep|head|tail|ls|find|wc|stat|sed|awk|git|npm|pnpm|yarn|bun|npx|vitest|pytest|jest|tsgo|tsc|eslint|gitleaks|apply_patch|tee|rm|mv|cp|mkdir|touch|jq)\b([^\n;|&]*)"
    for match in re.finditer(pattern, command):
        name, rest = match[1], match[2].strip()
        if name in ("rg", "grep", "find", "ls"): cats.add("search")
        elif name in ("cat", "head", "tail", "sed", "awk"):
            cats.add("edits" if (name == "sed" and re.match("-i", rest)) or re.search(r">\s*[^&]", rest) else "file_reads")
        elif name in ("wc", "stat"): cats.add("other")
        elif name == "jq": cats.add("structured_data")
        elif name == "git": cats.add("diffs_status" if re.match(r"(diff|show|status|log|blame)\b", rest) else "other")
        elif name in ("vitest", "pytest", "jest", "tsgo", "tsc", "eslint", "gitleaks"): cats.add("test_build")
        elif name in ("npm", "pnpm", "yarn", "bun", "npx"):
            cats.add("test_build" if re.search(r"^(?:run\s+|exec\s+)?(?:test|build|typecheck|lint|check|vitest|jest|tsc|tsgo|eslint)\b", rest) else "other")
        else: cats.add("edits")
    if re.search(r"readFile(?:Sync)?\s*\(|\.read_(?:text|bytes)\(", command): cats.add("file_reads")
    if re.search(r"writeFile(?:Sync)?\s*\(|\.write_(?:text|bytes)\(|\*\*\* (?:Add|Update|Delete) File:", command): cats.add("edits")
    return next(iter(cats)) if len(cats) == 1 else ("mixed" if cats else "other")
def category(name, value):
    name = name.lower().split("__")[-1]
    if name in ("read", "read_file", "readfile", "view_image"): return "file_reads"
    if name in ("grep", "glob", "search_files", "list_directory"): return "search"
    if name in ("edit", "write", "multiedit", "multi_edit", "apply_patch", "edit_file", "write_file"): return "edits"
    if name in ("exec", "bash", "exec_command", "shell", "shell_command", "run_command"):
        cats = {shell_category(c) for c in commands(name, value)}
        if "tools.apply_patch" in str(value): cats.add("edits")
        return next(iter(cats)) if len(cats) == 1 else "mixed"
    if any(word in name for word in ("read", "search", "fetch", "query", "get_")): return "structured_data"
    return "other"
def edited_paths(name, value):
    from tokens import paths
    data = arguments(value)
    if name.lower() in ("edit", "write", "multiedit", "multi_edit", "edit_file", "write_file"): return paths(serialize(data))
    text = value if isinstance(value, str) else serialize(value)
    if "apply_patch" in name or "*** Update File:" in text or "*** Add File:" in text:
        return {p.split("interlinked-cli/",1)[-1] for p in re.findall(r"\*\*\* (?:Update|Add|Delete) File: ([^\n\\]+)", text)}
    return set()
