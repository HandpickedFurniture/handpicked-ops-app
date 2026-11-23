"""One-off: give the ready-curtains edge function its own Google Drive access.

Run on a PC with a browser:  python tools/ready_curtains_drive_auth.py <path to ingestion-agent folder>

 1. Opens Google's consent page for the OAuth client in gmail_credentials.json, asking ONLY for the
    drive.file scope (files this app creates - it cannot read the user's other Drive files, and has no Gmail
    access, unlike the agent's shared token).
 2. Stores the resulting refresh token in Supabase Vault as ready_curtains_drive_token, and a fresh random
    ready_curtains_cron_key, through fn_rc_set_secret (service role). Nothing secret is printed.
 3. Calls the edge function once so the Ready_Curtains folder is created in My Drive straight away.

Re-run it any time to replace the token (e.g. after revoking access in the Google account).
"""
import json
import secrets
import sys
import urllib.request
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/drive.file"]


def read_env(path):
    env = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def rpc(base, key, fn, args):
    req = urllib.request.Request(
        base + "/rest/v1/rpc/" + fn, data=json.dumps(args).encode(), method="POST",
        headers={"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode()


def main():
    agent = Path(sys.argv[1] if len(sys.argv) > 1 else "../ingestion-agent")
    env = read_env(agent / ".env")
    base, key = env["SUPABASE_URL"].rstrip("/"), env["SUPABASE_SERVICE_KEY"]

    flow = InstalledAppFlow.from_client_secrets_file(str(agent / "gmail_credentials.json"), SCOPES)
    creds = flow.run_local_server(port=0, prompt="consent", access_type="offline",
                                  authorization_prompt_message="Opening Google in your browser - choose the Handpicked account and press Allow...",
                                  success_message="Done - you can close this tab and go back to Claude.")
    if not creds.refresh_token:
        sys.exit("Google did not return a refresh token - run again.")
    token = json.dumps({"client_id": creds.client_id, "client_secret": creds.client_secret,
                        "refresh_token": creds.refresh_token, "scopes": SCOPES})
    rpc(base, key, "fn_rc_set_secret", {"p_name": "ready_curtains_drive_token", "p_value": token})
    cron_key = secrets.token_urlsafe(32)
    rpc(base, key, "fn_rc_set_secret", {"p_name": "ready_curtains_cron_key", "p_value": cron_key})
    print("Drive access stored in Vault.")

    # a sync run creates the Ready_Curtains folder in My Drive and copies anything already waiting
    req = urllib.request.Request(base + "/functions/v1/ready-curtains", method="POST", data=b'{"action":"sync"}',
                                 headers={"Content-Type": "application/json", "x-cron-key": cron_key})
    with urllib.request.urlopen(req, timeout=150) as r:
        print("Sync run:", r.read().decode())


if __name__ == "__main__":
    main()
