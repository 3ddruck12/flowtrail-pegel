#!/usr/bin/env python3
"""Erzeugt manifest.json + pegel.json für den statischen FlowTrail Pegel-Feed."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API_DIR = ROOT / "api"
sys.path.insert(0, str(API_DIR))

from services.river_service import RiverService  # noqa: E402

DATA_URL = "https://raw.githubusercontent.com/3ddruck12/flowtrail-pegel/main/pegel.json"


def main() -> None:
    service = RiverService()
    sync_result = service.sync_all()
    print("Sync:", sync_result)

    rivers_response = service.list_rivers()
    sections = service.export_all_statuses()

    now = datetime.now(timezone.utc)
    version = now.strftime("%Y-%m-%dT%H")

    pegel = {
        "updated_at": now.isoformat(),
        "rivers": [r.model_dump(mode="json") for r in rivers_response.rivers],
        "sections": [s.model_dump(mode="json") for s in sections],
    }

    manifest = {
        "version": version,
        "updatedAt": now.isoformat(),
        "label": "NRW Befahrbarkeit (rules.json + LHP + OpenHygon + PEGELONLINE)",
        "dataUrl": DATA_URL,
    }

    (ROOT / "pegel.json").write_text(
        json.dumps(pegel, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (ROOT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Exported {len(sections)} sections for {len(pegel['rivers'])} rivers")


if __name__ == "__main__":
    main()
