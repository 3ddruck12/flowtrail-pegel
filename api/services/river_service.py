"""Orchestriert Regeln, LHP, Landes-Provider und Befahrbarkeitslogik."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from clients.hochwasserzentralen import HochwasserZentralenClient
from clients.levels.base import RuleKey
from clients.pegelonline import PegelOnlineClient
from config import settings
from loaders.rules_file import load_rules_from_file
from logic.status import STATUS_LABELS, apply_flood_override, get_canoe_status, status_severity
from models.schemas import CanoeStatus, RiverListResponse, RiverRule, RiverSummary, StatusResponse
from services.database import Database
from services.level_resolver import LevelResolver

logger = logging.getLogger(__name__)


class RiverService:
    def __init__(self) -> None:
        self.db = Database()
        self.pegel_client = PegelOnlineClient()
        self.lhp_client = HochwasserZentralenClient()
        self.level_resolver = LevelResolver(self.lhp_client, self.pegel_client)
        self._file_rules: list[RiverRule] | None = None

    def sync_all(self) -> dict:
        """Regeln laden, LHP-Bundesland zuordnen, PEGELONLINE-Mapping."""
        result: dict = {"rules": 0, "mapped": 0, "lhp_matched": 0, "by_state": {}, "errors": []}

        try:
            rules = load_rules_from_file(settings.rules_path)
            lhp_stats = self.level_resolver.enrich_rules_with_lhp(rules)
            result["lhp_matched"] = lhp_stats.get("lhp_matched", 0)
            result["by_state"] = lhp_stats.get("by_state", {})

            stations = self.pegel_client.fetch_stations(force_refresh=True)
            index = self.pegel_client.build_station_index(stations)

            mapped = 0
            for rule in rules:
                if rule.pegelonline_uuid:
                    mapped += 1
                    continue
                matched = self.pegel_client.match_station(rule.river, rule.station, index)
                if matched:
                    rule.pegelonline_uuid = matched.get("uuid")
                    mapped += 1

            self._file_rules = rules
            count = self.db.upsert_rules(rules)
            self.db.export_rules_json(settings.db_path.parent / "rules_fallback.json")

            self.db.log_sync(
                "rules_file",
                "ok",
                f"{count} rules, {mapped} pegelonline, {result['lhp_matched']} lhp",
            )
            result["rules"] = count
            result["mapped"] = mapped
        except Exception as exc:
            logger.exception("Sync fehlgeschlagen")
            self.db.log_sync("rules_file", "error", str(exc))
            result["errors"].append(str(exc))

        return result

    def _load_rules(self, river: Optional[str] = None) -> list[RiverRule]:
        if self._file_rules:
            rules = self._file_rules
        else:
            rules = self.db.list_rules(river)
            if not rules:
                logger.info("Lade Regeln aus %s", settings.rules_path)
                rules = load_rules_from_file(settings.rules_path)
                self._file_rules = rules

        if river:
            return [r for r in rules if r.river.lower() == river.lower()]
        return rules

    def get_river_statuses(
        self,
        river: str,
        station: Optional[str] = None,
        flood_map: Optional[dict[str, str]] = None,
        levels=None,
        lhp_index=None,
    ) -> list[StatusResponse]:
        rules = self._load_rules(river)
        if station:
            rules = [r for r in rules if r.station.lower() == station.lower()]

        if not rules:
            return []

        if lhp_index is None:
            lhp_index = self.lhp_client.fetch_station_index()
        if flood_map is None:
            flood_map = self.lhp_client.fetch_flood_classes()
        if levels is None:
            levels = self.level_resolver.fetch_levels(rules)

        responses: list[StatusResponse] = []
        for rule in rules:
            key = RuleKey.from_rule(rule)
            lhp = self.lhp_client.station_for(rule.river, rule.station, lhp_index)
            level = levels.get(key)

            if level:
                current, source = level.current_cm, level.source
                external_id = level.external_station_id
            else:
                current, source = None, "unknown"
                external_id = rule.external_station_id

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
                    state=rule.state or (lhp.state_id if lhp else None),
                    flood_class=flood_class,
                    lhp_id=rule.lhp_id or (lhp.lhp_id if lhp else None),
                    station_link=rule.station_link or (lhp.station_link if lhp else None),
                    external_station_id=external_id,
                )
            )

        return responses

    def list_rivers(self) -> RiverListResponse:
        rules = self._load_rules()
        grouped: dict[str, list[RiverRule]] = {}
        for rule in rules:
            grouped.setdefault(rule.river, []).append(rule)

        lhp_index = self.lhp_client.fetch_station_index()
        flood_map = self.lhp_client.fetch_flood_classes()
        levels = self.level_resolver.fetch_levels(rules)

        summaries: list[RiverSummary] = []
        for river, river_rules in sorted(grouped.items()):
            statuses = []
            for rule in river_rules:
                station_statuses = self.get_river_statuses(
                    river,
                    rule.station,
                    flood_map=flood_map,
                    levels=levels,
                    lhp_index=lhp_index,
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

    def export_all_statuses(self) -> list[StatusResponse]:
        """Alle Messstellen-Status für pegel.json (ein LHP/OpenHygon-Abruf)."""
        rules = self._load_rules()
        lhp_index = self.lhp_client.fetch_station_index()
        flood_map = self.lhp_client.fetch_flood_classes()
        levels = self.level_resolver.fetch_levels(rules)

        sections: list[StatusResponse] = []
        for rule in rules:
            sections.extend(
                self.get_river_statuses(
                    rule.river,
                    rule.station,
                    flood_map=flood_map,
                    levels=levels,
                    lhp_index=lhp_index,
                )
            )
        return sections
