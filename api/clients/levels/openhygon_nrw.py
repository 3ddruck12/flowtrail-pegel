"""OpenHygon NRW – Live-Pegel in cm für DE-NW."""

from __future__ import annotations

import csv
import io
import logging
import zipfile
from dataclasses import dataclass
from typing import Optional

import httpx
from cachetools import TTLCache
from tenacity import retry, stop_after_attempt, wait_exponential

from clients.hochwasserzentralen import LhpStation
from clients.levels.base import LevelReading, LevelProvider, RuleKey
from clients.pegelonline import normalize_name
from config import settings
from models.schemas import RiverRule

logger = logging.getLogger(__name__)

STATE_NRW = "DE-NW"


@dataclass(frozen=True)
class HygonStationMeta:
    station_no: str
    name: str
    catchment_name: str


class NrwOpenHygonProvider:
    provider_id = "openhygon"
    state_ids = (STATE_NRW,)

    def __init__(self) -> None:
        self._stations_cache: TTLCache[str, dict[str, HygonStationMeta]] = TTLCache(
            maxsize=2, ttl=settings.openhygon_cache_ttl
        )
        self._levels_cache: TTLCache[str, dict[str, LevelReading]] = TTLCache(
            maxsize=2, ttl=settings.openhygon_cache_ttl
        )
        self.headers = {
            "User-Agent": "FlowTrail/1.0 (OpenHygon NRW; +https://github.com/3ddruck12/FlowTrail)",
        }

    def supports(
        self,
        rule: RiverRule,
        lhp: Optional[LhpStation],
        state_id: Optional[str],
    ) -> bool:
        if rule.level_provider and rule.level_provider != self.provider_id:
            return False
        if rule.level_provider == self.provider_id:
            return True
        resolved = state_id or rule.state or (lhp.state_id if lhp else None)
        return resolved == STATE_NRW

    def fetch_batch(
        self,
        rules: list[RiverRule],
        lhp_by_rule: dict[RuleKey, LhpStation],
    ) -> dict[RuleKey, LevelReading]:
        if not rules:
            return {}

        station_index = self._load_station_index()
        levels = self._load_current_levels()
        readings: dict[RuleKey, LevelReading] = {}

        for rule in rules:
            key = RuleKey.from_rule(rule)
            station_no = self._resolve_station_no(rule, station_index, lhp_by_rule.get(key))
            if not station_no:
                continue
            level = levels.get(station_no)
            if level:
                readings[key] = level

        logger.info("OpenHygon NRW: %s/%s Regeln mit Live-Pegel", len(readings), len(rules))
        return readings

    def _resolve_station_no(
        self,
        rule: RiverRule,
        station_index: dict[str, HygonStationMeta],
        lhp: Optional[LhpStation],
    ) -> Optional[str]:
        if rule.external_station_id:
            return str(rule.external_station_id).strip()

        candidates = [rule.station]
        if lhp and lhp.station:
            candidates.append(lhp.station)

        seen: set[str] = set()
        for name in candidates:
            norm = normalize_name(name)
            if not norm or norm in seen:
                continue
            seen.add(norm)

            if norm in station_index:
                return station_index[norm].station_no

            for indexed_name, meta in station_index.items():
                if norm == indexed_name:
                    return meta.station_no
                if norm in indexed_name or indexed_name in norm:
                    return meta.station_no

        return None

    @retry(stop=stop_after_attempt(2), wait=wait_exponential(multiplier=1, min=1, max=5))
    def _get_bytes(self, url: str) -> bytes:
        with httpx.Client(timeout=60.0, headers=self.headers) as client:
            response = client.get(url)
            response.raise_for_status()
            return response.content

    def _load_station_index(self) -> dict[str, HygonStationMeta]:
        if "stations" in self._stations_cache:
            return self._stations_cache["stations"]

        text = self._get_bytes(settings.openhygon_stations_url).decode("utf-8")
        index: dict[str, HygonStationMeta] = {}
        reader = csv.DictReader(io.StringIO(text), delimiter=";")
        for row in reader:
            name = (row.get("station_name") or "").strip()
            station_no = (row.get("station_no") or "").strip()
            if not name or not station_no:
                continue
            meta = HygonStationMeta(
                station_no=station_no,
                name=name,
                catchment_name=(row.get("catchment_name") or "").strip(),
            )
            index[normalize_name(name)] = meta

        self._stations_cache["stations"] = index
        logger.info("OpenHygon: %s Pegel-Stationen geladen", len(index))
        return index

    def _load_current_levels(self) -> dict[str, LevelReading]:
        if "levels" in self._levels_cache:
            return self._levels_cache["levels"]

        raw_zip = self._get_bytes(settings.openhygon_current_csv_url)
        latest: dict[str, tuple[str, float]] = {}

        with zipfile.ZipFile(io.BytesIO(raw_zip)) as archive:
            data_names = [
                n
                for n in archive.namelist()
                if n.lower().endswith((".csv", ".txt"))
            ]
            if not data_names:
                raise ValueError("OpenHygon ZIP enthält keine CSV/TXT-Datei")
            with archive.open(data_names[0]) as handle:
                text = io.TextIOWrapper(handle, encoding="utf-8")
                reader = csv.DictReader(text, delimiter=";")
                for row in reader:
                    station_no = (row.get("station_no") or "").strip()
                    timestamp = (row.get("time") or "").strip()
                    value_raw = row.get("value(cm)") or row.get("value")
                    if not station_no or value_raw in (None, ""):
                        continue
                    try:
                        value = float(str(value_raw).replace(",", "."))
                    except ValueError:
                        continue
                    prev = latest.get(station_no)
                    if prev is None or timestamp > prev[0]:
                        latest[station_no] = (timestamp, value)

        levels = {
            station_no: LevelReading(
                current_cm=value,
                source=self.provider_id,
                timestamp=timestamp,
                external_station_id=station_no,
            )
            for station_no, (timestamp, value) in latest.items()
        }
        self._levels_cache["levels"] = levels
        logger.info("OpenHygon: %s Stationen mit aktuellem Pegel", len(levels))
        return levels
