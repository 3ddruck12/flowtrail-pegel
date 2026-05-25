"""Bundesland-spezifische Pegel-Provider (erweiterbar)."""

from clients.levels.openhygon_nrw import NrwOpenHygonProvider
from clients.levels.pegelonline_provider import PegelOnlineLevelProvider

__all__ = ["get_level_providers"]


def get_level_providers() -> list:
    """Reihenfolge: Landes-Provider zuerst, PEGELONLINE als Fallback."""
    return [
        NrwOpenHygonProvider(),
        PegelOnlineLevelProvider(),
    ]
