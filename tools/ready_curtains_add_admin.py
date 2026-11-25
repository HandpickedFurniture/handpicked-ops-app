"""Approve the FIRST admin of ready-curtains.html (later people are approved on the page itself: People).

  python tools/ready_curtains_add_admin.py <path to ingestion-agent folder> <email> ["Name"]

Adds the email to rc_people as an admin and opens a one-time link (7 days) in this computer's browser, where the person chooses their own
password. The link is not printed and not stored: only its SHA-256 is in the database. Run again for a new link (e.g. forgotten password).
"""
import hashlib
import json
import secrets
import sys
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timedelta, timezone
from pathlib import Path

PAGE = "https://handpickedfurniture.github.io/handpicked-ops-app/ready-curtains.html"


def main():
    env = {}
    for line in (Path(sys.argv[1]) / ".env").read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    email, name = sys.argv[2].strip().lower(), (sys.argv[3] if len(sys.argv) > 3 else None)
    if "@" not in email:
        sys.exit("not an email address")
    base, key = env["SUPABASE_URL"].rstrip("/"), env["SUPABASE_SERVICE_KEY"]

    def call(method, path, body, prefer):
        req = urllib.request.Request(base + "/rest/v1/" + path, method=method, data=json.dumps(body).encode(),
                                     headers={"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json", "Prefer": prefer})
        return urllib.request.urlopen(req, timeout=60).read()

    code = secrets.token_urlsafe(32)
    row = {"email": email, "is_admin": True, "active": True, "setup_hash": hashlib.sha256(("setup|" + code).encode()).hexdigest(),
           "setup_expires": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()}
    if name:
        row["name"] = name
    call("POST", "rc_people?on_conflict=email", row, "resolution=merge-duplicates,return=minimal")
    webbrowser.open(PAGE + "?k=" + urllib.parse.quote(secrets.token_hex(3)) + "#setup=" + code)
    print(email, "is an admin. The browser now shows the page to choose the password.")


if __name__ == "__main__":
    main()
