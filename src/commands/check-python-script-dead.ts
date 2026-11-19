// interlinked-tdd: exempt
// @codegen-data — embedded Python program, dead-import part (joined in check-python-script.ts).
// Data only; behaviour is tested through check-python-dead-imports.test.ts.
// Per-module analysis of unused import bindings: which names a module reads, which bindings
// are never read, and why an unused binding is not reported. Standard library `ast` only.
// Keep backticks and dollar-brace sequences out of this text: it is a template literal.

export const PYTHON_DEAD_PART = String.raw`

# --- unused import bindings ---------------------------------------------------------------

NOQA = re.compile(r"#\s*noqa\b(?:\s*:\s*([A-Za-z0-9, ]+))?", re.I)
PYLINT_UNUSED = re.compile(r"#\s*pylint\s*:\s*disable\s*=[^#\n]*\b(?:unused-import|W0611)\b")
FILE_NOQA = re.compile(r"^\s*#\s*(?:ruff|flake8)\s*:\s*noqa\b(?:\s*:\s*([A-Za-z0-9, ]+))?", re.I)
TYPE_COMMENT = re.compile(r"#\s*type:\s*(?!ignore\b)(.+)$")
WORD = re.compile(r"[A-Za-z_][A-Za-z_0-9]*")
DYNAMIC_NAMESPACE = re.compile(r"(?<![\w.])(?:globals|locals|eval|exec)\(")
STRING_WORD_CAP = 400


def noqa_covers_f401(codes):
    """A bare noqa, or a code list with F401 or a prefix of it (F, F4, F40)."""
    if codes is None:
        return True
    tokens = [token for token in re.split(r"[,\s]+", codes.strip()) if token]
    return not tokens or any("F401".startswith(token.upper()) for token in tokens)


def line_silences(line):
    return any(noqa_covers_f401(match.group(1)) for match in NOQA.finditer(line)) or bool(PYLINT_UNUSED.search(line))


def file_silences(lines):
    return any(noqa_covers_f401(match.group(1)) for line in lines for match in [FILE_NOQA.match(line)] if match)


def string_words(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str) and len(node.value) < STRING_WORD_CAP:
        return WORD.findall(node.value)
    return []


def callee_name(call):
    if isinstance(call.func, ast.Name):
        return call.func.id
    return call.func.attr if isinstance(call.func, ast.Attribute) else ""


def used_names(tree, lines, is_test):
    """Every name the module reads, including names inside string annotations, cast and TypeVar strings and type comments."""
    used = set(all_names(tree))
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            if not isinstance(node.ctx, ast.Store):
                used.add(node.id)
        elif is_test and isinstance(node, ast.arg):
            used.add(node.arg)
        elif isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name):
            used.add(node.target.id)
        elif isinstance(node, ast.Subscript):
            # A forward reference inside a subscript, such as an alias Callable[["Foo"], "Foo | None"].
            for item in ast.walk(node.slice):
                used.update(string_words(item))
        elif isinstance(node, ast.Call):
            name = callee_name(node)
            if name == "cast" and node.args:
                used.update(string_words(node.args[0]))
            if name == "TypeVar":
                for item in node.args[1:]:
                    used.update(string_words(item))
            for keyword in node.keywords:
                if keyword.arg == "bound":
                    used.update(string_words(keyword.value))
    for annotation in annotations_of(tree):
        for item in ast.walk(annotation):
            used.update(string_words(item))
    for line in lines:
        match = TYPE_COMMENT.search(line)
        if match:
            used.update(WORD.findall(match.group(1)))
    return used


def unused_import_reason(alias, stmt, ctx, silenced, dynamic):
    """Why an unused binding is not reported, or None when it is a candidate."""
    bound = alias.asname or (alias.name.split(".")[0] if isinstance(stmt, ast.Import) else alias.name)
    if isinstance(stmt, ast.ImportFrom) and stmt.module == "__future__" and stmt.level == 0:
        return "future_import"
    if bound.startswith("__") and bound.endswith("__"):
        return "dunder_name"
    if alias.asname and alias.asname == alias.name:
        return "explicit_reexport"
    if silenced:
        return "noqa"
    if ctx.guarded:
        return "try_importerror_guard"
    if dynamic:
        return "dynamic_namespace"
    return None


def unused_imports(imports, used, lines, text):
    """One dict per import binding that the module never reads, with the reason it is exempt (None = a candidate)."""
    dynamic = bool(DYNAMIC_NAMESPACE.search(text))
    whole_file = file_silences(lines)
    found = []
    for stmt, ctx in imports:
        end = getattr(stmt, "end_lineno", stmt.lineno)
        silenced = whole_file or any(line_silences(line) for line in lines[stmt.lineno - 1:end])
        for alias in stmt.names:
            if alias.name == "*":
                continue
            bound = alias.asname or (alias.name.split(".")[0] if isinstance(stmt, ast.Import) else alias.name)
            if bound in used:
                continue
            is_from = isinstance(stmt, ast.ImportFrom)
            found.append({
                "name": bound,
                "line": stmt.lineno,
                "end_line": end,
                "module": ("." * stmt.level + (stmt.module or "")) if is_from else "",
                "type_only": ctx.type_only,
                "in_function": ctx.in_function,
                "bare_import": not is_from,
                "reason": unused_import_reason(alias, stmt, ctx, silenced, dynamic),
            })
    return found
`;
