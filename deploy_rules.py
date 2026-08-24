"""Deploys firestore.rules to the live Firestore ruleset via the Firebase Rules REST API.

Usage:
  GCLOUD_TOKEN=$(gcloud auth print-access-token) python deploy_rules.py

Uses only the standard library (no `requests` dependency) so it runs anywhere Python does.
"""
import json
import os
import sys
import urllib.request
import urllib.error

PROJECT_ID = "familyledgerta"
RULES_FILE = "firestore.rules"


def api_call(method: str, url: str, token: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Goog-User-Project", PROJECT_ID)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code} calling {method} {url}:", e.read().decode("utf-8"), file=sys.stderr)
        raise


def main() -> None:
    token = os.environ.get("GCLOUD_TOKEN")
    if not token:
        print("Set GCLOUD_TOKEN (e.g. GCLOUD_TOKEN=$(gcloud auth print-access-token) python deploy_rules.py)", file=sys.stderr)
        sys.exit(1)

    with open(RULES_FILE, "r", encoding="utf-8") as f:
        rules_content = f.read()

    print(f"Creating ruleset from {RULES_FILE}...")
    ruleset = api_call(
        "POST",
        f"https://firebaserules.googleapis.com/v1/projects/{PROJECT_ID}/rulesets",
        token,
        {"source": {"files": [{"name": RULES_FILE, "content": rules_content}]}},
    )
    ruleset_name = ruleset["name"]
    print(f"Created {ruleset_name}")

    print("Updating cloud.firestore release...")
    api_call(
        "PATCH",
        f"https://firebaserules.googleapis.com/v1/projects/{PROJECT_ID}/releases/cloud.firestore",
        token,
        {"release": {"name": f"projects/{PROJECT_ID}/releases/cloud.firestore", "rulesetName": ruleset_name}},
    )
    print("Firestore rules deployed successfully.")


if __name__ == "__main__":
    main()
