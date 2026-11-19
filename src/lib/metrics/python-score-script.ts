import { PYTHON_DIAGNOSTIC_LIB } from "./diagnostic-python-script.js";
import { PYTHON_FACTS_SCRIPT } from "./python-facts-script.js";

/**
 * Fixed stdlib-only scoring analyzer: the shared diagnostic helpers (documentation spans, cyclomatic decisions) plus
 * cognitive complexity, Halstead values, exclusive token exposure, imports, literal dead stores and `Any` annotations.
 * Target source is parsed and tokenized with `ast` / `tokenize`; it is never imported, compiled for execution or run.
 */
const PYTHON_SCORE_EXTRAS = String.raw`
import bisect, keyword, math, re, warnings
warnings.simplefilter('ignore')

DEFS = (ast.FunctionDef, ast.AsyncFunctionDef)
SKIPPED_TOP = DEFS + (ast.ClassDef, ast.Import, ast.ImportFrom)
TRY_NODES = (ast.Try,) + ((ast.TryStar,) if hasattr(ast, 'TryStar') else ())
STRING_MIDDLE = getattr(token, 'FSTRING_MIDDLE', -1)
IGNORED_FSTRING = {getattr(token, 'FSTRING_START', -2), getattr(token, 'FSTRING_END', -3)}
LITERAL_TYPES = (str, bytes, int, float, complex, bool, type(None))

def positions2(source):
    lines = source.split('\n')
    starts, total = [], 0
    for line in lines:
        starts.append(total)
        total += len(line) + 1
    def char_pos(line, col):
        return starts[min(line - 1, len(starts) - 1)] + col
    def ast_pos(line, col):
        return char_pos(line, len(lines[line - 1].encode('utf8')[:col].decode('utf8')))
    def span(node):
        return (ast_pos(node.lineno, node.col_offset), ast_pos(node.end_lineno, node.end_col_offset))
    return char_pos, span

def utf16_mapper(source):
    if source.isascii():
        return lambda index: index
    acc = [0] * (len(source) + 1)
    for i, ch in enumerate(source):
        acc[i + 1] = acc[i] + (2 if ord(ch) > 0xFFFF else 1)
    return lambda index: acc[index]

def collect_functions(tree):
    found = []
    def walk(node, prefix, depth):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.ClassDef):
                walk(child, prefix + child.name + '.', depth)
            elif isinstance(child, DEFS):
                found.append((child, prefix + child.name, depth))
                walk(child, '', depth + 1)
            else:
                walk(child, prefix, depth)
    walk(tree, '', 0)
    return found

def bool_operands(node):
    for value in node.values:
        if isinstance(value, ast.BoolOp) and type(value.op) is type(node.op):
            yield from bool_operands(value)
        else:
            yield value

def cognitive(fn, depth):
    total = [0]
    def children(node, nesting):
        for child in ast.iter_child_nodes(node):
            visit(child, nesting)
    def block(statements, nesting):
        for statement in statements:
            visit(statement, nesting)
    def branch(node, nesting, flat):
        total[0] += 1 if flat else 1 + nesting
        visit(node.test, nesting)
        block(node.body, nesting + 1)
        orelse = node.orelse
        if len(orelse) == 1 and isinstance(orelse[0], ast.If):
            branch(orelse[0], nesting, True)
        elif orelse:
            total[0] += 1
            block(orelse, nesting + 1)
    def loop(node, nesting):
        total[0] += 1 + nesting
        for field in ('iter', 'test'):
            if hasattr(node, field):
                visit(getattr(node, field), nesting)
        block(node.body, nesting + 1)
        block(node.orelse, nesting + 1)
    def handler_try(node, nesting):
        block(node.body, nesting)
        for handler in node.handlers:
            total[0] += 1 + nesting
            block(handler.body, nesting + 1)
        block(node.orelse, nesting)
        block(node.finalbody, nesting)
    def match(node, nesting):
        total[0] += 1 + nesting
        visit(node.subject, nesting)
        for case in node.cases:
            block(case.body, nesting + 1)
    def visit(node, nesting):
        if isinstance(node, DEFS + (ast.ClassDef,)):
            return
        if isinstance(node, ast.Lambda):
            children(node, nesting + 1)
        elif isinstance(node, ast.If):
            branch(node, nesting, False)
        elif isinstance(node, (ast.For, ast.AsyncFor, ast.While)):
            loop(node, nesting)
        elif isinstance(node, TRY_NODES):
            handler_try(node, nesting)
        elif isinstance(node, ast.Match):
            match(node, nesting)
        elif isinstance(node, ast.IfExp):
            total[0] += 1 + nesting
            for part in (node.test, node.body, node.orelse):
                visit(part, nesting + 1)
        elif isinstance(node, ast.BoolOp):
            total[0] += 1
            for operand in bool_operands(node):
                visit(operand, nesting)
        else:
            children(node, nesting)
    block(fn.body, depth)
    return total[0]

def halstead(operators, operands):
    n1, n2 = len(operators), len(operands)
    big1, big2 = sum(operators.values()), sum(operands.values())
    volume = (big1 + big2) * math.log2(n1 + n2) if n1 + n2 > 1 else 0.0
    difficulty = (n1 / 2) * (big2 / n2) if n2 else 0.0
    return volume, difficulty

def type_checking(test):
    return (isinstance(test, ast.Name) and test.id == 'TYPE_CHECKING') or (isinstance(test, ast.Attribute) and test.attr == 'TYPE_CHECKING')

def collect_imports(nodes, typed, out):
    for node in nodes:
        if isinstance(node, ast.Import):
            for alias in node.names:
                out.append(dict(module=alias.name, level=0, names=['*'], line=node.lineno, typeOnly=typed))
        elif isinstance(node, ast.ImportFrom):
            out.append(dict(module=node.module or '', level=node.level, names=[alias.name for alias in node.names], line=node.lineno, typeOnly=typed))
        elif isinstance(node, ast.If) and type_checking(node.test):
            collect_imports(node.body, True, out)
            collect_imports(node.orelse, typed, out)
        else:
            collect_imports(ast.iter_child_nodes(node), typed, out)

def single_name_assign(node):
    return isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)

def overwritten_literal(first, second):
    if not single_name_assign(first) or not single_name_assign(second):
        return False
    if not isinstance(first.value, ast.Constant) or not isinstance(first.value.value, LITERAL_TYPES):
        return False
    name = first.targets[0].id
    if second.targets[0].id != name:
        return False
    return not any(isinstance(n, ast.Name) and n.id == name for n in ast.walk(second.value))

def dead_stores(tree):
    lines, initializers = [], 0
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) for t in node.targets):
            initializers += 1
        elif isinstance(node, ast.AnnAssign) and node.value is not None and isinstance(node.target, ast.Name):
            initializers += 1
        for field in ('body', 'orelse', 'finalbody'):
            statements = getattr(node, field, None)
            if not isinstance(statements, list):
                continue
            for first, second in zip(statements, statements[1:]):
                if overwritten_literal(first, second):
                    lines.append(first.lineno)
    return sorted(lines), initializers

def mentions_any(annotation):
    for node in ast.walk(annotation):
        if isinstance(node, ast.Name) and node.id == 'Any':
            return True
        if isinstance(node, ast.Attribute) and node.attr == 'Any':
            return True
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and re.search(r'\bAny\b', node.value):
            return True
    return False

def annotation_slots(tree):
    slots = []
    for node in ast.walk(tree):
        if isinstance(node, DEFS):
            arguments = node.args
            every = arguments.posonlyargs + arguments.args + arguments.kwonlyargs + [a for a in (arguments.vararg, arguments.kwarg) if a is not None]
            slots.extend(a.annotation for a in every if a.annotation is not None)
            if node.returns is not None:
                slots.append(node.returns)
        elif isinstance(node, ast.AnnAssign):
            slots.append(node.annotation)
    return len(slots), sorted(slot.lineno for slot in slots if mentions_any(slot))

def significant_tokens(source, char_pos, docs):
    doc_starts = [a for a, b in docs]
    result = []
    for item in tokenize.generate_tokens(io.StringIO(source).readline):
        if item.type in IGNORED or item.type in IGNORED_FSTRING:
            continue
        start, end = char_pos(*item.start), char_pos(*item.end)
        index = bisect.bisect_right(doc_starts, start) - 1
        if index >= 0 and end <= docs[index][1]:
            continue
        result.append((start, end, item, item.type in LAYOUT))
    return result

def classify(item):
    if item.type == token.OP:
        return 'operator', item.string
    if item.type == token.NAME:
        return ('operator' if keyword.iskeyword(item.string) else 'operand'), item.string
    if item.type in (token.NUMBER, token.STRING, STRING_MIDDLE):
        return 'operand', item.string
    return None, None

def sweep(tokens, ranges):
    stack, pointer = [], 0
    for start, end, item, layout in tokens:
        while stack and ranges[stack[-1]][1] <= start:
            stack.pop()
        while pointer < len(ranges) and ranges[pointer][0] <= start:
            if start < ranges[pointer][1]:
                stack.append(pointer)
            pointer += 1
        yield start, end, item, layout, stack

def analyze_score(source):
    tree = ast.parse(source)
    char_pos, span = positions2(source)
    to16 = utf16_mapper(source)
    docs = sorted(documentation(tree, span))
    tokens = significant_tokens(source, char_pos, docs)
    callables = sorted((node for node in ast.walk(tree) if isinstance(node, FUNCTIONS)), key=lambda node: (span(node)[0], -span(node)[1]))
    ranges = [span(node) for node in callables]
    inclusive, exclusive = [0] * len(callables), [0] * len(callables)
    operators, operands = [dict() for _ in callables], [dict() for _ in callables]
    top_spans = sorted(span(st) for st in tree.body if not isinstance(st, SKIPPED_TOP) and span(st) not in docs)
    top_starts = [a for a, b in top_spans]
    top_tokens, written = 0, 0
    for start, end, item, layout, stack in sweep(tokens, ranges):
        if layout:
            continue
        written += 1
        kind, text = classify(item)
        for index in stack:
            inclusive[index] += 1
            if kind is not None and isinstance(callables[index], DEFS):
                bucket = operators[index] if kind == 'operator' else operands[index]
                bucket[text] = bucket.get(text, 0) + 1
        if stack:
            exclusive[stack[-1]] += 1
        else:
            at = bisect.bisect_right(top_starts, start) - 1
            if at >= 0 and end <= top_spans[at][1]:
                top_tokens += 1
    starts = [start for start, end, item, layout in tokens]
    by_node = {id(node): index for index, node in enumerate(callables)}
    functions = []
    for node, name, depth in collect_functions(tree):
        index = by_node[id(node)]
        start, end = ranges[index]
        body = [st for st in node.body if span(st) not in docs]
        body_start = span(body[0])[0] if body else end
        volume, difficulty = halstead(operators[index], operands[index])
        sequence = None
        if inclusive[index] >= 30 and body:
            low, high = bisect.bisect_left(starts, body_start), bisect.bisect_right(starts, end)
            sequence = [(item.type, '' if layout else item.string) for a, b, item, layout in tokens[low:high] if b <= end]
        functions.append(dict(name=name, line=node.lineno, endLine=node.end_lineno, startOffset=to16(start), endOffset=to16(end),
            tokens=inclusive[index], exposure=exclusive[index], cyclomatic=1 + sum(decisions(st, node) for st in body),
            cognitive=cognitive(node, depth), volume=volume, difficulty=difficulty, cloneTokens=sequence, bodyStart=to16(body_start)))
    imports = []
    collect_imports([tree], False, imports)
    dead, initializers = dead_stores(tree)
    slots, any_lines = annotation_slots(tree)
    return dict(astTokens=written, topLevelTokens=top_tokens, functions=functions, imports=imports, deadStores=dead,
        initializers=initializers, annotationSlots=slots, anyLines=any_lines, facts=module_facts(tree, span))

results = []
for entry in json.load(sys.stdin):
    try:
        results.append(dict(path=entry['path'], result=analyze_score(entry['content'])))
    except (SyntaxError, ValueError, TypeError, tokenize.TokenError, IndentationError, RecursionError) as error:
        results.append(dict(path=entry['path'], error=type(error).__name__ + ': source could not be analyzed'))
print(json.dumps(dict(parser=sys.version.split()[0], files=results), separators=(',', ':')))
`;

export const PYTHON_SCORE_SCRIPT = PYTHON_DIAGNOSTIC_LIB + PYTHON_FACTS_SCRIPT + PYTHON_SCORE_EXTRAS;
