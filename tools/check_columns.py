#!/usr/bin/env python3
"""Every column this app SELECTs must still exist. Run it after any change to js/ or to a view.

WHY THIS EXISTS. On 16 Aug 2026 a migration rebuilt v_ops_order_roster and quietly dropped
report_meters and meters_is_received. Nothing failed at deploy time. Nothing failed in a test.
It failed the next morning, for the staff, on four screens at once - Production, Preparation,
Dashboard and Reports - because PostgREST refuses the WHOLE request when one column in the select
list is missing. The only symptom was a red box reading
"column v_ops_order_roster.report_meters does not exist".

That class of break is invisible until somebody opens the tab. This closes it.

HOW IT WORKS, and why it needs no credentials: PostgREST resolves the select list before RLS is
applied, so an UNAUTHENTICATED request carrying the publishable key already shipped in js/config.js
returns 400 for a bad column and 200 with [] for a good one. The check therefore exercises the same
code path the browser does, rather than a re-implementation of it that could drift.

Usage:
    python tools/check_columns.py             # from the repo root
    python tools/check_columns.py --verbose

Exit codes: 0 pass, 1 a column is missing, 2 the script could not run.
"""
import concurrent.futures
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(ROOT, "js")
VERBOSE = "--verbose" in sys.argv or "-v" in sys.argv
# --hook emits Claude Code hook JSON on stdout instead of a human report, so the settings.json
# command stays a single dependency-free invocation (this machine has no jq)
HOOK = "--hook" in sys.argv

URL_RE = re.compile(r"""/rest/v1/([a-z0-9_]+)\?select=([^"'`&\s]+)""")
CONST_RE = re.compile(r"const\s+(\w+)\s*=\s*\[")
SPREAD_RE = re.compile(r"\.\.\.(\w+)\.map\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\2\.(\w+)")

# Select lists the scanner cannot resolve statically. Prefer teaching the scanner; use this only
# when the list is genuinely built at runtime. An explicit entry a human must maintain is more
# honest than a regex that silently matches less than it appears to.
MANIFEST = []


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def config():
    """SB_URL and SB_KEY come from js/config.js, so this can never test a different project than
    the one the app ships against."""
    src = read(os.path.join(JS, "config.js"))
    url = re.search(r'SB_URL\s*=\s*"([^"]+)"', src)
    key = re.search(r'SB_KEY\s*=\s*"([^"]+)"', src)
    if not url or not key:
        print("FATAL: could not read SB_URL / SB_KEY from js/config.js", file=sys.stderr)
        sys.exit(2)
    return url.group(1), key.group(1)


def arrays(src):
    """Every `const NAME = [ ... ]` in a file, found by MATCHING BRACKETS, not by regex.

    A non-greedy [(.*?)].join looks like it works and does not: it runs happily from one const's
    opening bracket to a LATER const's closing bracket, capturing the wrong array and losing the
    right one entirely. That is how an earlier version of this script reported PASS while silently
    checking neither of the two select lists it claimed to be skipping.

    Returns {name: (body, tail)} where tail is the text just after the closing bracket - enough to
    tell a select list (`].join(",")`) from a plain lookup table.
    """
    out, i = {}, 0
    while True:
        m = CONST_RE.search(src, i)
        if not m:
            return out
        j, depth = m.end() - 1, 0
        instr, quote, esc = False, "", False
        while j < len(src):
            c = src[j]
            if instr:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == quote:
                    instr = False
            elif c in "\"'`":
                instr, quote = True, c
            elif c in "[{(":
                depth += 1
            elif c in "]})":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        name, body, tail = m.group(1), src[m.end():j], src[j + 1:j + 20]
        # the same name can be declared in two scopes - mod-finance has a `cols` for the select
        # list and another inside copyForSheet. Keep whichever one is a select list.
        prev = out.get(name)
        if prev is None or (not prev[1].lstrip().startswith(".join")):
            out[name] = (body, tail)
        i = j + 1


def collect():
    """Every (table, select-list) pair the app asks PostgREST for."""
    pairs, unresolved = [], []
    shared = arrays(read(os.path.join(JS, "config.js")))
    for name in sorted(os.listdir(JS)):
        if not name.endswith(".js"):
            continue
        src = read(os.path.join(JS, name))
        # config.js holds the shared vocabularies (SPECIAL_COLS and friends) that several modules
        # spread into their select lists, so it has to be in scope for every file, not just itself
        found = dict(shared)
        found.update(arrays(src))

        consts = {}
        for cname, (body, tail) in found.items():
            if not tail.lstrip().startswith(".join"):
                continue                                   # a lookup table, not a select list
            cols = re.findall(r'"([A-Za-z0-9_]+)"', body)
            ok = True
            # ...OTHER.map((c) => c.k) - resolved from the object array it names, because this
            # codebase builds several of its select lists that way
            for sp in SPREAD_RE.finditer(body):
                other, key = sp.group(1), sp.group(3)
                if other in found:
                    cols += re.findall(key + r'\s*:\s*"([a-z0-9_]+)"', found[other][0])
                else:
                    ok = False
            if re.search(r"\.\.\.\w", body) and not SPREAD_RE.search(body):
                ok = False                                 # some other spread we cannot follow
            # never let a guess masquerade as coverage
            consts[cname] = ",".join(dict.fromkeys(cols)) if ok else "__UNRESOLVED__"

        for m in URL_RE.finditer(src):
            table, sel = m.group(1), m.group(2)
            line = src.count("\n", 0, m.start()) + 1
            sel = re.sub(r"\$\{(\w+)\}",
                         lambda mm: consts.get(mm.group(1), "__UNRESOLVED__"), sel)
            if "__UNRESOLVED__" in sel or "${" in sel:
                unresolved.append((name, line, table))
                continue
            pairs.append((table, sel, "%s:%d" % (name, line)))

    for table, sel in MANIFEST:
        pairs.append((table, sel, "MANIFEST"))
    return pairs, unresolved


def probe(base, key, table, select):
    url = "%s/rest/v1/%s?select=%s&limit=0" % (base, table, select)
    req = urllib.request.Request(url, headers={"apikey": key, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, ""
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            body = json.loads(body).get("message", body)
        except ValueError:
            pass
        return e.code, body
    except Exception as e:                                 # network, DNS, TLS
        return 0, str(e)


def main():
    base, key = config()
    pairs, unresolved = collect()
    if not pairs:
        print("FATAL: found no select lists at all - the scanner is broken", file=sys.stderr)
        return 2

    bad, files = [], set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(probe, base, key, t, s_): (t, s_, w) for t, s_, w in pairs}
        for fut in concurrent.futures.as_completed(futures):
            table, _sel, where = futures[fut]
            status, msg = fut.result()
            if where != "MANIFEST":
                files.add(where.split(":")[0])
            if status == 200:
                if VERBOSE:
                    print("  ok   %-34s %s" % (table, where))
            elif status == 0:
                print("FATAL: cannot reach the database (%s)" % msg, file=sys.stderr)
                return 2
            else:
                bad.append((table, where, status, msg))

    print("checked %d select lists across %d files" % (len(pairs), len(files)))

    covered = {t for t, _ in MANIFEST}
    for name, line, table in unresolved:
        if table in covered:
            continue
        print("  WARN  %s:%d builds its select for %s at runtime - NOT checked. "
              "Add it to MANIFEST." % (name, line, table))

    if bad:
        print("\nFAILED - %d select list(s) the database will refuse:\n" % len(bad))
        for table, where, status, msg in bad:
            print("  %s  (%s)\n      HTTP %s: %s\n" % (table, where, status, msg))
        print("Fix the view or the module BEFORE deploying. This is exactly the failure that took")
        print("Production, Preparation, Dashboard and Reports down on the morning of 17 Aug 2026.")
        return 1

    print("PASS - every column the app selects exists.")
    return 0


def hook():
    """Stop-hook mode: block the turn when a column is missing, stay silent when all is well.

    A FATAL (no network, unreachable database) does NOT block. The check cannot prove anything
    offline, and refusing to let somebody finish because their wifi dropped teaches them to turn
    the hook off - which costs more than the check earns.
    """
    buf = io.StringIO()
    real, sys.stdout = sys.stdout, buf
    try:
        code = main()
    finally:
        sys.stdout = real
    out = buf.getvalue().strip()

    if code == 1:
        print(json.dumps({
            "decision": "block",
            "reason": "Database column check FAILED - do not deploy." + chr(10) + chr(10) + out,
            "systemMessage": "Column check failed: the app selects a column the database "
                             "does not have.",
        }))
    elif code == 2:
        print(json.dumps({
            "systemMessage": "Column check could not run (database unreachable). "
                             "Run tools/check_columns.py before deploying.",
        }))
    return 0


if __name__ == "__main__":
    if HOOK:
        sys.exit(hook())
    sys.exit(main())
