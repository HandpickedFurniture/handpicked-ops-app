"""Translation-key parity for ops-app, adapted from pfc-order-app/check_i18n.py.

That app kept one I18N object with `ui` and `v` sub-sections in a single HTML file. Here the
translations live in js/i18n.js as three flat objects (en / hi / bn), so the brace-matching is
against `<lang>: {` at the top level instead.

    python check_i18n.py            # defaults to js/i18n.js
"""
import re
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "js/i18n.js"
src = open(path, encoding="utf-8").read()

KEY = re.compile(r'"([^"]+)"\s*:')
PAIR = re.compile(r'"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"')


def section(lang):
    """Raw body of the I18N.<lang> object, by brace matching."""
    m = re.search(r"\n  " + lang + r":\s*\{", src)
    if not m:
        return None
    s = m.end()
    depth, i = 1, s
    while depth > 0:
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
        i += 1
    return src[s:i - 1]


def keys(lang):
    body = section(lang)
    return [] if body is None else KEY.findall(body)


def vals(lang):
    body = section(lang)
    return {} if body is None else dict(PAIR.findall(body))


en, hi, bn = keys("en"), keys("hi"), keys("bn")
print(f"keys   en={len(en)}  hi={len(hi)}  bn={len(bn)}")

problems = []
for lang, ks in (("hi", hi), ("bn", bn)):
    missing = [k for k in en if k not in ks]
    extra = [k for k in ks if k not in en]
    if missing:
        problems.append(f"{lang} MISSING: {missing}")
    if extra:
        problems.append(f"{lang} EXTRA: {extra}")

dup = [k for k in set(en) if en.count(k) > 1]
if dup:
    problems.append(f"duplicate keys in en: {sorted(dup)}")

# placeholders like {n} must survive translation or interpolation breaks
ev, hv, bv = vals("en"), vals("hi"), vals("bn")
ph = lambda s: sorted(re.findall(r"\{(\w+)\}", s))
for k in en:
    if k in hv and ph(ev.get(k, "")) != ph(hv[k]):
        problems.append(f"hi placeholder mismatch on {k}: {ph(ev[k])} vs {ph(hv[k])}")
    if k in bv and ph(ev.get(k, "")) != ph(bv[k]):
        problems.append(f"bn placeholder mismatch on {k}: {ph(ev[k])} vs {ph(bv[k])}")

# Every key the app asks for must exist. Two ways it asks:
#   tr("some.key")            - a literal
#   { value: "x", key: "..."} - a config.js entry, later resolved by tr(x.key) / tv(list, value)
used = set()
import glob
import os
for f in glob.glob(os.path.join(os.path.dirname(path) or ".", "*.js")):
    body = open(f, encoding="utf-8").read()
    used |= set(re.findall(r'\btr\(\s*"([^"]+)"', body))
    used |= set(re.findall(r'\bkey:\s*"([^"]+)"', body))
unknown = sorted(k for k in used if k not in ev)
if unknown:
    problems.append(f"tr() references keys that do not exist: {unknown}")

unused = sorted(k for k in ev if k not in used)
if unused:
    print(f"note: {len(unused)} keys defined but never referenced: {unused}")

same_hi = [k for k in en if k in hv and hv[k] == ev.get(k) and not re.match(r"^[\W\d_]*$", ev.get(k, "x"))]
same_bn = [k for k in en if k in bv and bv[k] == ev.get(k) and not re.match(r"^[\W\d_]*$", ev.get(k, "x"))]
if same_hi:
    print(f"note: {len(same_hi)} hi strings identical to English: {same_hi}")
if same_bn:
    print(f"note: {len(same_bn)} bn strings identical to English: {same_bn}")

print()
if problems:
    print("PROBLEMS:")
    for p in problems:
        print("  -", p)
    sys.exit(1)
print("OK - all three languages have matching keys and placeholders")
