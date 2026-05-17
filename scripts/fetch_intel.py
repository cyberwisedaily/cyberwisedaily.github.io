#!/usr/bin/env python3
"""
fetch_intel.py — pulls fresh cybersecurity intel from free public feeds and
writes data/intel.json, which the static site reads on every page load.

Sources (all free, no enterprise keys):
  - CISA Known Exploited Vulnerabilities (KEV) catalog
  - NIST NVD CVE API 2.0 (no API key required for low-volume daily calls)

Run locally:
  pip install requests
  python scripts/fetch_intel.py

Designed to be invoked by the GitHub Actions workflow in
.github/workflows/daily-intel.yml.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

# ---------------------------------------------------------------------------
# Load .env when running locally (no-op in GitHub Actions where secrets are
# injected as real environment variables).
# ---------------------------------------------------------------------------
_env_file = Path(__file__).resolve().parent.parent / ".env"
if _env_file.exists():
    with open(_env_file) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _key, _, _val = _line.partition("=")
                os.environ.setdefault(_key.strip(), _val.strip())

import sys  # noqa: E402
from datetime import datetime, timedelta, timezone  # noqa: E402
from typing import Any

import requests

KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"
NVD_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0"
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "intel.json"

HTTP_TIMEOUT = 30
USER_AGENT = "CyberWiseDaily/1.0 (+https://github.com/) static-site cron"


# --------------------------------------------------------------------------- #
# Fetchers
# --------------------------------------------------------------------------- #

def fetch_kev() -> list[dict[str, Any]]:
    """Return CISA KEV vulnerabilities sorted newest-first."""
    r = requests.get(KEV_URL, timeout=HTTP_TIMEOUT, headers={"User-Agent": USER_AGENT})
    r.raise_for_status()
    data = r.json()
    vulns = data.get("vulnerabilities", [])
    vulns.sort(key=lambda v: v.get("dateAdded", ""), reverse=True)
    return vulns


def fetch_nvd_recent(hours: int = 24) -> list[dict[str, Any]]:
    """Return NVD CVEs published in the last `hours` hours."""
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=hours)
    params = {
        "pubStartDate": start.strftime("%Y-%m-%dT%H:%M:%S.000"),
        "pubEndDate": now.strftime("%Y-%m-%dT%H:%M:%S.000"),
        "resultsPerPage": 50,
    }
    try:
        r = requests.get(
            NVD_URL,
            params=params,
            timeout=HTTP_TIMEOUT,
            headers={"User-Agent": USER_AGENT},
        )
        r.raise_for_status()
        data = r.json()
        return data.get("vulnerabilities", [])
    except Exception as exc:
        # NVD occasionally rate-limits unauthenticated callers; degrade gracefully.
        print(f"[warn] NVD fetch failed, continuing without NVD data: {exc}", file=sys.stderr)
        return []


# --------------------------------------------------------------------------- #
# Transformers
# --------------------------------------------------------------------------- #

def severity_of(nvd_item: dict[str, Any]) -> tuple[str, float]:
    """Extract (severity, score) from an NVD entry, preferring CVSS v3.1."""
    metrics = nvd_item.get("cve", {}).get("metrics", {})
    for key in ("cvssMetricV31", "cvssMetricV30", "cvssMetricV2"):
        arr = metrics.get(key) or []
        if arr:
            cvss = arr[0].get("cvssData", {})
            return (
                str(cvss.get("baseSeverity") or arr[0].get("baseSeverity") or "UNKNOWN").upper(),
                float(cvss.get("baseScore") or 0.0),
            )
    return ("UNKNOWN", 0.0)


def english_description(nvd_item: dict[str, Any]) -> str:
    for d in nvd_item.get("cve", {}).get("descriptions", []):
        if d.get("lang") == "en":
            return d.get("value", "")
    return ""


def truncate(text: str, n: int = 220) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[: n - 1].rsplit(" ", 1)[0] + "…"


def kev_to_briefing(kev: dict[str, Any]) -> dict[str, Any]:
    cve_id = kev.get("cveID", "CVE-UNKNOWN")
    title_vendor = kev.get("vendorProject", "")
    title_product = kev.get("product", "")
    short = kev.get("shortDescription", "") or kev.get("vulnerabilityName", "")
    title = f"{cve_id}: {title_vendor} {title_product} actively exploited".strip()
    date_added = kev.get("dateAdded", "")
    return {
        "id": cve_id,
        "tag": "CRITICAL",
        "tag_class": "crit",
        "date": date_added.replace("-", ".") if date_added else "",
        "title": title,
        "excerpt": truncate(short, 220),
        "source_url": f"https://nvd.nist.gov/vuln/detail/{cve_id}",
    }


def nvd_to_briefing(item: dict[str, Any]) -> dict[str, Any]:
    cve = item.get("cve", {})
    cve_id = cve.get("id", "CVE-UNKNOWN")
    sev, score = severity_of(item)
    desc = english_description(item)
    published = cve.get("published", "")[:10]  # YYYY-MM-DD
    tag_class = "warn" if sev in ("HIGH", "CRITICAL") else ""
    tag = "ANALYSIS" if sev != "CRITICAL" else "CRITICAL"
    if sev == "CRITICAL":
        tag_class = "crit"
    return {
        "id": cve_id,
        "tag": tag,
        "tag_class": tag_class,
        "date": published.replace("-", ".") if published else "",
        "title": f"{cve_id} — {sev} (CVSS {score:.1f})",
        "excerpt": truncate(desc, 240),
        "source_url": f"https://nvd.nist.gov/vuln/detail/{cve_id}",
    }


# --------------------------------------------------------------------------- #
# Build payload
# --------------------------------------------------------------------------- #

def build_payload() -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    date_display = now.strftime("%Y.%m.%d")

    kev_all = fetch_kev()
    # KEV entries added in the last 30 days (gives us a steady stream)
    cutoff = (now - timedelta(days=30)).date().isoformat()
    kev_recent = [v for v in kev_all if v.get("dateAdded", "") >= cutoff]
    kev_today = [v for v in kev_all if v.get("dateAdded", "") == now.date().isoformat()]

    nvd_recent = fetch_nvd_recent(hours=24)
    nvd_critical = [n for n in nvd_recent if severity_of(n)[0] == "CRITICAL"]
    nvd_high = [n for n in nvd_recent if severity_of(n)[0] == "HIGH"]

    # ---- briefings: top KEV + top NVD, up to 6 cards ----
    briefings: list[dict[str, Any]] = []
    for v in kev_recent[:3]:
        briefings.append(kev_to_briefing(v))
    # Take top critical + high NVD entries by score
    nvd_for_cards = sorted(
        nvd_critical + nvd_high,
        key=lambda x: severity_of(x)[1],
        reverse=True,
    )[: max(0, 6 - len(briefings))]
    for n in nvd_for_cards:
        briefings.append(nvd_to_briefing(n))

    # Always have at least one card so the grid is never empty
    if not briefings:
        briefings.append({
            "id": "fallback",
            "tag": "INFO",
            "tag_class": "",
            "date": date_display,
            "title": "No new advisories from CISA KEV or NVD in the last 24h",
            "excerpt": "Quiet day on the public feeds. The analyst desk is reviewing partner sources for tomorrow's brief.",
            "source_url": "",
        })

    # ---- categories: same six categories, today_metric is dynamic ----
    categories = [
        {
            "id": "threat_intel",
            "num": "01",
            "title": "Threat Intelligence",
            "description": "Daily roundup of active campaigns, IOCs, and TTPs from open-source and partner feeds — distilled to what your team needs to act on.",
            "today_metric": f"{len(kev_today)} new KEV entr{'y' if len(kev_today) == 1 else 'ies'} today",
        },
        {
            "id": "daily_brief",
            "num": "02",
            "title": "06:00 Daily Brief",
            "description": "One email. Five minutes. Read with your first coffee — be ahead of standup. Plain text. No tracking pixels. No marketing.",
            "today_metric": f"Brief sent: {date_display}",
        },
        {
            "id": "playbooks",
            "num": "03",
            "title": "Defensive Playbooks",
            "description": "Weekly deep-dives on detection engineering, incident response, and hardening guides — written for practitioners, by practitioners.",
            "today_metric": f"{len(nvd_critical)} critical-severity playbook{'s' if len(nvd_critical) != 1 else ''} queued",
        },
        {
            "id": "post_mortems",
            "num": "04",
            "title": "Breach Post-Mortems",
            "description": "When something breaks, we tell you why — with timeline, attack chain, and the lessons your security program can apply tomorrow.",
            "today_metric": f"{len(kev_recent)} active exploits in last 30d",
        },
        {
            "id": "cve_watch",
            "num": "05",
            "title": "Vendor & CVE Watch",
            "description": "Track patches and advisories from major vendors. Critical CVEs flagged with exploitability context — not just CVSS scores.",
            "today_metric": f"{len(nvd_recent)} new CVEs in last 24h",
        },
        {
            "id": "career",
            "num": "06",
            "title": "Career & Community",
            "description": "Curated job board, conference signal-boost, and analyst notes from the field. The defender community, in one place.",
            "today_metric": "Weekly digest — Fridays",
        },
    ]

    # ---- terminal box: 3-5 short status lines ----
    terminal_lines: list[dict[str, str]] = []
    if nvd_critical:
        terminal_lines.append({"level": "CRIT", "text": f"{len(nvd_critical)} critical CVE{'s' if len(nvd_critical) != 1 else ''} published"})
    if kev_today:
        terminal_lines.append({"level": "CRIT", "text": f"{len(kev_today)} new KEV entr{'y' if len(kev_today) == 1 else 'ies'} today"})
    if nvd_high:
        terminal_lines.append({"level": "WARN", "text": f"{len(nvd_high)} high-severity advisor{'ies' if len(nvd_high) != 1 else 'y'}"})
    terminal_lines.append({"level": "INFO", "text": f"{len(nvd_recent)} CVEs ingested in 24h"})
    terminal_lines.append({"level": "INFO", "text": f"KEV catalog size: {len(kev_all)}"})

    # ---- threats tracked counter (used in hero status pill) ----
    threats_tracked = len(nvd_recent) + len(kev_today) + len(kev_recent)

    return {
        "generated_at": now.isoformat(timespec="seconds"),
        "generated_date_display": date_display,
        "threats_tracked": threats_tracked,
        "terminal": {
            "header_date": date_display,
            "lines": terminal_lines[:5],
        },
        "categories": categories,
        "briefings": briefings,
    }


def main() -> int:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = build_payload()
    OUTPUT_PATH.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"[ok] wrote {OUTPUT_PATH} — {len(payload['briefings'])} briefings, {payload['threats_tracked']} threats tracked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
