// interlinked-tdd: exempt
// @codegen-data — embedded Python program, config part (joined in check-python-script.ts).
// Data only; behaviour is tested through check-python-roots.test.ts and check-python-imports.test.ts.
// Import roots that static files in the repository declare: pyproject.toml build sections, INI-style
// files, a literal setup(...) call, .pth and .egg-link files. Every function takes text or a parsed
// document and returns directory strings; nothing here runs project code.
// Keep backticks and dollar-brace sequences out of this text: it is a template literal.

export const PYTHON_CONFIG_PART = String.raw`

# --- import roots declared in static files --------------------------------------------------


def package_dir_entries(mapping, dirs, aliases):
    """A setuptools package_dir mapping: '' = dir is a root; name = dir is a root when dir ends in name, else an alias."""
    if not isinstance(mapping, dict):
        return
    for key, value in mapping.items():
        if not isinstance(key, str) or not isinstance(value, str):
            continue
        if key == "":
            dirs.append(value)
            continue
        top = key.split(".")[0]
        norm = posixpath.normpath(value)
        if "." not in key and posixpath.basename(norm) == key:
            dirs.append(posixpath.dirname(norm) or ".")
        else:
            aliases.append(top)


def keys_or_strings(value):
    return list(value.keys()) if isinstance(value, dict) else strings_of(value)


def package_parents(values):
    """Directories that hold the named package directories (hatch packages, pdm includes). Globs are left out."""
    found = []
    for value in values:
        if not any(char in value for char in "*?["):
            parent = posixpath.dirname(posixpath.normpath(value))
            if parent:
                found.append(parent)
    return found


def pyproject_dirs(data):
    """(directories, alias names), simple string literals only: pytest pythonpath, setuptools package-dir and
    find where, poetry packages from, hatch sources and packages, pdm package-dir and includes, uv
    build-backend module-root, maturin python-source."""
    dirs = strings_of(section(data, "tool", "pytest", "ini_options", "pythonpath"))
    dirs += strings_of(section(data, "tool", "pytest", "pythonpath"))
    aliases = []
    package_dir_entries(section(data, "tool", "setuptools", "package-dir"), dirs, aliases)
    dirs += strings_of(section(data, "tool", "setuptools", "packages", "find", "where"))
    for entry in section(data, "tool", "poetry", "packages") or []:
        dirs += strings_of(entry.get("from")) if isinstance(entry, dict) else []
    hatch = section(data, "tool", "hatch", "build")
    if isinstance(hatch, dict):
        tables = [hatch] + [item for item in (hatch.get("targets") or {}).values() if isinstance(item, dict)]
        for table in tables:
            dirs += keys_or_strings(table.get("sources"))
            dirs += package_parents(strings_of(table.get("packages")))
    pdm = section(data, "tool", "pdm", "build")
    if isinstance(pdm, dict):
        dirs += strings_of(pdm.get("package-dir"))
        dirs += package_parents(strings_of(pdm.get("includes")))
    dirs += strings_of(section(data, "tool", "uv", "build-backend", "module-root"))
    dirs += strings_of(section(data, "tool", "maturin", "python-source"))
    return dirs, aliases


def ini_values(text, wanted):
    """{(section, key): value} for the wanted pairs of an INI-style file; a file that does not parse gives nothing."""
    parser = configparser.ConfigParser(interpolation=None, strict=False)
    try:
        parser.read_string(text)
    except configparser.Error:
        return {}
    found = {}
    for name, key in wanted:
        if parser.has_option(name, key):
            found[(name, key)] = parser.get(name, key)
    return found


def cfg_dirs(name, text):
    """(directories, alias names) from pytest.ini, tox.ini and setup.cfg."""
    dirs, aliases = [], []
    wanted = [("tool:pytest" if name == "setup.cfg" else "pytest", "pythonpath")]
    if name == "setup.cfg":
        wanted += [("options", "package_dir"), ("options.packages.find", "where")]
    for (section_name, key), value in ini_values(text, wanted).items():
        if key in ("pythonpath", "where"):
            dirs += value.split()
        else:
            mapping = {}
            for line in value.splitlines():
                if "=" in line:
                    left, right = line.split("=", 1)
                    mapping[left.strip()] = right.strip()
            package_dir_entries(mapping, dirs, aliases)
    return dirs, aliases


def setup_call_dirs(data):
    """(directories, alias names) from literal arguments of the setup(...) call; the file is parsed, never run."""
    try:
        tree = ast.parse(data)
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        return [], []
    dirs, aliases = [], []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        callee = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", "")
        if callee == "setup":
            for keyword in node.keywords:
                if keyword.arg == "package_dir" and isinstance(keyword.value, ast.Dict):
                    mapping = {}
                    for key, value in zip(keyword.value.keys, keyword.value.values):
                        if isinstance(key, ast.Constant) and isinstance(value, ast.Constant):
                            mapping[key.value] = value.value
                    package_dir_entries(mapping, dirs, aliases)
        elif callee in ("find_packages", "find_namespace_packages"):
            for keyword in node.keywords:
                if keyword.arg == "where" and isinstance(keyword.value, ast.Constant) and isinstance(keyword.value.value, str):
                    dirs.append(keyword.value.value)
            if node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                dirs.append(node.args[0].value)
    return dirs, aliases


# --- native extension modules that a build file names ----------------------------------------


def native_names_pyproject(data):
    """Dotted module names from [tool.maturin] module-name and [[tool.setuptools.ext-modules]] name literals."""
    names = strings_of(section(data, "tool", "maturin", "module-name"))
    tables = section(data, "tool", "setuptools", "ext-modules")
    for entry in tables if isinstance(tables, list) else []:
        if isinstance(entry, dict):
            names += strings_of(entry.get("name"))
    return names


def literal_string(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def setup_native(data):
    """(module names, cffi build scripts) from literal arguments in setup.py: Extension-like calls
    (first positional or name=) and cffi_modules=['script.py:var']. The file is parsed, never run."""
    try:
        tree = ast.parse(data)
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        return [], []
    names, builders = [], []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        callee = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", "")
        if callee.endswith("Extension"):
            first = literal_string(node.args[0]) if node.args else None
            names += [first] if first else []
            names += [literal_string(keyword.value) for keyword in node.keywords if keyword.arg == "name"]
        elif callee == "setup":
            for keyword in node.keywords:
                if keyword.arg == "cffi_modules" and isinstance(keyword.value, (ast.List, ast.Tuple)):
                    builders += [item.split(":")[0] for item in map(literal_string, keyword.value.elts) if item]
    return names, builders


def set_source_names(data):
    """Module names from literal ffibuilder.set_source('pkg._name', ...) calls of a cffi build script."""
    try:
        tree = ast.parse(data)
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        return []
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, "attr", "") in ("set_source", "set_source_pkgconfig") and node.args:
            found.append(literal_string(node.args[0]))
    return found


def meson_native_names(text):
    """pkg._name from literal py.extension_module('_name', ..., subdir: 'pkg') calls in a meson.build file."""
    names = []
    for match in re.finditer(r"extension_module\s*\(", text):
        depth, index = 1, match.end()
        while index < len(text) and depth:
            depth += 1 if text[index] == "(" else -1 if text[index] == ")" else 0
            index += 1
        call = text[match.end():index]
        first = re.match(r"\s*['\"]([A-Za-z_]\w*)['\"]", call)
        if first:
            subdir = re.search(r"subdir\s*:\s*['\"]([\w./-]+)['\"]", call)
            prefix = subdir.group(1).strip("/").replace("/", ".") + "." if subdir else ""
            names.append(prefix + first.group(1))
    return names


def path_lines(text):
    """The path lines of a .pth file or the first line of an .egg-link; import statements and comments are left out."""
    lines = []
    for raw in text.splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and not line.startswith("import ") and not line.startswith("import\t"):
            lines.append(line)
    return lines
`;
