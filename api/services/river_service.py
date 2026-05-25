"""Orchestriert Scraper, APIs und Befahrbarkeitslogik."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from cachetools import TTLCache

from clients.hochwasserzentralen import HochwasserZentralenClient
from clients.pegelonline import PegelOnlineClient, normalize_name
from config import settings
from logic.status import STATUS_LABELS, apply_flood_override, get_canoe_status, status_severity
from models.schemas import CanoeStatus, RiverListResponse, RiverRule, RiverSummary, StatusResponse
from scrapers.kanu_nrw import KanuNrwScraper
from services.database import Database

logger = logging.getLogger(__name__)


class RiverService:
    def __init__(self) -> None:
        self.db = Database()
        self.nrw_scraper = KanuNrwScraper()
        self.pegel_client = PegelOnlineClient()
        self.lhp_client = HochwasserZentralenClient()
        self._nrw_live_cache: TTLCache[str, dict] = TTLCache(maxsize=1, ttl=settings.pegel_cache_ttl)

    def sync_all(self) -> dict:
        """Scrape + PEGELONLINE-Mapping + DB-Update."""
        result = {"nrw_rules": 0, "mapped": 0, "errors": []}

        try:
            nrw_rules = self.nrw_scraper.scrape_rules()
            stations = self.pegel_client.fetch_stations(force_refresh=True)
            index = self.pegel_client.build_station_index(stations)

            mapped = 0
            for rule in nrw_rules:
                matched = self.pegel_client.match_station(rule.river, rule.station, index)
                if matched:
                    rule.pegelonline_uuid = matched.get("uuid")
                    mapped += 1

            count = self.db.upsert_rules(nrw_rules)
            self.db.export_rules_json(settings.db_path.parent / "rules_fallback.json")

            nrw_live = {normalize_name(f"{r['river']} {r['station']}"): r for r in self.nrw_scraper.scrape_live_readings()}
            self._nrw_live_cache["live"] = nrw_live

            self.db.log_sync("kanu_nrw", "ok", f"{count} rules, {mapped} mapped")
            result["nrw_rules"] = count
            result["mapped"] = mapped
        except Exception as exc:
            logger.exception("Sync fehlgeschlagen")
            self.db.log_sync("kanu_nrw", "error", str(exc))
            result["errors"].append(str(exc))

        return result

    def _load_rules(self, river: Optional[str] = None) -> list[RiverRule]:
        rules = self.db.list_rules(river)
        if rules:
            return rules

        # Fallback wenn DB leer: live scrapen
        logger.warning("Keine Regeln in DB – live scrape")
        return self.nrw_scraper.scrape_rules()

    def _current_cm(self, rule: RiverRule, stations_index: dict, nrw_live: dict) -> tuple[Optional[float], str]:
        reading = self.pegel_client.current_for(rule.river, rule.station, stations_index)
        if reading and reading.current_cm is not None:
            return reading.current_cm, "pegelonline"

        key = normalize_name(f"{rule.river} {rule.station}")
        live = nrw_live.get(key)
        if live and live.get("current_cm") is not None:
            return live["current_cm"], "kanu_nrw"

        return None, "unknown"

    def get_river_statuses(
        self,
        river: str,
        station: Optional[str] = None,
        flood_map: Optional[dict[str, str]] = None,
    ) -> list[StatusResponse]:
        rules = self._load_rules(river)
        rules = [r for r in rules if r.river.lower() == river.lower()]
        if station:
            rules = [r for r in rules if r.station.lower() == station.lower()]

        if not rules:
            return []

        pegel_stations = self.pegel_client.fetch_stations()
        stations_index = self.pegel_client.build_station_index(pegel_stations)
        if flood_map is None:
            flood_map = self.lhp_client.fetch_flood_classes()

        if "live" not in self._nrw_live_cache:
            self._nrw_live_cache["live"] = {
                normalize_name(f"{r['river']} {r['station']}"): r for r in self.nrw_scraper.scrape_live_readings()
            }
        nrw_live = self._nrw_live_cache["live"]

        responses: list[StatusResponse] = []
        for rule in rules:
            current, source = self._current_cm(rule, stations_index, nrw_live)
            status = get_canoe_status(current, rule)
            flood_class = self.lhp_client.flood_class_for(rule.river, rule.station, flood_map)
            status = apply_flood_override(status, flood_class)

            responses.append(
                StatusResponse(
                    river=rule.river,
                    station=rule.station,
                    status=status,
                    label=STATUS_LABELS[status],
                    current=current,
                    min=rule.min,
                    ideal_min=rule.ideal_min,
                    ideal_max=rule.ideal_max,
                    max=rule.max,
                    hint=rule.hint,
                    source=source,
                    pegelonline_uuid=rule.pegelonline_uuid,
                    nrw_befahrbarkeit=rule.nrw_befahrbarkeit,
                )
            )

        return responses

    def list_rivers(self) -> RiverListResponse:
        rules = self._load_rules()
        grouped: dict[str, list[RiverRule]] = {}
        for rule in rules:
            grouped.setdefault(rule.river, []).append(rule)

        summaries: list[RiverSummary] = []
        flood_map = self.lhp_client.fetch_flood_classes()
        for river, river_rules in sorted(grouped.items()):
            statuses = []
            for rule in river_rules:
                station_statuses = self.get_river_statuses(
                    river, rule.station, flood_map=flood_map
                )
                if station_statuses:
                    statuses.append(station_statuses[0].status)

            worst = (
                max(statuses, key=status_severity)
                if statuses
                else CanoeStatus.UNKNOWN
            )
            summaries.append(
                RiverSummary(
                    river=river,
                    station_count=len(river_rules),
                    best_status=worst,
                    stations=[r.station for r in river_rules],
                )
            )

        return RiverListResponse(
            rivers=summaries,
            updated_at=datetime.now(timezone.utc).isoformat(),
        )
