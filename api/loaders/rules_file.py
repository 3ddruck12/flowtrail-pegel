"""Lädt Kanu-Mindestpegel aus data/rules.json (ersetzt Kanu-NRW-Scraper)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from models.schemas import RiverRule


def _num(entry: dict[str, Any], *keys: str) -> float:
    for key in keys:
        if key in entry and entry[key] is not None:
            return float(entry[key])
    raise KeyError(f"Pflichtfeld fehlt (erwartet eines von {keys})")


def parse_rule(entry: dict[str, Any]) -> RiverRule:
    river = str(entry["river"]).strip()
    station = str(entry["station"]).strip()
    min_cm = _num(entry, "min_cm", "min")
    ideal_min = float(entry.get("ideal_min_cm", entry.get("ideal_min", min_cm)))
    ideal_max = float(entry.get("ideal_max_cm", entry.get("ideal_max", min_cm * 1.6 + 25)))
    max_cm = float(entry.get("max_cm", entry.get("max", min_cm * 2.5 + 60)))

    return RiverRule(
        river=river,
        station=station,
        min=min_cm,
        ideal_min=ideal_min,
        ideal_max=ideal_max,
        max=max_cm,
        hint=entry.get("hint"),
        pegelonline_uuid=entry.get("pegelonline_uuid"),
        source="flowtrail_rules",
        nrw_befahrbarkeit=entry.get("nrw_befahrbarkeit"),
    )


def load_rules_from_file(path: Path) -> list[RiverRule]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, list):
        entries = raw
    elif isinstance(raw, dict):
        entries = raw.get("rules") or []
    else:
        raise ValueError("rules.json muss ein Objekt mit 'rules' oder eine Liste sein.")

    rules: list[RiverRule] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        rules.append(parse_rule(entry))

    if not rules:
        raise ValueError(f"Keine Regeln in {path}")

    return rules
