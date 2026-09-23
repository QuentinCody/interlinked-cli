/** Parse candidate text only. The isolated interpreter never imports or executes it. */
export const REPEATED_IMPLEMENTATION_PYTHON = String.raw`
import ast, json, sys
tree = ast.parse(sys.stdin.read())
rows = []
for fn in ast.walk(tree):
    if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
        continue
    body = list(fn.body)
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
        body = body[1:]
    nodes = [n for stmt in body for n in ast.walk(stmt)]
    if any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)) for n in nodes):
        continue
    if sum(isinstance(n, ast.stmt) for n in nodes) < 5:
        continue
    names, literals = {}, []
    def shape(n):
        if isinstance(n, ast.Constant):
            literals.append(repr(n.value)[:48])
            return ['Constant', type(n.value).__name__]
        if isinstance(n, ast.Name):
            if n.id not in names:
                names[n.id] = len(names)
            return ['Name', names[n.id], type(n.ctx).__name__]
        if isinstance(n, ast.Call):
            # Different call targets are not interchangeable operations.
            return ['Call', ast.dump(n.func, include_attributes=False), shape(n.args), shape(n.keywords)]
        if isinstance(n, ast.AST):
            return [type(n).__name__, [[k, shape(v)] for k, v in ast.iter_fields(n)]]
        if isinstance(n, list):
            return [shape(v) for v in n]
        return n
    normalized = shape(body)
    rows.append(dict(name=fn.name, line=fn.lineno,
        shape=json.dumps([type(fn).__name__, ast.dump(fn.args, include_attributes=False), normalized], separators=(',', ':')),
        literals=literals))
print(json.dumps(rows))
`;
