"""PEGELONLINE als bundesweiter Fallback-Provider."""

from __future__ import annotations

from typing import Optional

from clients.hochwasserzentralen import LhpStation
from clients.levels.base import LevelReading, RuleKey
from clients.pegelonline import PegelOnlineClient
from models.schemas import RiverRule


class PegelOnlineLevelProvider:
    provider_id = "pegelonline"
    state_ids = ("*",)

    def __init__(self, client: PegelOnlineClient | None = None) -> None:
        self.client = client or PegelOnlineClient()

    def supports(
        self,
        rule: RiverRule,
        lhp: Optional[LhpStation],
        state_id: Optional[str],
    ) -> bool:
        if rule.level_provider and rule.level_provider != self.provider_id:
            return False
        return True

    def fetch_batch(
        self,
        rules: list[RiverRule],
        lhp_by_rule: dict[RuleKey, LhpStation],
    ) -> dict[RuleKey, LevelReading]:
        if not rules:
            return {}

        stations = self.client.fetch_stations()
        index = self.client.build_station_index(stations)
        readings: dict[RuleKey, LevelReading] = {}

        for rule in rules:
            key = RuleKey.from_rule(rule)
            if rule.pegelonline_uuid:
                matched = next(
                    (s for s in stations if s.get("uuid") == rule.pegelonline_uuid),
                    None,
                )
            else:
                matched = self.client.match_station(rule.river, rule.station, index)

            if not matched:
                continue

            pegel = self.client.reading_from_station(matched)
            if pegel.current_cm is None:
                continue

            readings[key] = LevelReading(
                current_cm=pegel.current_cm,
                source=self.provider_id,
                timestamp=pegel.timestamp,
                external_station_id=pegel.pegelonline_uuid,
            )

        return readings
