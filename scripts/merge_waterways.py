#!/usr/bin/env python3
"""Merged community-waterways.geojson + osm-waterways.geojson → waterways.geojson + manifest."""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
COMMUNITY_PATH = ROOT / "community-waterways.geojson"
OSM_PATH = ROOT / "osm-waterways.geojson"
WATERWAYS_PATH = ROOT / "waterways.geojson"
MANIFEST_PATH = ROOT / "waterways-manifest.json"

SPATIAL_DEDUP_METERS = 30.0
DATA_URL = (
    "https://raw.githubusercontent.com/3ddruck12/flowtrail-pegel/main/waterways.geojson"
)
GUIDES_URL = (
    "https://raw.githubusercontent.com/3ddruck12/flowtrail-pegel/main/river-guides.json"
)


def load_geojson(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"type": "FeatureCollection", "features": []}
    return json.loads(path.read_text(encoding="utf-8"))


def write_geojson(path: Path, data: dict[str, Any], compact: bool = False) -> None:
    if compact:
        text = json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n"
    else:
        text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    path.write_text(text, encoding="utf-8")


def haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6_371_000.0
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(d_lon / 2) ** 2
    )
    return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def line_coords(feature: dict[str, Any]) -> list[tuple[float, float]]:
    geometry = feature.get("geometry") or {}
    gtype = geometry.get("type")
    coords_raw = geometry.get("coordinates") or []
    points: list[tuple[float, float]] = []

    if gtype == "LineString":
        for c in coords_raw:
            if len(c) >= 2:
                points.append((float(c[1]), float(c[0])))
    elif gtype == "MultiLineString":
        for line in coords_raw:
            for c in line:
                if len(c) >= 2:
                    points.append((float(c[1]), float(c[0])))
    return points


def line_midpoint(feature: dict[str, Any]) -> tuple[float, float] | None:
    points = line_coords(feature)
    if not points:
        return None
    return points[len(points) // 2]


def blocked_osm_ids(community: list[dict[str, Any]]) -> set[str]:
    blocked: set[str] = set()
    for feature in community:
        props = feature.get("properties") or {}
        replaces = props.get("replaces_osm_ids") or []
        if isinstance(replaces, str) and replaces.strip():
            blocked.add(replaces.strip())
        elif isinstance(replaces, list):
            for item in replaces:
                if item:
                    blocked.add(str(item).strip())
        single = props.get("replaces_osm_id", "").strip()
        if single:
            blocked.add(single)
    return blocked


def filter_osm_features(
    osm_features: list[dict[str, Any]],
    community: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    blocked = blocked_osm_ids(community)
    community_midpoints = [
        mp for f in community if (mp := line_midpoint(f)) is not None
    ]

    filtered: list[dict[str, Any]] = []
    for feature in osm_features:
        props = feature.get("properties") or {}
        osm_id = props.get("osm_id", "")
        if osm_id and osm_id in blocked:
            continue

        mp = line_midpoint(feature)
        if mp and community_midpoints:
            lat, lon = mp
            too_close = any(
                haversine_meters(lat, lon, c_lat, c_lon) <= SPATIAL_DEDUP_METERS
                for c_lat, c_lon in community_midpoints
            )
            if too_close:
                continue

        filtered.append(feature)

    filtered.sort(
        key=lambda f: (
            (f.get("properties") or {}).get("river", ""),
            (f.get("properties") or {}).get("name", ""),
        )
    )
    return filtered


def feature_kind(feature: dict[str, Any]) -> str:
    props = feature.get("properties") or {}
    if props.get("feature_kind"):
        return str(props["feature_kind"])
    if (feature.get("geometry") or {}).get("type") == "Point":
        return "point"
    return "waterway"


def merge_and_write(version: str | None = None) -> dict[str, int]:
    community_data = load_geojson(COMMUNITY_PATH)
    osm_data = load_geojson(OSM_PATH)
    community_all = community_data.get("features", [])
    community_rivers = [
        f for f in community_all if feature_kind(f) in ("waterway", "portage", "portage_road")
    ]
    community_points = [f for f in community_all if feature_kind(f) in ("einstieg", "ausstieg", "point")]
    osm_raw = osm_data.get("features", [])
    osm_filtered = filter_osm_features(osm_raw, community_all)

    now = datetime.now(timezone.utc)
    if version is None:
        version = now.strftime("%Y-%m-%dT%H%M")

    merged = {
        "type": "FeatureCollection",
        "metadata": {
            "name": "FlowTrail Waterways",
            "description": (
                "Community-Gewässer und OSM-Flussläufe für Kanufahrer. "
                "OSM: © OpenStreetMap contributors (ODbL)."
            ),
            "version": version,
        },
        "features": community_rivers + community_points + osm_filtered,
    }
    write_geojson(WATERWAYS_PATH, merged, compact=True)

    manifest = {
        "version": version,
        "updatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "label": (
            f"FlowTrail Gewässer ({len(community_rivers)} Linien, {len(community_points)} Punkte, "
            f"{len(osm_filtered)} OSM)"
        ),
        "dataUrl": DATA_URL,
        "guidesUrl": GUIDES_URL,
    }
    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    stats = {
        "community_lines": len(community_rivers),
        "community_points": len(community_points),
        "osm_raw": len(osm_raw),
        "osm_merged": len(osm_filtered),
        "total": len(merged["features"]),
    }
    print(
        f"Merge: {stats['community_lines']} community-Linien + {stats['community_points']} Punkte + "
        f"{stats['osm_merged']} osm = {stats['total']} gesamt"
    )
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Community + OSM → waterways.geojson mergen"
    )
    parser.add_argument("--version", default=None, help="Manifest-Version (Default: jetzt UTC)")
    args = parser.parse_args()
    merge_and_write(args.version)


if __name__ == "__main__":
    main()
