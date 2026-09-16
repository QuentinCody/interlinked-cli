/** Isolated stdlib AST analysis; never imports or executes the inspected source. */
export const PYTHON_SIMPLIFICATION_SCRIPT = String.raw`
import ast, json, sys
source = sys.stdin.read()
tree = ast.parse(source)
findings = []
def emit(node, kind, message):
    findings.append(dict(line=node.lineno, kind=kind, text=message))

for node in ast.walk(tree):
    if isinstance(node, (ast.For, ast.AsyncFor, ast.While)) and node.body and isinstance(node.body[-1], ast.Continue):
        emit(node.body[-1], 'cleanup', 'Trailing continue: reaching this loop boundary already continues. Remove this statement if no intentional control-flow distinction is needed.')
    if isinstance(node, ast.If) and node.body and isinstance(node.body[-1], (ast.Return, ast.Raise)) and len(node.orelse) == 1 and isinstance(node.orelse[0], ast.If):
        emit(node.orelse[0], 'cleanup', 'elif after an unconditional return/raise: consider a separate if to reduce nesting while preserving evaluation order.')

functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and not n.decorator_list]
parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
for fn in functions:
    args = [a.arg for a in fn.args.posonlyargs + fn.args.args + fn.args.kwonlyargs]
    body = fn.body
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
        body = body[1:]
    if fn.name.startswith('_') and not fn.name.startswith('__') and len(body) == 1 and isinstance(body[0], ast.Return) and isinstance(body[0].value, ast.Call):
        call = body[0].value
        references = [n for n in ast.walk(tree) if isinstance(n, ast.Name) and n.id == fn.name]
        callee = call.func.id if isinstance(call.func, ast.Name) else ''
        generic = fn.name.lstrip('_') in ('process_data', 'handle_data', 'build_result', 'process_items', 'handle_result')
        redundant_name = callee and fn.name.lstrip('_') == callee.lstrip('_')
        if len(references) == 1 and isinstance(parents.get(references[0]), ast.Call) and parents[references[0]].func is references[0] and (generic or redundant_name):
            emit(fn, 'helper', 'Private single-use forwarding helper ' + fn.name + ': consider inlining or naming the domain rule it adds; retain it if it establishes a useful boundary.')
    if len(args) >= 7:
        forwarded = []
        for stmt in body:
            for call in ast.walk(stmt):
                if isinstance(call, ast.Call):
                    values = call.args + [k.value for k in call.keywords]
                    count = sum(isinstance(v, ast.Name) and v.id in args for v in values)
                    if count >= 6:
                        forwarded.append(count)
        if forwarded:
            emit(fn, 'design', fn.name + ' forwards ' + str(max(forwarded)) + ' parameters: review responsibility and state ownership across the call chain; an options object alone does not simplify the behavior.')
print(json.dumps(findings))
`;
