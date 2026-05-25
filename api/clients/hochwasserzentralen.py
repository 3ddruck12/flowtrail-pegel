"""Länderübergreifendes Hochwasserportal (LHP) – optional für Gefahrenklassen."""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx
from cachetools import TTLCache
from tenacity import retry, stop_after_attempt, wait_exponential

from config import settings

logger = logging.getLogger(__name__)


class HochwasserZentralenClient:
    """
    LHP liefert keine Messwerte, aber Hochwasser-Klassifizierungen.
    Endpunkt ist konfigurierbar – bei 404 wird leise degradiert.
    """

    def __init__(self, base_url: str | None = None, cache_ttl: int = 600) -> None:
        self.base_url = (base_url or settings.lhp_api_base_url).rstrip("/")
        self._cache: TTLCache[str, dict[str, str]] = TTLCache(maxsize=2, ttl=cache_ttl)
        self.headers = {
            "User-Agent": "KanuBefahrbarkeit/1.0 (LHP integration)",
            "Accept": "application/json, application/geo+json",
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
            payload = self._get_json("current-situation.json")
        except Exception as exc:
            logger.warning("LHP API nicht erreichbar (%s) – Hochwasser-Overlay deaktiviert", exc)
            return {}

        mapping = self._parse_geojson(payload)
        self._cache["classes"] = mapping
        logger.info("LHP: %s Pegel mit Hochwasserklassifizierung", len(mapping))
        return mapping

    def _parse_geojson(self, payload: Any) -> dict[str, str]:
        from clients.pegelonline import normalize_name

        mapping: dict[str, str] = {}
        features = []

        if isinstance(payload, dict):
            features = payload.get("features") or payload.get("stations") or []
        elif isinstance(payload, list):
            features = payload

        for feature in features:
            if not isinstance(feature, dict):
                continue

            props = feature.get("properties") or feature
            river = props.get("water") or props.get("gewaesser") or props.get("river") or ""
            station = props.get("name") or props.get("station") or props.get("longname") or ""
            flood_class = (
                props.get("classification")
                or props.get("class")
                or props.get("classLabel")
                or props.get("state")
                or ""
            )

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
