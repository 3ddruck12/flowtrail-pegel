"""Gemeinsame Typen für Pegel-Level-Provider."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Protocol

from clients.hochwasserzentralen import LhpStation
from models.schemas import RiverRule


@dataclass(frozen=True)
class RuleKey:
    river: str
    station: str

    @classmethod
    def from_rule(cls, rule: RiverRule) -> RuleKey:
        return cls(river=rule.river, station=rule.station)


@dataclass
class LevelReading:
    current_cm: float
    source: str
    timestamp: Optional[str] = None
    external_station_id: Optional[str] = None


class LevelProvider(Protocol):
    provider_id: str
    state_ids: tuple[str, ...]

    def supports(
        self,
        rule: RiverRule,
        lhp: Optional[LhpStation],
        state_id: Optional[str],
    ) -> bool: ...

    def fetch_batch(
        self,
        rules: list[RiverRule],
        lhp_by_rule: dict[RuleKey, LhpStation],
    ) -> dict[RuleKey, LevelReading]: ...
