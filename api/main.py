"""
Kanu-Befahrbarkeit API
======================
REST-API zur Bewertung der Flussbefahrbarkeit für Kanufahrer in Deutschland.

Architektur:
  scrapers/kanu_nrw.py     → Mindestpegel aus Kanu-Verband NRW (sites.kanu-nrw.de/pegel.php)
  clients/pegelonline.py   → Live-Pegelstände bundesweit (PEGELONLINE WSV)
  clients/hochwasserzentralen.py → Hochwasser-Klassen (LHP, optional)
  logic/status.py          → get_canoe_status() Bewertungslogik
  services/river_service.py → Orchestrierung + Caching + SQLite
  main.py                  → FastAPI Endpunkte
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from jobs.sync import main as run_sync
from models.schemas import RiverListResponse, StatusResponse
from services.river_service import RiverService

logging.basicConfig(level=logging.DEBUG if settings.debug else logging.INFO)
logger = logging.getLogger(__name__)

river_service = RiverService()
scheduler = BackgroundScheduler()


@asynccontextmanager
async def lifespan(_: FastAPI):
    logger.info("Starte Befahrbarkeit-API …")
    try:
        river_service.sync_all()
    except Exception as exc:
        logger.error("Initialer Sync fehlgeschlagen: %s", exc)

    scheduler.add_job(river_service.sync_all, "interval", minutes=settings.sync_interval_minutes, id="sync_rules")
    scheduler.start()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(
    title="Kanu Befahrbarkeit API",
    description="Pegelbasierte Befahrbarkeitsbewertung für Kanufahrer in Deutschland",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/rivers", response_model=RiverListResponse)
def get_rivers() -> RiverListResponse:
    """Alle Flüsse mit Messstellen und aggregiertem Status."""
    return river_service.list_rivers()


@app.get("/status", response_model=list[StatusResponse])
def get_status(
    river: str = Query(..., description="Flussname, z.B. Lippe oder Rur"),
    station: Optional[str] = Query(None, description="Optional: einzelne Messstelle"),
) -> list[StatusResponse]:
    """
    Befahrbarkeitsstatus für einen Fluss (alle Abschnitte) oder eine Station.

    Beispiel:
      GET /status?river=Rur
      GET /status?river=Rur&station=Dedenborn
    """
    results = river_service.get_river_statuses(river, station)
    if not results:
        raise HTTPException(status_code=404, detail=f"Keine Daten für Fluss '{river}' gefunden")
    return results


@app.post("/sync")
def trigger_sync() -> dict:
    """Manueller Sync: Kanu-NRW scrapen + PEGELONLINE mappen."""
    return river_service.sync_all()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host=settings.host, port=settings.port, reload=settings.debug)
