"""Länderübergreifendes Hochwasserportal (LHP) – Hochwasserklassen.

API-Dokumentation: https://www.hochwasserzentralen.de/developers/api-docs-stable-swagger
Live-Server: https://api.hochwasserzentralen.de/public/v1
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx
from cachetools import TTLCache
from tenacity import retry, stop_after_attempt, wait_exponential

from config import settings

logger = logging.getLogger(__name__)

# Quelle: LHP-PublicAPI legend (lhpClass)
LHP_CLASS_NAMES: dict[int, str] = {
    4: "Sehr großes Hochwasser",
    3: "Großes Hochwasser",
    2: "Mittleres Hochwasser",
    1: "Kleines Hochwasser",
    0: "Kein Hochwasser",
    -1: "Derzeit keine Daten",
}


class HochwasserZentralenClient:
    """LHP liefert Hochwasser-Klassifizierungen pro Pegel (keine cm-Werte)."""

    def __init__(self, base_url: str | None = None, cache_ttl: int = 600) -> None:
        self.base_url = (base_url or settings.lhp_api_base_url).rstrip("/")
        self._cache: TTLCache[str, dict[str, str]] = TTLCache(maxsize=2, ttl=cache_ttl)
        self.headers = {
            "User-Agent": "FlowTrail/1.0 (LHP integration; +https://github.com/3ddruck12/FlowTrail)",
            "Accept": "application/json",
        }

    @retry(stop=stop_after_attempt(2), wait=wait_exponential(multiplier=1, min=1, max=5))
    def _get_json(self, path: str) -> Any:
        url = f"{self.base_url}/{path.lstrip('/')}"
        with httpx.Client(timeout=30.0, headers=self.headers) as client:
            response = client.get(url)
            response.raise_for_status()
            return response.json()

    def fetch_flood_classes(self, force_refresh: bool = False) -> dict[str, str]:
        """
        Gibt Mapping station_key → flood_class zurück.
        station_key = normalisierter 'Fluss Messstelle' String.
        """
        if not force_refresh and "classes" in self._cache:
            return self._cache["classes"]

        try:
            payload = self._get_json("data/stations")
        except Exception as exc:
            logger.warning(
                "LHP API nicht erreichbar (%s) – Hochwasser-Overlay deaktiviert", exc
            )
            self._cache["classes"] = {}
            return {}

        mapping = self._parse_stations(payload)
        self._cache["classes"] = mapping
        logger.info("LHP: %s Pegel mit Hochwasserklassifizierung", len(mapping))
        return mapping

    def _parse_stations(self, payload: Any) -> dict[str, str]:
        from clients.pegelonline import normalize_name

        mapping: dict[str, str] = {}
        stations: list[Any] = []

        if isinstance(payload, dict):
            if isinstance(payload.get("data"), list):
                stations = payload["data"]
            elif isinstance(payload.get("features"), list):
                stations = payload["features"]

        for item in stations:
            if not isinstance(item, dict):
                continue

            props = item.get("properties") if item.get("type") == "Feature" else item
            if not isinstance(props, dict):
                props = item

            river = props.get("water") or props.get("gewaesser") or props.get("river") or ""
            station = props.get("name") or props.get("station") or props.get("longname") or ""
            flood_class = props.get("stateClassName") or props.get("stateClass")

            if flood_class is None:
                lhp_class = props.get("lhpClass")
                if isinstance(lhp_class, int):
                    flood_class = LHP_CLASS_NAMES.get(lhp_class, str(lhp_class))

            if river and station and flood_class:
                key = normalize_name(f"{river} {station}")
                mapping[key] = str(flood_class)

        return mapping

    def flood_class_for(self, river: str, station: str, mapping: dict[str, str]) -> Optional[str]:
        from clients.pegelonline import normalize_name

        keys = [
            normalize_name(f"{river} {station}"),
            normalize_name(station),
        ]
        for key in keys:
            if key in mapping:
                return mapping[key]
        return None
