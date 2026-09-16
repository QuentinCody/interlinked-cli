/** Fixed stdlib-only analyzer. Target source is parsed/tokenized, never imported or executed. */
export const PYTHON_DIAGNOSTIC_SCRIPT = String.raw`
import ast, io, json, sys, token, tokenize
if sys.version_info < (3, 10):
    raise SystemExit('Python >=3.10 is required')

FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)
IGNORED = {token.ENDMARKER, tokenize.COMMENT, tokenize.ENCODING, tokenize.NL}
LAYOUT = {token.INDENT, token.DEDENT, token.NEWLINE}

def positions(source):
    lines = source.splitlines(keepends=True)
    starts, total = [], 0
    for line in lines:
        starts.append(total)
        total += len(line)
    starts.append(total)
    def char_pos(line, col):
        return starts[min(line - 1, len(starts) - 1)] + col
    def ast_pos(line, col):
        return char_pos(line, len(lines[line - 1].encode('utf8')[:col].decode('utf8')))
    def span(node):
        return (ast_pos(node.lineno, node.col_offset), ast_pos(node.end_lineno, node.end_col_offset))
    return char_pos, span

def documentation(tree, span):
    result = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if not node.body:
            continue
        first = node.body[0]
        if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
            result.append(span(first))
    return result

def decisions(node, root):
    if node is not root and isinstance(node, FUNCTIONS + (ast.ClassDef,)):
        return 0
    count = int(isinstance(node, (ast.If, ast.IfExp, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler, ast.Assert)))
    if isinstance(node, ast.BoolOp):
        count += len(node.values) - 1
    if isinstance(node, ast.comprehension):
        count += 1 + len(node.ifs)
    if isinstance(node, ast.match_case):
        wildcard = isinstance(node.pattern, ast.MatchAs) and node.pattern.pattern is None
        count += int(not wildcard) + int(node.guard is not None)
    return count + sum(decisions(child, root) for child in ast.iter_child_nodes(node))

def pattern_spans(tree, span):
    matches = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.If) or len(node.body) != 1 or len(node.orelse) != 1:
            continue
        a, b = node.body[0], node.orelse[0]
        if not isinstance(a, ast.Return) or not isinstance(b, ast.Return):
            continue
        if not isinstance(a.value, ast.Constant) or not isinstance(b.value, ast.Constant):
            continue
        if type(a.value.value) is bool and type(b.value.value) is bool and a.value.value != b.value.value:
            matches.append(span(node))
    return matches

def analyze(source):
    tree = ast.parse(source)
    char_pos, span = positions(source)
    docs = documentation(tree, span)
    tokens = []
    for item in tokenize.generate_tokens(io.StringIO(source).readline):
        start, end = char_pos(*item.start), char_pos(*item.end)
        if item.type in IGNORED or any(a <= start and end <= b for a, b in docs):
            continue
        tokens.append((start, end, item, item.type in LAYOUT))
    nodes = sorted((node for node in ast.walk(tree) if isinstance(node, FUNCTIONS)), key=lambda node: span(node))
    ranges = [span(node) for node in nodes]
    owned = [set() for node in nodes]
    sloc = set()
    def token_lines(item):
        return range(item.start[0], item.end[0] + int(item.end[1] > 0))
    for start, end, item, layout in tokens:
        if layout:
            continue
        lines = set(token_lines(item))
        sloc.update(lines)
        owners = [i for i, (a, b) in enumerate(ranges) if a <= start and end <= b]
        if owners:
            owner = min(owners, key=lambda i: ranges[i][1] - ranges[i][0])
            owned[owner].update(lines)
    def covered(a, b):
        return sorted({line for start, end, item, layout in tokens if not layout and a <= start and end <= b for line in token_lines(item)})
    def utf16(index):
        return len(source[:index].encode('utf-16-le')) // 2
    functions = []
    for i, node in enumerate(nodes):
        if not owned[i]:
            raise ValueError('Callable token ownership unavailable')
        start, end = ranges[i]
        body = [node.body] if isinstance(node, ast.Lambda) else [st for st in node.body if span(st) not in docs]
        body_start = span(body[0])[0] if body else end
        sequence = [(item.type, '' if layout else item.string) for a, b, item, layout in tokens if body_start <= a and b <= end]
        size = sum(1 for a, b, item, layout in tokens if not layout and start <= a and b <= end)
        functions.append(dict(name=getattr(node, 'name', '(lambda)'), line=node.lineno, endLine=node.end_lineno,
            startOffset=utf16(start), endOffset=utf16(end), sloc=len(owned[i]), cyclomatic=1 + sum(decisions(child, node) for child in body),
            cloneTokens=sequence if size >= 30 and body else [], cloneLines=covered(body_start, end), bodyStart=utf16(body_start)))
    patterns = [dict(startOffset=utf16(a), endOffset=utf16(b), lines=covered(a, b)) for a, b in pattern_spans(tree, span)]
    return dict(sloc=len(sloc), functions=functions, patterns=patterns)

results = []
for entry in json.load(sys.stdin):
    try:
        results.append(dict(path=entry['path'], result=analyze(entry['content'])))
    except (SyntaxError, ValueError, TypeError, tokenize.TokenError, IndentationError, RecursionError) as error:
        results.append(dict(path=entry['path'], error=type(error).__name__ + ': source could not be analyzed'))
print(json.dumps(dict(parser=sys.version.split()[0], files=results), separators=(',', ':')))
`;
