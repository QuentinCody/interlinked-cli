/**
 * Python source for the module facts the reachability, unused-declaration, correctness and contract adapters read.
 * It is appended to the fixed scoring analyzer; it uses only `ast` and `re` and never imports or runs target code.
 * Entity definitions mirror `analysis-syntax.ts`: a statement is an executable statement at any depth, a declaration
 * is a top-level binding, and an identifier use is any name token other than a string.
 */
export const PYTHON_FACTS_SCRIPT = String.raw`
import re

DEF_NODES = (ast.FunctionDef, ast.AsyncFunctionDef)
NOT_EXECUTABLE = DEF_NODES + (ast.ClassDef, ast.Import, ast.ImportFrom, ast.Pass, ast.Global, ast.Nonlocal)
WORD = re.compile(r'[A-Za-z_][A-Za-z_0-9]*')

def docstring_ids(tree):
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef) + DEF_NODES) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                found.add(id(first))
    return found

def executable_statements(tree, span):
    docs, rows = docstring_ids(tree), []
    for node in ast.walk(tree):
        if isinstance(node, ast.stmt) and not isinstance(node, NOT_EXECUTABLE) and id(node) not in docs:
            start, end = span(node)
            rows.append([node.lineno, node.end_lineno, start, end])
    rows.sort()
    return rows

def identifier_counts(tree):
    counts = {}
    def add(name):
        if name:
            counts[name] = counts.get(name, 0) + 1
    def add_words(annotation):
        if isinstance(annotation, ast.Constant) and isinstance(annotation.value, str):
            for word in WORD.findall(annotation.value):
                add(word)
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            add(node.id)
        elif isinstance(node, DEF_NODES + (ast.ClassDef,)):
            add(node.name)
            add_words(getattr(node, 'returns', None))
        elif isinstance(node, ast.arg):
            add(node.arg)
            add_words(node.annotation)
        elif isinstance(node, ast.Attribute):
            add(node.attr)
        elif isinstance(node, ast.keyword):
            add(node.arg)
        elif isinstance(node, ast.alias):
            add(node.asname or node.name.split('.')[0])
        elif isinstance(node, ast.ExceptHandler):
            add(node.name)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            for name in node.names:
                add(name)
        elif isinstance(node, (ast.MatchAs, ast.MatchStar)):
            add(node.name)
        elif isinstance(node, ast.MatchMapping):
            add(node.rest)
        elif isinstance(node, ast.AnnAssign):
            add_words(node.annotation)
    return counts

def literal_strings(value):
    if isinstance(value, (ast.List, ast.Tuple)) and all(isinstance(item, ast.Constant) and isinstance(item.value, str) for item in value.elts):
        return [item.value for item in value.elts]
    return None

def all_names(tree):
    names = None
    for node in tree.body:
        target = value = None
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == '__all__' for t in node.targets):
            target, value = 'assign', node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == '__all__' and node.value is not None:
            target, value = 'assign', node.value
        elif isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name) and node.target.id == '__all__':
            target, value = 'extend', node.value
        if target is None:
            continue
        items = literal_strings(value)
        if items is None:
            return None
        names = (names or []) + items if target == 'extend' else list(items)
    return names

def module_level(body):
    for node in body:
        yield node
        if isinstance(node, DEF_NODES + (ast.ClassDef,)):
            continue
        for field in ('body', 'orelse', 'finalbody'):
            inner = getattr(node, field, None)
            if isinstance(inner, list):
                yield from module_level(inner)
        for handler in getattr(node, 'handlers', []):
            yield from module_level(handler.body)

def declarations(tree, counts, listed):
    found, seen = [], set()
    def add(name, line, decorated):
        if name in seen or (name.startswith('__') and name.endswith('__')):
            return
        seen.add(name)
        exported = name in listed if listed is not None else not name.startswith('_')
        found.append(dict(name=name, line=line, exported=exported, decorated=decorated, uses=counts.get(name, 0)))
    for node in tree.body:
        if isinstance(node, DEF_NODES + (ast.ClassDef,)):
            add(node.name, node.lineno, bool(node.decorator_list))
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    add(target.id, node.lineno, False)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            add(node.target.id, node.lineno, False)
    return found

def bound_public_names(tree, listed):
    if listed is not None:
        return list(dict.fromkeys(listed))
    names = []
    def bind(name):
        if not name.startswith('_') and name not in names:
            names.append(name)
    for node in module_level(tree.body):
        if isinstance(node, DEF_NODES + (ast.ClassDef,)):
            bind(node.name)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                for part in ast.walk(target):
                    if isinstance(part, ast.Name) and isinstance(part.ctx, ast.Store):
                        bind(part.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            bind(node.target.id)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                bind((alias.asname or alias.name).split('.')[0])
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name != '*':
                    bind(alias.asname or alias.name)
    return names

def main_guard(tree):
    for node in tree.body:
        test = node.test if isinstance(node, ast.If) else None
        if isinstance(test, ast.Compare) and len(test.ops) == 1 and isinstance(test.ops[0], ast.Eq):
            sides = [test.left, test.comparators[0]]
            has_name = any(isinstance(side, ast.Name) and side.id == '__name__' for side in sides)
            has_main = any(isinstance(side, ast.Constant) and side.value == '__main__' for side in sides)
            if has_name and has_main:
                return True
    return False

def dynamic_imports(tree):
    lines = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
        literal = bool(node.args) and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)
        if name in ('import_module', '__import__') and not literal:
            lines.append(node.lineno)
    return sorted(lines)

def module_facts(tree, span):
    counts, listed = identifier_counts(tree), all_names(tree)
    star = any(isinstance(node, ast.ImportFrom) and any(alias.name == '*' for alias in node.names) for node in module_level(tree.body))
    return dict(statements=executable_statements(tree, span), declarations=declarations(tree, counts, listed),
        mainGuard=main_guard(tree), exports=bound_public_names(tree, listed), starImport=star, dynamicImports=dynamic_imports(tree))
`;
