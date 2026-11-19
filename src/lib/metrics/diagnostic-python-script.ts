/** Fixed stdlib-only analyzer. Target source is parsed/tokenized, never imported or executed. */
export const PYTHON_DIAGNOSTIC_LIB = String.raw`
import ast, bisect, io, json, sys, token, tokenize
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

def documentation(tree, span, walked=None):
    result = []
    for node in (walked if walked is not None else ast.walk(tree)):
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

def pattern_spans(tree, span, walked=None):
    matches = []
    for node in (walked if walked is not None else ast.walk(tree)):
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

def utf16_index(source):
    if source.isascii():
        return lambda index: index
    acc = [0] * (len(source) + 1)
    for i, ch in enumerate(source):
        acc[i + 1] = acc[i] + (2 if ord(ch) > 0xFFFF else 1)
    return lambda index: acc[index]

def analyze(source):
    tree = ast.parse(source)
    char_pos, span = positions(source)
    utf16 = utf16_index(source)
    walked = list(ast.walk(tree))
    docs = sorted(documentation(tree, span, walked))
    doc_set = set(docs)
    doc_starts = [a for a, b in docs]
    tokens = []
    for item in tokenize.generate_tokens(io.StringIO(source).readline):
        start, end = char_pos(*item.start), char_pos(*item.end)
        at = bisect.bisect_right(doc_starts, start) - 1
        if item.type in IGNORED or (at >= 0 and end <= docs[at][1]):
            continue
        tokens.append((start, end, item, item.type in LAYOUT))
    starts = [start for start, end, item, layout in tokens]
    nodes = sorted((node for node in walked if isinstance(node, FUNCTIONS)), key=lambda node: span(node))
    ranges = [span(node) for node in nodes]
    order = sorted(range(len(nodes)), key=lambda i: (ranges[i][0], -ranges[i][1]))
    owned = [set() for node in nodes]
    inclusive = [0] * len(nodes)
    sloc = set()
    def token_lines(item):
        return range(item.start[0], item.end[0] + int(item.end[1] > 0))
    stack, pointer = [], 0
    for start, end, item, layout in tokens:
        while stack and ranges[stack[-1]][1] <= start:
            stack.pop()
        while pointer < len(order) and ranges[order[pointer]][0] <= start:
            if start < ranges[order[pointer]][1]:
                stack.append(order[pointer])
            pointer += 1
        if layout:
            continue
        lines = set(token_lines(item))
        sloc.update(lines)
        for index in stack:
            inclusive[index] += 1
        if stack:
            owned[stack[-1]].update(lines)
    def window(a, b):
        return tokens[bisect.bisect_left(starts, a):bisect.bisect_right(starts, b)]
    def covered(a, b):
        return sorted({line for start, end, item, layout in window(a, b) if not layout and end <= b for line in token_lines(item)})
    functions = []
    for i, node in enumerate(nodes):
        if not owned[i]:
            raise ValueError('Callable token ownership unavailable')
        start, end = ranges[i]
        body = [node.body] if isinstance(node, ast.Lambda) else [st for st in node.body if span(st) not in doc_set]
        body_start = span(body[0])[0] if body else end
        sequence = [(item.type, '' if layout else item.string) for a, b, item, layout in window(body_start, end) if b <= end]
        size = inclusive[i]
        functions.append(dict(name=getattr(node, 'name', '(lambda)'), line=node.lineno, endLine=node.end_lineno,
            startOffset=utf16(start), endOffset=utf16(end), sloc=len(owned[i]), cyclomatic=1 + sum(decisions(child, node) for child in body),
            cloneTokens=sequence if size >= 30 and body else [], cloneLines=covered(body_start, end), bodyStart=utf16(body_start)))
    patterns = [dict(startOffset=utf16(a), endOffset=utf16(b), lines=covered(a, b)) for a, b in pattern_spans(tree, span, walked)]
    return dict(sloc=len(sloc), functions=functions, patterns=patterns)
`;

/** Shared driver: reads a JSON list of `{path, content}` from stdin and prints one result per file. */
export const PYTHON_DIAGNOSTIC_MAIN = String.raw`
results = []
for entry in json.load(sys.stdin):
    try:
        results.append(dict(path=entry['path'], result=analyze(entry['content'])))
    except (SyntaxError, ValueError, TypeError, tokenize.TokenError, IndentationError, RecursionError) as error:
        results.append(dict(path=entry['path'], error=type(error).__name__ + ': source could not be analyzed'))
print(json.dumps(dict(parser=sys.version.split()[0], files=results), separators=(',', ':')))
`;

export const PYTHON_DIAGNOSTIC_SCRIPT = PYTHON_DIAGNOSTIC_LIB + PYTHON_DIAGNOSTIC_MAIN;
