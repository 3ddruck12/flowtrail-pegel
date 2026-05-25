"""Befahrbarkeits-Logik für Kanufahrer."""

from typing import Optional

from models.schemas import CanoeStatus, RiverRule

def status_severity(status: CanoeStatus) -> int:
    order = {
        CanoeStatus.UNKNOWN: 0,
        CanoeStatus.GOOD: 1,
        CanoeStatus.OK: 2,
        CanoeStatus.HIGH: 3,
        CanoeStatus.TOO_LOW: 4,
        CanoeStatus.DANGER: 5,
    }
    return order.get(status, 0)


STATUS_LABELS: dict[CanoeStatus, str] = {
    CanoeStatus.TOO_LOW: "❌ Zu wenig Wasser",
    CanoeStatus.OK: "🟡 Bedingt fahrbar",
    CanoeStatus.GOOD: "✅ Gut fahrbar",
    CanoeStatus.HIGH: "⚠️ Hoher Pegel",
    CanoeStatus.DANGER: "⛔ Gefährlich (Hochwasser)",
    CanoeStatus.UNKNOWN: "❓ Unbekannt",
}


def get_canoe_status(current: Optional[float], rules: RiverRule) -> CanoeStatus:
    """
    Bewertet den aktuellen Pegel anhand der Regeln.

    Bereiche:
    - current < min           → too_low
    - min ≤ current < ideal_min → ok (bedingt)
    - ideal_min ≤ current ≤ ideal_max → good
    - ideal_max < current < max → high
    - current ≥ max           → danger
    """
    if current is None:
        return CanoeStatus.UNKNOWN

    if current < rules.min:
        return CanoeStatus.TOO_LOW
    if current < rules.ideal_min:
        return CanoeStatus.OK
    if current <= rules.ideal_max:
        return CanoeStatus.GOOD
    if current < rules.max:
        return CanoeStatus.HIGH
    return CanoeStatus.DANGER


def apply_flood_override(status: CanoeStatus, flood_class: Optional[str]) -> CanoeStatus:
    """Hebt Status bei Hochwasserwarnung mindestens auf high/danger an."""
    if not flood_class:
        return status

    normalized = flood_class.lower()
    if any(term in normalized for term in ("extrem", "außergewöhnlich", "exceptional", "sehr groß")):
        return CanoeStatus.DANGER
    if any(term in normalized for term in ("hoch", "high", "orange", "gelb", "yellow", "warn")):
        if status in (CanoeStatus.GOOD, CanoeStatus.OK):
            return CanoeStatus.HIGH
        if status == CanoeStatus.HIGH:
            return CanoeStatus.DANGER
    return status


def rules_from_nrw_minimum(
    river: str,
    station: str,
    min_cm: float,
    hint: Optional[str] = None,
    pegelonline_uuid: Optional[str] = None,
    nrw_befahrbarkeit: Optional[str] = None,
) -> RiverRule:
    """
    Leitet vollständige Regeln aus dem Kanu-NRW-Mindestpegel (Soll) ab.
    ideal_max und max sind Erfahrungsheuristiken, wenn keine Detailwerte vorliegen.
    """
    ideal_min = min_cm
    ideal_max = max(min_cm * 1.6, min_cm + 25)
    max_level = max(min_cm * 2.5, min_cm + 60)

    return RiverRule(
        river=river,
        station=station,
        min=min_cm,
        ideal_min=ideal_min,
        ideal_max=round(ideal_max, 1),
        max=round(max_level, 1),
        hint=hint,
        pegelonline_uuid=pegelonline_uuid,
        source="kanu_nrw",
        nrw_befahrbarkeit=nrw_befahrbarkeit,
    )


def rules_from_pegelonline_characteristics(
    river: str,
    station: str,
    mnw: Optional[float],
    mhw: Optional[float],
    mw: Optional[float],
    pegelonline_uuid: Optional[str] = None,
) -> Optional[RiverRule]:
    """Fallback-Regeln aus PEGELONLINE-Kennwerten (MNW/MHW/MW)."""
    if mnw is None and mhw is None and mw is None:
        return None

    min_level = mnw if mnw is not None else (mw * 0.85 if mw else 50)
    ideal_min = mnw if mnw is not None else min_level
    ideal_max = mhw if mhw is not None else (mw * 1.15 if mw else min_level * 1.8)
    max_level = mhw * 1.25 if mhw is not None else ideal_max * 1.4

    return RiverRule(
        river=river,
        station=station,
        min=round(min_level, 1),
        ideal_min=round(ideal_min, 1),
        ideal_max=round(ideal_max, 1),
        max=round(max_level, 1),
        hint="Abgeleitet aus PEGELONLINE MNW/MHW/MW",
        pegelonline_uuid=pegelonline_uuid,
        source="pegelonline",
    )
