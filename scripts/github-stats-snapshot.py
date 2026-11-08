#!/usr/bin/env python3
"""Send a daily snapshot of StatGlass's GitHub release and traffic counts to PostHog.

The app sends no telemetry, so adoption is read from what GitHub already counts:
DMG downloads, updater bundle downloads, and fetches of the updater manifest
(one per update check, so a rough proxy for running installs). GitHub only keeps
running totals, so this records them once a day to make a time series.

Events go to the shared Steamfield PostHog project with `site: "statglass"`:
  github_release_snapshotted  one per release, cumulative counts per asset kind
  github_repo_snapshotted     totals across releases, plus stars and forks
  github_traffic_snapshotted  yesterday's clones and views (needs a token with
                              repository Administration read; skipped without one)

Each event's uuid is derived from the day and release, so a rerun on the same
day repeats the same uuids instead of adding new rows.

Env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/name), POSTHOG_PROJECT_KEY,
POSTHOG_HOST (default https://us.i.posthog.com), TRAFFIC_TOKEN (optional).
"""
import argparse
import datetime as dt
import json
import os
import sys
import urllib.request
import uuid

DISTINCT_ID = "github-stats-statglass"
UUID_NAMESPACE = uuid.UUID("5b0d7c1e-3f7a-4c55-9d0e-2a51c0f1b7a4")

# Asset name suffix -> kind. Order matters: `.sig` files and checksums are not
# downloads anyone counts, and "latest.json" must win over "release.json".
ASSET_KINDS = (
    (".sig", None),
    ("SHA256SUMS", None),
    (".dmg", "dmg"),
    (".app.tar.gz", "updater_bundle"),
    ("latest.json", "update_check"),
    ("release.json", "release_manifest"),
    ("agent-aarch64-unknown-linux-musl", "agent_linux_aarch64"),
    ("agent-x86_64-unknown-linux-musl", "agent_linux_x86_64"),
)
KINDS = sorted({kind for _, kind in ASSET_KINDS if kind})


def asset_kind(name):
    for suffix, kind in ASSET_KINDS:
        if name.endswith(suffix):
            return kind
    return None


def github(path, token):
    request = urllib.request.Request(
        f"https://api.github.com{path}",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def releases(repo, token):
    page = 1
    while True:
        batch = github(f"/repos/{repo}/releases?per_page=100&page={page}", token)
        if not batch:
            return
        yield from batch
        page += 1


def event(name, day, key, properties):
    return {
        "event": name,
        "uuid": str(uuid.uuid5(UUID_NAMESPACE, f"{day}:{name}:{key}")),
        "timestamp": f"{day}T00:00:00Z",
        "properties": {
            "distinct_id": DISTINCT_ID,
            "$process_person_profile": False,
            "site": "statglass",
            **properties,
        },
    }


def release_events(repo, token, day):
    events, totals = [], dict.fromkeys(KINDS, 0)
    for release in releases(repo, token):
        if release["draft"]:
            continue
        counts = dict.fromkeys(KINDS, 0)
        for asset in release["assets"]:
            kind = asset_kind(asset["name"])
            if kind:
                counts[kind] += asset["download_count"]
        for kind, count in counts.items():
            totals[kind] += count
        events.append(event("github_release_snapshotted", day, release["tag_name"], {
            "release": release["tag_name"],
            "published_at": release["published_at"],
            "prerelease": release["prerelease"],
            **{f"{kind}_downloads": count for kind, count in counts.items()},
        }))
    return events, totals


def traffic_event(repo, token, day):
    yesterday = (dt.date.fromisoformat(day) - dt.timedelta(days=1)).isoformat()

    def on(path, field):
        for entry in github(f"/repos/{repo}/traffic/{path}", token)[field]:
            if entry["timestamp"].startswith(yesterday):
                return entry["count"], entry["uniques"]
        return 0, 0

    clones, clone_uniques = on("clones", "clones")
    views, view_uniques = on("views", "views")
    return event("github_traffic_snapshotted", yesterday, "traffic", {
        "clones": clones,
        "clone_uniques": clone_uniques,
        "views": views,
        "view_uniques": view_uniques,
    })


def send(events, host, key):
    body = json.dumps({"api_key": key, "batch": events}).encode()
    request = urllib.request.Request(
        f"{host.rstrip('/')}/batch/", data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise RuntimeError(f"PostHog returned {response.status}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="print events instead of sending")
    args = parser.parse_args()

    repo = os.environ["GITHUB_REPOSITORY"]
    token = os.environ["GITHUB_TOKEN"]
    day = dt.datetime.now(dt.timezone.utc).date().isoformat()

    events, totals = release_events(repo, token, day)
    meta = github(f"/repos/{repo}", token)
    events.append(event("github_repo_snapshotted", day, "repo", {
        "stars": meta["stargazers_count"],
        "forks": meta["forks_count"],
        "releases": len(events),
        **{f"{kind}_downloads": count for kind, count in totals.items()},
    }))
    if traffic_token := os.environ.get("TRAFFIC_TOKEN"):
        events.append(traffic_event(repo, traffic_token, day))
    else:
        print("TRAFFIC_TOKEN not set; skipping clone and view counts", file=sys.stderr)

    if args.dry_run:
        print(json.dumps(events, indent=2))
        return
    send(events, os.environ.get("POSTHOG_HOST", "https://us.i.posthog.com"),
         os.environ["POSTHOG_PROJECT_KEY"])
    print(f"Sent {len(events)} events for {day}")


if __name__ == "__main__":
    main()
