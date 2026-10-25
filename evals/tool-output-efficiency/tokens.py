"""Token estimates and bounded exact-text helpers; no transcript upload."""
import functools, hashlib, json, re
@functools.lru_cache(maxsize=1)
def encoding():
    # Pure parsing helpers and their offline tests need neither tiktoken nor a network fetch.
    # Keep tiktoken's normal disk cache so measurements reuse downloaded tokenizer tables.
    import tiktoken
    return tiktoken.get_encoding("o200k_base")
@functools.lru_cache(maxsize=8192)
def tokens(text):
    return sum(len(encoding().encode_ordinary(text[i:i+32768])) for i in range(0, len(text), 32768))
def digest(text):
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()
def serialize(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
def text_of(value):
    if isinstance(value, str): return value
    if isinstance(value, list): return "\n".join(text_of(v) for v in value)
    if not isinstance(value, dict): return ""
    if value.get("type") in ("image", "input_image", "redacted_thinking", "audio"): return ""
    for key in ("text", "content", "thinking"):
        if key in value: return text_of(value[key])
    return serialize(value)
def blocks(text):
    start = 0; batch = ""
    for line in text.splitlines(keepends=True):
        while len(line) > 2000:
            if batch: yield start, batch; start += len(batch); batch = ""
            yield start, line[:2000]; start += 2000; line = line[2000:]
        if batch and (batch.count("\n") >= 16 or len(batch) + len(line) > 2000):
            yield start, batch; start += len(batch); batch = ""
        batch += line
    if batch: yield start, batch
def normalized_line(line):
    return re.sub(r"^\s*\d+\s*(?:→|\\t|\t|\|)\s?", "", line).rstrip()
def shingles(text):
    words = re.findall(r"\w+", text)
    for i in range(max(0, len(words)-7)):
        value = " ".join(words[i:i+8])
        if len(value) >= 32:
            yield hashlib.blake2b(value.encode(), digest_size=8).digest()
PATH = re.compile(r"(?:[A-Za-z0-9_@.()+-]+/)*[A-Za-z0-9_@()+-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|json|md|toml|ya?ml|sh|txt|css|html)\b")
def paths(text):
    return {p.split("interlinked-cli/",1)[-1] for p in PATH.findall(text)}

