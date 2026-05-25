from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class CanoeStatus(str, Enum):
    TOO_LOW = "too_low"
    OK = "ok"
    GOOD = "good"
    HIGH = "high"
    DANGER = "danger"
    UNKNOWN = "unknown"


class RiverRule(BaseModel):
    """Kanuregeln pro Messstelle (aus Kanu-NRW oder abgeleitet)."""

    river: str
    station: str
    min: float = Field(..., description="Mindestpegel in cm")
    ideal_min: float
    ideal_max: float
    max: float = Field(..., description="Obergrenze vor Gefahrenstufe")
    hint: Optional[str] = None
    pegelonline_uuid: Optional[str] = None
    source: str = "kanu_nrw"
    nrw_befahrbarkeit: Optional[str] = None
    state: Optional[str] = Field(default=None, description="ISO-Bundesland, z. B. DE-NW")
    lhp_id: Optional[str] = None
    external_station_id: Optional[str] = Field(
        default=None, description="Landes-Pegel-ID, z. B. OpenHygon station_no"
    )
    level_provider: Optional[str] = Field(
        default=None, description="Erzwungener Level-Provider, z. B. openhygon"
    )
    station_link: Optional[str] = None


class PegelReading(BaseModel):
    station: str
    river: str
    current_cm: Optional[float] = None
    timestamp: Optional[str] = None
    pegelonline_uuid: Optional[str] = None
    state_mnw_mhw: Optional[str] = None
    flood_class: Optional[str] = None


class StatusResponse(BaseModel):
    river: str
    station: str
    status: CanoeStatus
    label: str
    current: Optional[float] = None
    min: float
    ideal_min: float
    ideal_max: float
    max: float
    hint: Optional[str] = None
    source: str
    pegelonline_uuid: Optional[str] = None
    nrw_befahrbarkeit: Optional[str] = None
    state: Optional[str] = None
    flood_class: Optional[str] = None
    lhp_id: Optional[str] = None
    station_link: Optional[str] = None
    external_station_id: Optional[str] = None


class RiverSummary(BaseModel):
    river: str
    station_count: int
    best_status: CanoeStatus
    stations: list[str]


class RiverListResponse(BaseModel):
    rivers: list[RiverSummary]
    updated_at: str
