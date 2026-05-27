#!/usr/bin/env python3
"""Importiert Flussläufe aus OpenStreetMap (Overpass) → osm-waterways.geojson + merge."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

ROOT = Path(__file__).resolve().parent.parent
OSM_PATH = ROOT / "osm-waterways.geojson"
MERGE_SCRIPT = ROOT / "scripts" / "merge_waterways.py"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "FlowTrail-Waterway-Import/1.0 (github.com/3ddruck12/flowtrail-pegel)"

BUNDESLAENDER: dict[str, str] = {
    "sh": 'area["ISO3166-2"="DE-SH"][admin_level=4]',
    "hh": 'area["ISO3166-2"="DE-HH"][admin_level=4]',
    "ni": 'area["ISO3166-2"="DE-NI"][admin_level=4]',
    "hb": 'area["ISO3166-2"="DE-HB"][admin_level=4]',
    "nw": 'area["ISO3166-2"="DE-NW"][admin_level=4]',
    "he": 'area["ISO3166-2"="DE-HE"][admin_level=4]',
    "rp": 'area["ISO3166-2"="DE-RP"][admin_level=4]',
    "bw": 'area["ISO3166-2"="DE-BW"][admin_level=4]',
    "by": 'area["ISO3166-2"="DE-BY"][admin_level=4]',
    "sl": 'area["ISO3166-2"="DE-SL"][admin_level=4]',
    "be": 'area["ISO3166-2"="DE-BE"][admin_level=4]',
    "bb": 'area["ISO3166-2"="DE-BB"][admin_level=4]',
    "mv": 'area["ISO3166-2"="DE-MV"][admin_level=4]',
    "sn": 'area["ISO3166-2"="DE-SN"][admin_level=4]',
    "st": 'area["ISO3166-2"="DE-ST"][admin_level=4]',
    "th": 'area["ISO3166-2"="DE-TH"][admin_level=4]',
}

OVERPASS_QUERY = """\
[out:json][timeout:300];
{area_selector}->.searchArea;
(
  way["waterway"="river"](area.searchArea);
  way["waterway"="canal"](area.searchArea);
);
out body geom qt;
"""


def build_query(area_selector: str) -> str:
    return OVERPASS_QUERY.format(area_selector=area_selector)


def fetch_overpass(area_selector: str, retries: int = 3) -> list[dict[str, Any]]:
    query = build_query(area_selector)
    headers = {"User-Agent": USER_AGENT}
    last_error: Exception | None = None

    for attempt in range(1, retries + 1):
        try:
            response = requests.post(
                OVERPASS_URL,
                data={"data": query},
                headers=headers,
                timeout=320,
            )
            response.raise_for_status()
            payload = response.json()
            return payload.get("elements", [])
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt < retries:
                wait = 20 * attempt
                print(f"  Overpass-Fehler ({exc}), Retry in {wait}s …", file=sys.stderr)
                time.sleep(wait)

    raise RuntimeError(f"Overpass-Abfrage fehlgeschlagen: {last_error}") from last_error


def river_from_tags(tags: dict[str, str]) -> str:
    for key in ("name", "waterway:name", "destination"):
        value = tags.get(key, "").strip()
        if value:
            return value
    waterway = tags.get("waterway", "").strip()
    if waterway in ("river", "stream", "canal"):
        return ""
    return waterway


def name_from_tags(tags: dict[str, str], osm_id: str) -> str:
    name = tags.get("name", "").strip()
    if name:
        waterway = tags.get("waterway", "river")
        return f"{name} ({waterway})"
    ref = tags.get("ref", "").strip()
    if ref:
        return ref
    return f"Gewässer {osm_id}"


def should_import_way(tags: dict[str, str]) -> bool:
    """Kanu-relevant: Flüsse und Kanäle."""
    return tags.get("waterway", "").strip() in ("river", "canal")


def round_coords(coords: list[list[float]]) -> list[list[float]]:
    return [[round(c[0], 5), round(c[1], 5)] for c in coords]


def element_to_feature(element: dict[str, Any]) -> dict[str, Any] | None:
    if element.get("type") != "way":
        return None

    tags = element.get("tags") or {}
    if not should_import_way(tags):
        return None

    geometry = element.get("geometry")
    if not geometry or len(geometry) < 2:
        return None

    coords = round_coords([[float(node["lon"]), float(node["lat"])] for node in geometry])
    osm_id = f"way/{element['id']}"
    waterway_type = tags.get("waterway", "river")

    return {
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": coords},
        "properties": {
            "id": osm_id.replace("/", "-"),
            "name": name_from_tags(tags, osm_id),
            "river": river_from_tags(tags),
            "waterway": waterway_type,
            "source": "osm",
            "osm_id": osm_id,
        },
    }


def fetch_waterways_for_regions(region_codes: list[str]) -> list[dict[str, Any]]:
    by_osm_id: dict[str, dict[str, Any]] = {}

    for code in region_codes:
        selector = BUNDESLAENDER[code]
        print(f"Abfrage Bundesland {code.upper()} …")
        elements = fetch_overpass(selector)
        converted = 0
        skipped = 0

        for element in elements:
            feature = element_to_feature(element)
            if feature is None:
                skipped += 1
                continue
            osm_id = feature["properties"]["osm_id"]
            by_osm_id[osm_id] = feature
            converted += 1

        print(f"  {len(elements)} Elemente, {converted} Linien, {skipped} übersprungen")

    return list(by_osm_id.values())


def resolve_regions(region: str) -> list[str]:
    region = region.lower()
    if region == "de":
        return list(BUNDESLAENDER.keys())
    if region not in BUNDESLAENDER:
        known = ", ".join(["de", *sorted(BUNDESLAENDER)])
        raise ValueError(f"Unbekannte Region '{region}'. Erlaubt: {known}")
    return [region]


def write_osm_file(osm_features: list[dict[str, Any]], version: str) -> None:
    osm_features.sort(
        key=lambda f: (
            f["properties"].get("river", ""),
            f["properties"].get("name", ""),
        )
    )
    payload = {
        "type": "FeatureCollection",
        "metadata": {
            "name": "FlowTrail OSM Waterways",
            "description": "Automatisch aus OpenStreetMap importierte Gewässerlinien (© OSM ODbL).",
            "version": version,
        },
        "features": osm_features,
    }
    OSM_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(f"Geschrieben: {len(osm_features)} OSM-Linien → {OSM_PATH.name}")


def run_merge(version: str) -> None:
    subprocess.run(
        [sys.executable, str(MERGE_SCRIPT), "--version", version],
        check=True,
        cwd=ROOT,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="OSM-Flussläufe importieren und mergen")
    parser.add_argument(
        "--region",
        default="nw",
        help="Region: de (alle Bundesländer) oder ISO-Code wie nw, by, bw …",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Nur abfragen und zählen, Dateien nicht schreiben",
    )
    args = parser.parse_args()

    region_codes = resolve_regions(args.region)
    osm_features = fetch_waterways_for_regions(region_codes)

    print(f"Gesamt: {len(osm_features)} eindeutige OSM-Gewässerlinien")

    if args.dry_run:
        print("Dry-run — keine Dateien geschrieben.")
        return

    version = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M")
    write_osm_file(osm_features, version)
    run_merge(version)


if __name__ == "__main__":
    main()
