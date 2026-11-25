"""One-off setup for the "Create images" button of ready-curtains.html.

  python tools/ready_curtains_image_setup.py <path to ingestion-agent folder> <path to CurtainsImages/references>

 1. Stores the Gemini API key (from the agent's .env) in Supabase Vault as ready_curtains_gemini_key,
    through fn_rc_set_secret (service role). The key is never printed.
 2. Uploads the approved golden pictures (generated, no customer homes) to the private bucket ready-curtains under
    _templates/ so the edge function can edit them.
Re-run any time the key or the reference photos change.
"""
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path


def read_env(path):
    env = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def main():
    agent = Path(sys.argv[1])
    refs = Path(sys.argv[2])
    env = read_env(agent / ".env")
    base, key = env["SUPABASE_URL"].rstrip("/"), env["SUPABASE_SERVICE_KEY"]
    hdr = {"apikey": key, "Authorization": "Bearer " + key}

    req = urllib.request.Request(base + "/rest/v1/rpc/fn_rc_set_secret", method="POST",
                                 data=json.dumps({"p_name": "ready_curtains_gemini_key", "p_value": env["GEMINI_API_KEY"]}).encode(),
                                 headers={**hdr, "Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=60).read()
    print("Gemini key stored in Vault.")

    for f in sorted(refs.glob("golden_*.jpg")):
        req = urllib.request.Request(
            base + "/storage/v1/object/ready-curtains/_templates/" + urllib.parse.quote(f.name), method="POST",
            data=f.read_bytes(), headers={**hdr, "Content-Type": "image/jpeg", "x-upsert": "true"})
        urllib.request.urlopen(req, timeout=120).read()
        print("uploaded _templates/" + f.name)


if __name__ == "__main__":
    main()
