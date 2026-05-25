"""Länderübergreifendes Hochwasserportal (LHP) – Stationen & Hochwasserklassen.

API-Dokumentation: https://www.hochwasserzentralen.de/developers/api-docs-stable-swagger
Live-Server: https://api.hochwasserzentralen.de/public/v1
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional

import httpx
from cachetools import TTLCache
from tenacity import retry, stop_after_attempt, wait_exponential

from config import settings

logger = logging.getLogger(__name__)

LHP_CLASS_NAMES: dict[int, str] = {
    4: "Sehr großes Hochwasser",
    3: "Großes Hochwasser",
    2: "Mittleres Hochwasser",
    1: "Kleines Hochwasser",
    0: "Kein Hochwasser",
    -1: "Derzeit keine Daten",
}


@dataclass(frozen=True)
class LhpStation:
    lhp_id: str
    state_id: str
    river: str
    station: str
    flood_class: str
    lhp_class: Optional[int]
    station_link: Optional[str]
    lat: Optional[float] = None
    lon: Optional[float] = None


class HochwasserZentralenClient:
    """LHP liefert Bundesland, Hochwasser-Klassifizierung und Links (keine cm-Werte)."""

    def __init__(self, base_url: str | None = None, cache_ttl: int = 600) -> None:
        self.base_url = (base_url or settings.lhp_api_base_url).rstrip("/")
        self._cache: TTLCache[str, Any] = TTLCache(maxsize=4, ttl=cache_ttl)
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

    def fetch_station_index(self, force_refresh: bool = False) -> dict[str, LhpStation]:
        if not force_refresh and "station_index" in self._cache:
            return self._cache["station_index"]

        try:
            payload = self._get_json("data/stations")
        except Exception as exc:
            logger.warning(
                "LHP API nicht erreichbar (%s) – Stationen-Index deaktiviert", exc
            )
            self._cache["station_index"] = {}
            self._cache["flood_classes"] = {}
            return {}

        stations = self._parse_lhp_stations(payload)
        index = self._build_station_index(stations)
        self._cache["station_index"] = index
        self._cache["flood_classes"] = {
            key: station.flood_class for key, station in index.items()
        }
        logger.info("LHP: %s Pegel im Stations-Index", len(stations))
        return index

    def fetch_flood_classes(self, force_refresh: bool = False) -> dict[str, str]:
        if not force_refresh and "flood_classes" in self._cache:
            return self._cache["flood_classes"]

        index = self.fetch_station_index(force_refresh=force_refresh)
        mapping = {key: station.flood_class for key, station in index.items()}
        self._cache["flood_classes"] = mapping
        return mapping

    def station_for(
        self,
        river: str,
        station: str,
        index: Optional[dict[str, LhpStation]] = None,
    ) -> Optional[LhpStation]:
        from clients.pegelonline import normalize_name

        if index is None:
            index = self.fetch_station_index()

        keys = [
            normalize_name(f"{river} {station}"),
            normalize_name(station),
            normalize_name(f"{station} {river}"),
        ]
        for key in keys:
            if key in index:
                return index[key]
        return None

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

    def _parse_lhp_stations(self, payload: Any) -> list[LhpStation]:
        stations: list[Any] = []
        if isinstance(payload, dict):
            if isinstance(payload.get("data"), list):
                stations = payload["data"]
            elif isinstance(payload.get("features"), list):
                stations = payload["features"]

        parsed: list[LhpStation] = []
        for item in stations:
            station = self._station_from_item(item)
            if station:
                parsed.append(station)
        return parsed

    def _station_from_item(self, item: dict[str, Any]) -> Optional[LhpStation]:
        if not isinstance(item, dict):
            return None

        props = item.get("properties") if item.get("type") == "Feature" else item
        if not isinstance(props, dict):
            props = item

        river = props.get("water") or props.get("gewaesser") or props.get("river") or ""
        station = props.get("name") or props.get("station") or props.get("longname") or ""
        state_id = props.get("stateId") or props.get("state_id") or ""
        lhp_id = str(item.get("id") or props.get("id") or "").strip()

        flood_class = props.get("stateClassName") or props.get("stateClass")
        lhp_class = props.get("lhpClass")
        if flood_class is None and isinstance(lhp_class, int):
            flood_class = LHP_CLASS_NAMES.get(lhp_class, str(lhp_class))

        if not river or not station or not flood_class or not state_id:
            return None

        lat = lon = None
        geometry = item.get("geometry")
        if isinstance(geometry, dict) and geometry.get("type") == "Point":
            coords = geometry.get("coordinates") or []
            if len(coords) >= 2:
                lon, lat = float(coords[0]), float(coords[1])

        return LhpStation(
            lhp_id=lhp_id,
            state_id=str(state_id),
            river=str(river),
            station=str(station),
            flood_class=str(flood_class),
            lhp_class=lhp_class if isinstance(lhp_class, int) else None,
            station_link=props.get("stationLink"),
            lat=lat,
            lon=lon,
        )

    def _build_station_index(self, stations: list[LhpStation]) -> dict[str, LhpStation]:
        from clients.pegelonline import normalize_name

        index: dict[str, LhpStation] = {}
        for station in stations:
            for key in (
                normalize_name(f"{station.river} {station.station}"),
                normalize_name(station.station),
                normalize_name(f"{station.station} {station.river}"),
            ):
                if key:
                    index.setdefault(key, station)
        return index

    def _parse_stations(self, payload: Any) -> dict[str, str]:
        """Legacy-Hilfsmethode für Tests – liefert flood_class pro Stations-Key."""
        index = self._build_station_index(self._parse_lhp_stations(payload))
        return {key: station.flood_class for key, station in index.items()}
