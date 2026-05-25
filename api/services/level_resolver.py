"""LHP-Station → Bundesland-Provider → Live-Pegel."""

from __future__ import annotations

import logging
from collections import Counter
from typing import Optional

from clients.hochwasserzentralen import HochwasserZentralenClient, LhpStation
from clients.levels import get_level_providers
from clients.levels.base import LevelReading, RuleKey
from clients.pegelonline import PegelOnlineClient
from models.schemas import RiverRule

logger = logging.getLogger(__name__)


class LevelResolver:
    def __init__(
        self,
        lhp_client: HochwasserZentralenClient | None = None,
        pegel_client: PegelOnlineClient | None = None,
    ) -> None:
        self.lhp_client = lhp_client or HochwasserZentralenClient()
        self.pegel_client = pegel_client or PegelOnlineClient()
        self.providers = get_level_providers()

    def enrich_rules_with_lhp(self, rules: list[RiverRule]) -> dict[str, object]:
        index = self.lhp_client.fetch_station_index()
        matched = 0
        by_state: Counter[str] = Counter()

        for rule in rules:
            lhp = self.lhp_client.station_for(rule.river, rule.station, index)
            if not lhp:
                continue

            if not rule.state:
                rule.state = lhp.state_id
            if not rule.lhp_id:
                rule.lhp_id = lhp.lhp_id
            if not rule.station_link and lhp.station_link:
                rule.station_link = lhp.station_link

            matched += 1
            by_state[lhp.state_id] += 1

        return {"lhp_matched": matched, "by_state": dict(by_state)}

    def resolve_state(self, rule: RiverRule, lhp: Optional[LhpStation]) -> Optional[str]:
        return rule.state or (lhp.state_id if lhp else None)

    def fetch_levels(self, rules: list[RiverRule]) -> dict[RuleKey, LevelReading]:
        if not rules:
            return {}

        lhp_index = self.lhp_client.fetch_station_index()
        lhp_by_rule: dict[RuleKey, LhpStation] = {}
        for rule in rules:
            lhp = self.lhp_client.station_for(rule.river, rule.station, lhp_index)
            if lhp:
                lhp_by_rule[RuleKey.from_rule(rule)] = lhp

        assigned: set[RuleKey] = set()
        readings: dict[RuleKey, LevelReading] = {}

        for provider in self.providers:
            batch = [
                rule
                for rule in rules
                if RuleKey.from_rule(rule) not in assigned
                and provider.supports(
                    rule,
                    lhp_by_rule.get(RuleKey.from_rule(rule)),
                    self.resolve_state(rule, lhp_by_rule.get(RuleKey.from_rule(rule))),
                )
            ]
            if not batch:
                continue

            batch_readings = provider.fetch_batch(batch, lhp_by_rule)
            for key, reading in batch_readings.items():
                readings[key] = reading
                assigned.add(key)

        return readings

    def reading_for_rule(
        self,
        rule: RiverRule,
        levels: dict[RuleKey, LevelReading],
        pegel_index: dict,
    ) -> tuple[Optional[float], str]:
        key = RuleKey.from_rule(rule)
        level = levels.get(key)
        if level:
            return level.current_cm, level.source

        pegel = self.pegel_client.current_for(rule.river, rule.station, pegel_index)
        if pegel and pegel.current_cm is not None:
            return pegel.current_cm, "pegelonline"

        return None, "unknown"
