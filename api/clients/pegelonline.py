"""PEGELONLINE REST-API Client."""

from __future__ import annotations

import logging
import re
import unicodedata
from typing import Any, Optional

import httpx
from cachetools import TTLCache
from tenacity import retry, stop_after_attempt, wait_exponential

from config import settings
from logic.status import rules_from_pegelonline_characteristics
from models.schemas import PegelReading, RiverRule

logger = logging.getLogger(__name__)


def normalize_name(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


class PegelOnlineClient:
    def __init__(self, base_url: str | None = None, cache_ttl: int | None = None) -> None:
        self.base_url = (base_url or settings.pegelonline_base_url).rstrip("/")
        self.cache_ttl = cache_ttl or settings.pegel_cache_ttl
        self._stations_cache: TTLCache[str, list[dict[str, Any]]] = TTLCache(maxsize=4, ttl=self.cache_ttl)
        self.headers = {"User-Agent": "KanuBefahrbarkeit/1.0 (PEGELONLINE integration)"}

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=10))
    def _get_json(self, path: str, params: dict | None = None) -> Any:
        url = f"{self.base_url}/{path.lstrip('/')}"
        with httpx.Client(timeout=45.0, headers=self.headers) as client:
            response = client.get(url, params=params)
            response.raise_for_status()
            return response.json()

    def fetch_stations(self, force_refresh: bool = False) -> list[dict[str, Any]]:
        cache_key = "stations"
        if not force_refresh and cache_key in self._stations_cache:
            return self._stations_cache[cache_key]

        stations = self._get_json(
            "stations.json",
            params={
                "includeTimeseries": "true",
                "includeCurrentMeasurement": "true",
                "includeCharacteristicValues": "true",
            },
        )
        self._stations_cache[cache_key] = stations
        logger.info("PEGELONLINE: %s Stationen geladen", len(stations))
        return stations

    @staticmethod
    def _water_series(station: dict[str, Any]) -> Optional[dict[str, Any]]:
        for series in station.get("timeseries") or []:
            if series.get("shortname") == "W":
                return series
        return None

    @staticmethod
    def _characteristic(series: dict[str, Any], shortname: str) -> Optional[float]:
        for item in series.get("characteristicValues") or []:
            if item.get("shortname") == shortname and item.get("value") is not None:
                return float(item["value"])
        return None

    def reading_from_station(self, station: dict[str, Any]) -> PegelReading:
        series = self._water_series(station)
        measurement = (series or {}).get("currentMeasurement") or {}
        water = station.get("water") or {}

        return PegelReading(
            station=station.get("longname") or station.get("shortname") or "Unbekannt",
            river=water.get("longname") or water.get("shortname") or "Unbekannt",
            current_cm=float(measurement["value"]) if measurement.get("value") is not None else None,
            timestamp=measurement.get("timestamp"),
            pegelonline_uuid=station.get("uuid"),
            state_mnw_mhw=measurement.get("stateMnwMhw"),
        )

    def rules_from_station(self, station: dict[str, Any]) -> Optional[RiverRule]:
        series = self._water_series(station)
        if not series:
            return None
        water = station.get("water") or {}
        return rules_from_pegelonline_characteristics(
            river=water.get("longname") or water.get("shortname") or "Unbekannt",
            station=station.get("longname") or station.get("shortname") or "Unbekannt",
            mnw=self._characteristic(series, "MNW"),
            mhw=self._characteristic(series, "MHW"),
            mw=self._characteristic(series, "MW"),
            pegelonline_uuid=station.get("uuid"),
        )

    def build_station_index(self, stations: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        index: dict[str, dict[str, Any]] = {}
        for station in stations:
            water = station.get("water") or {}
            river = water.get("longname") or water.get("shortname") or ""
            name = station.get("longname") or station.get("shortname") or ""
            keys = {
                normalize_name(f"{river} {name}"),
                normalize_name(name),
                normalize_name(f"{name} {river}"),
            }
            for key in keys:
                if key:
                    index[key] = station
        return index

    def match_station(self, river: str, station: str, index: dict[str, dict[str, Any]]) -> Optional[dict[str, Any]]:
        candidates = [
            normalize_name(f"{river} {station}"),
            normalize_name(station),
            normalize_name(f"{station} {river}"),
        ]
        for candidate in candidates:
            if candidate in index:
                return index[candidate]

        # Fuzzy: Teilstring-Match
        station_norm = normalize_name(station)
        river_norm = normalize_name(river)
        for key, value in index.items():
            if station_norm and station_norm in key and (not river_norm or river_norm in key):
                return value
        return None

    def current_for(self, river: str, station: str, index: dict[str, Any]) -> Optional[PegelReading]:
        matched = self.match_station(river, station, index)
        if not matched:
            return None
        return self.reading_from_station(matched)
