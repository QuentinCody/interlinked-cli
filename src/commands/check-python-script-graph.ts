// interlinked-tdd: exempt
// @codegen-data — embedded Python program, import-graph part (joined in check-python-script.ts).
// Data only; behaviour is tested through python-graph-run.test.ts (real interpreter, real temp trees).
// Active only when the request carries {"graph": true}: it adds a "graph" object to the answer with
// one node per parsed module, every static import edge the resolver found, the module attributes that
// importers read, the string-named entry targets (Django settings, pytest_plugins) and the dynamic
// imports. Standard library `ast` only; the analysed source is read as bytes and never imported or run.
// Keep backticks and dollar-brace sequences out of this text: it is a template literal.

export const PYTHON_GRAPH_PART = String.raw`

# --- import graph (request {"graph": true}) -------------------------------------------------

GRAPH_MODE = False
SETTING_NAMES = {"INSTALLED_APPS", "ROOT_URLCONF", "WSGI_APPLICATION", "ASGI_APPLICATION", "MIDDLEWARE", "AUTHENTICATION_BACKENDS", "pytest_plugins"}
DYNAMIC_CALLS = {"import_module", "__import__", "run_module"}
DISCOVERY_CALLS = {"iter_modules", "walk_packages", "entry_points", "iter_entry_points", "load_entry_point"}
TRY_NODES = (ast.Try, getattr(ast, "TryStar", ast.Try))
TAIL_CAP = 6
CONSUMER_CAP = 3


def call_name(call):
    if isinstance(call.func, ast.Name):
        return call.func.id
    return call.func.attr if isinstance(call.func, ast.Attribute) else None


def graph_defs(stmts, found):
    """Module-level definitions, descending into if, try, with and loops but not into functions, classes or the main guard."""
    for stmt in stmts:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            found.append((stmt.name, stmt.lineno, "function", bool(stmt.decorator_list)))
        elif isinstance(stmt, ast.ClassDef):
            found.append((stmt.name, stmt.lineno, "class", bool(stmt.decorator_list)))
        elif isinstance(stmt, (ast.Assign, ast.AnnAssign)):
            if isinstance(stmt, ast.AnnAssign) and stmt.value is None:
                continue
            for target in (stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]):
                for item in (target.elts if isinstance(target, (ast.Tuple, ast.List)) else [target]):
                    if isinstance(item, ast.Name):
                        found.append((item.id, stmt.lineno, "variable", False))
        elif isinstance(stmt, ast.If):
            if not is_main_guard(stmt.test):
                graph_defs(stmt.body, found)
            graph_defs(stmt.orelse, found)
        elif isinstance(stmt, TRY_NODES):
            graph_defs(stmt.body, found)
            for handler in stmt.handlers:
                graph_defs(handler.body, found)
            graph_defs(stmt.orelse, found)
            graph_defs(stmt.finalbody, found)
        elif isinstance(stmt, (ast.With, ast.AsyncWith, ast.For, ast.AsyncFor, ast.While)):
            graph_defs(stmt.body, found)
            graph_defs(getattr(stmt, "orelse", []), found)


def graph_settings(stmts, found):
    for stmt in stmts:
        if isinstance(stmt, ast.Assign):
            for target in stmt.targets:
                if isinstance(target, ast.Name) and target.id in SETTING_NAMES:
                    value = stmt.value
                    strings = [value.value] if isinstance(value, ast.Constant) and isinstance(value.value, str) else literal_strings(value)
                    for text in strings:
                        found.append((target.id, stmt.lineno, text))
        elif isinstance(stmt, ast.If):
            graph_settings(stmt.body, found)
            graph_settings(stmt.orelse, found)


DOTTED = re.compile(r"^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*){1,6}$")
STRING_CAP = 300


def docstring_ids(tree):
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            first = node.body[0] if node.body else None
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
                found.add(id(first.value))
    return found


def dotted_strings(tree):
    """String literals that read as a dotted module path (not a docstring): a plugin, handler or include named by string."""
    skip = docstring_ids(tree)
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and len(node.value) <= 120 and id(node) not in skip and DOTTED.match(node.value):
            found.append((node.lineno, node.value))
            if len(found) >= STRING_CAP:
                break
    return found


def loader_globs(tree):
    """Glob patterns for Python files in string literals, such as "provider_*.py": a module that loads files by pattern names them."""
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and len(node.value) <= 120 and "*" in node.value and node.value.endswith(".py"):
            found.add(node.value)
    return sorted(found)


def graph_facts(tree):
    """Per-module facts the graph needs that do not depend on resolution."""
    defs = []
    graph_defs(tree.body, defs)
    settings = []
    graph_settings(tree.body, settings)
    loads = {}
    attributes = []
    inner = set()
    bases = set()
    named = []
    tails = {}
    getattr_dynamic = set()
    enumerated = set()
    dynamic_literal = []
    dynamic_computed = []
    discovery = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute):
            attributes.append(node)
            if isinstance(node.value, ast.Attribute):
                inner.add(id(node.value))
            elif isinstance(node.value, ast.Name):
                bases.add(id(node.value))
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            loads[node.id] = loads.get(node.id, 0) + 1
            named.append(node)
        elif isinstance(node, ast.Call):
            name = call_name(node)
            patching = name == "object" and isinstance(node.func, ast.Attribute) and ((isinstance(node.func.value, ast.Name) and node.func.value.id == "patch") or (isinstance(node.func.value, ast.Attribute) and node.func.value.attr == "patch"))
            if (name in ("getattr", "hasattr", "setattr", "delattr") or patching) and len(node.args) >= 2 and isinstance(node.args[0], ast.Name):
                literal = node.args[1]
                if isinstance(literal, ast.Constant) and isinstance(literal.value, str):
                    tails.setdefault(node.args[0].id, set()).add((literal.value,))
                elif name == "getattr":
                    getattr_dynamic.add(node.args[0].id)
            elif name in ("dir", "vars", "getmembers") and node.args and isinstance(node.args[0], ast.Name):
                enumerated.add(node.args[0].id)
            elif name in DYNAMIC_CALLS:
                first = node.args[0] if node.args else None
                if isinstance(first, ast.Constant) and isinstance(first.value, str) and first.value and not first.value.startswith("."):
                    dynamic_literal.append((node.lineno, first.value))
                else:
                    dynamic_computed.append(node.lineno)
            elif name in DISCOVERY_CALLS:
                discovery.append(node.lineno)
    for node in attributes:
        if id(node) in inner:
            continue
        names = []
        current = node
        while isinstance(current, ast.Attribute):
            names.append(current.attr)
            current = current.value
        if isinstance(current, ast.Name):
            tails.setdefault(current.id, set()).add(tuple(reversed(names))[:TAIL_CAP])
    bare = {node.id for node in named if id(node) not in bases}
    return {
        "gdefs": defs,
        "gall": all_names(tree),
        "gsettings": settings,
        "gloads": loads,
        "gtails": tails,
        "gbare": bare,
        "ggetattr": getattr_dynamic,
        "genumerated": enumerated,
        "gdyn_literal": dynamic_literal,
        "gdyn_computed": dynamic_computed,
        "gdiscovery": discovery,
        "gstrings": dotted_strings(tree),
        "gglobs": loader_globs(tree) if (dynamic_computed or discovery) else [],
    }


def graph_record(probe, importer, node, ctx, names, kind, path):
    """One edge row per resolved target of a static import statement, and the module names the statement binds."""
    tree = probe.tree
    per_target = {}
    star_target = None
    if isinstance(node, ast.Import):
        alias = probe.current_alias
        leaf = path if kind == "module" else join(path, "__init__.py")
        per_target[leaf] = []
        parts = alias.name.split(".")
        if alias.asname:
            probe.graph_bindings.append((importer, alias.asname, leaf, [], leaf))
        else:
            first = leaf
            if len(parts) > 1:
                first = None
                try:
                    outcome = probe.resolve(probe.last_base, parts[:1])
                except Skip:
                    outcome = None
                if outcome and outcome[0] == "ok" and outcome[1] in ("pkg", "module"):
                    first = outcome[2] if outcome[1] == "module" else join(outcome[2], "__init__.py")
            if first is not None:
                probe.graph_bindings.append((importer, parts[0], first, parts[1:], leaf))
    elif kind == "pkg":
        init = join(path, "__init__.py")
        for alias in node.names:
            if alias.name == "*":
                star_target = init
                per_target.setdefault(init, [])
                continue
            found, value = lookup(tree, path, alias.name)
            if found == "module":
                target = value
            elif found == "pkg":
                target = join(value, "__init__.py")
            else:
                per_target.setdefault(init, []).append(alias.name)
                continue
            per_target.setdefault(target, [])
            probe.graph_bindings.append((importer, alias.asname or alias.name, target, [], target))
    else:
        per_target[path] = [alias.name for alias in node.names if alias.name != "*"]
        if any(alias.name == "*" for alias in node.names):
            star_target = path
    for target, bound in per_target.items():
        if target != importer and target in probe.summaries:
            probe.graph_edges.append({
                "from": importer, "to": target, "line": node.lineno, "names": sorted(set(bound)),
                "star": target == star_target, "in_function": ctx.in_function, "type_only": ctx.type_only, "guarded": ctx.guarded,
            })


def graph_add(table, target, name, importer):
    holders = table.setdefault(target, {}).setdefault(name, [])
    if importer not in holders and len(holders) < CONSUMER_CAP:
        holders.append(importer)


def graph_walk_tail(probe, start, tail, importer, consumed):
    """Follow one attribute chain from a module: a name that is a submodule of a package moves into it; the first other name is read."""
    current = start
    for name in tail:
        if posixpath.basename(current) == "__init__.py":
            found, value = lookup(probe.tree, posixpath.dirname(current) or ".", name)
            if found in ("module", "pkg"):
                current = value if found == "module" else join(value, "__init__.py")
                continue
        graph_add(consumed, current, name, importer)
        return


def graph_reads(probe):
    consumed, value_used, getattr_on = {}, {}, {}
    for importer, local, first, rest, leaf in probe.graph_bindings:
        summary = probe.summaries[importer]
        if local in summary["gbare"]:
            graph_add(value_used, first, "*", importer)
        if local in summary["ggetattr"]:
            graph_add(getattr_on, first, "*", importer)
        if local in summary["genumerated"]:
            graph_add(consumed, leaf if not rest else first, "*", importer)
        for tail in summary["gtails"].get(local, ()):
            if rest:
                if list(tail[:len(rest)]) == rest:
                    graph_walk_tail(probe, leaf, tail[len(rest):], importer, consumed)
                    continue
            graph_walk_tail(probe, first, tail, importer, consumed)
    for edge in probe.graph_edges:
        if edge["star"]:
            target = probe.summaries[edge["to"]]
            exported = set(target["gall"]) if target["gall"] else {name for name, _, _, _ in target["gdefs"] if not name.startswith("_")}
            used = set(probe.summaries[edge["from"]]["gloads"])
            for name in sorted(exported & used):
                graph_add(consumed, edge["to"], name, edge["from"])
    for edge in probe.graph_edges:
        for name in edge["names"]:
            graph_add(consumed, edge["to"], name, edge["from"])
    return consumed, value_used, getattr_on


def resolve_dotted(probe, importer, dotted, longest_prefix):
    """(module file, parts used) a dotted name reaches from the importer's resolution roots; with longest_prefix, trailing attribute parts are dropped."""
    summary = probe.summaries[importer]
    roots, _ = probe.tree.roots_for(importer, importer_role(importer), summary["main_guard"])
    parts = dotted.split(".")
    for count in range(len(parts), 0 if longest_prefix else len(parts) - 1, -1):
        for root in roots:
            try:
                outcome = probe.resolve(root, parts[:count])
            except Skip:
                continue
            if outcome[0] == "ok" and outcome[1] in ("pkg", "module"):
                return (outcome[2] if outcome[1] == "module" else join(outcome[2], "__init__.py")), count
    return None, 0


def graph_payload(probe):
    consumed, value_used, getattr_on = graph_reads(probe)
    modules = []
    dynamic_edges = []
    string_targets = []
    string_edges = []
    for path in sorted(probe.summaries):
        summary = probe.summaries[path]
        allowed = set(summary["gall"])
        defs = []
        for name, line, kind, decorated in summary["gdefs"]:
            if (name.startswith("_") and name not in allowed) or (name.startswith("__") and name.endswith("__")):
                continue
            defs.append([name, line, kind, decorated, summary["gloads"].get(name, 0) > 0])
        modules.append({
            "path": path, "role": importer_role(path), "main_guard": summary["main_guard"],
            "all": sorted(allowed), "star": summary["star"], "getattr": summary["getattr"], "dynamic": summary["dynamic"],
            "defs": defs, "dynamic_computed": sorted(set(summary["gdyn_computed"] + summary["gdiscovery"])), "loader_globs": summary["gglobs"],
        })
        for line, dotted in summary["gdyn_literal"]:
            target, _ = resolve_dotted(probe, path, dotted, False)
            if target is not None and target != path:
                dynamic_edges.append({"from": path, "to": target, "line": line, "literal": dotted})
                graph_add(value_used, target, "*", path)
            elif dotted.split(".")[0] in probe.module_names:
                modules[-1]["dynamic_computed"] = sorted(set(modules[-1]["dynamic_computed"] + [line]))
        for setting, line, value in summary["gsettings"]:
            target, _ = resolve_dotted(probe, path, value, True)
            string_targets.append({"from": path, "line": line, "setting": setting, "value": value, "to": target})
        for line, dotted in summary["gstrings"]:
            target, used = resolve_dotted(probe, path, dotted, True)
            if target is not None and target != path and used >= 2 and not any(item["from"] == path and item["line"] == line and item["to"] == target for item in dynamic_edges):
                rest = dotted.split(".")[used:]
                string_edges.append({"from": path, "to": target, "line": line, "literal": dotted})
                if rest:
                    graph_add(consumed, target, rest[0], path)
    def holders(table):
        return {target: {name: items for name, items in names.items()} for target, names in sorted(table.items())}
    return {
        "modules": modules,
        "edges": sorted(probe.graph_edges, key=lambda e: (e["from"], e["line"], e["to"])),
        "dynamic_edges": sorted(dynamic_edges, key=lambda e: (e["from"], e["line"], e["to"])),
        "string_targets": string_targets,
        "string_edges": sorted(string_edges, key=lambda e: (e["from"], e["line"], e["to"])),
        "consumed": holders(consumed),
        "value_used": holders(value_used),
        "getattr_on": holders(getattr_on),
        "files": list(probe.tree.py_files),
    }
`;
