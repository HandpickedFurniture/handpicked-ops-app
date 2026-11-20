"""The fabric rules exist in exactly one file - and Chotu needs a copy of it to deploy.

js/fabric-calc-core.js is the fabricCalculation rules (the ops-app screen imports it, the chat skill imports
it). supabase/functions/chotu/fabric-calc-core.js is the copy that ships with the Chotu Edge Function, which
cannot import from outside its folder. If the two differ, Chotu is answering with different rules from the
screen - so this fails until they are byte-for-byte the same.

    python tools/check_fabric_core.py          # from ops-app/
    copy js/fabric-calc-core.js supabase/functions/chotu/   then redeploy chotu (Supabase MCP, verify_jwt true)

The worked cases themselves are run by the skill:  node ~/.claude/skills/fabricCalculation/calc.mjs --test
"""
import hashlib
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parent.parent
master = root / "js" / "fabric-calc-core.js"
copy = root / "supabase" / "functions" / "chotu" / "fabric-calc-core.js"

h = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()[:12]
if not copy.exists():
    sys.exit(f"FAIL - {copy} is missing: Chotu cannot deploy without it")
if master.read_bytes() != copy.read_bytes():
    sys.exit(f"FAIL - Chotu's copy of the fabric rules differs from js/fabric-calc-core.js "
             f"({h(copy)} vs {h(master)}). Copy it over and redeploy chotu.")
print(f"OK - Chotu's fabric rules are the same file as the app's ({h(master)})")
