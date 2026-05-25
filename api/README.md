# Kanu-Befahrbarkeit API

REST-Backend zur **automatischen Bewertung der Flussbefahrbarkeit** für Kanufahrer in Deutschland.

## Architektur

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Kanu NRW       │     │  PEGELONLINE     │     │  LHP (optional) │
│  Scraper        │     │  API Client      │     │  Hochwasser     │
│  (Mindestpegel) │     │  (Live-Pegel)    │     │  Klassen        │
└────────┬────────┘     └────────┬─────────┘     └────────┬────────┘
         │                       │                          │
         └───────────────────────┼──────────────────────────┘
                                 ▼
                    ┌────────────────────────┐
                    │  RiverService          │
                    │  + SQLite              │
                    │  + In-Memory Cache     │
                    └────────────┬───────────┘
                                 ▼
                    ┌────────────────────────┐
                    │  get_canoe_status()    │
                    │  too_low | ok | good   │
                    │  high | danger         │
                    └────────────┬───────────┘
                                 ▼
                    ┌────────────────────────┐
                    │  FastAPI REST          │
                    │  GET /rivers           │
                    │  GET /status?river=…   │
                    └────────────────────────┘
```

| Modul | Aufgabe |
|-------|---------|
| `scrapers/kanu_nrw.py` | Scraped `sites.kanu-nrw.de/pegel.php` (iframe-Inhalt) |
| `clients/pegelonline.py` | Live-Pegel von [PEGELONLINE](https://pegelonline.wsv.de) |
| `clients/hochwasserzentralen.py` | Hochwasser-Klassen von [LHP](https://www.hochwasserzentralen.de/developers/) |
| `logic/status.py` | `get_canoe_status(current, rules)` |
| `services/database.py` | SQLite-Speicherung der Regeln |
| `jobs/sync.py` | Manueller Sync-Job |

## Datenmodell

```json
{
  "river": "Rur",
  "station": "Dedenborn",
  "min": 35,
  "ideal_min": 35,
  "ideal_max": 81,
  "max": 95,
  "hint": "NRW: nicht befahrbar | Link: …",
  "pegelonline_uuid": "…",
  "source": "kanu_nrw"
}
```

## Status-Logik

```python
get_canoe_status(current, rules)
```

| Status | Bedeutung |
|--------|-----------|
| `too_low` | ❌ Zu wenig Wasser |
| `ok` | 🟡 Bedingt fahrbar |
| `good` | ✅ Gut fahrbar |
| `high` | ⚠️ Hoher Pegel |
| `danger` | ⛔ Gefährlich (Hochwasser) |

## Schnellstart

```bash
cd befahrbarkeit-api
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env

# Sync + API starten
python main.py
# → http://localhost:8080/docs
```

## API-Endpunkte

```bash
# Alle Flüsse
curl http://localhost:8080/rivers

# Status für Fluss (alle Abschnitte)
curl "http://localhost:8080/status?river=Rur"

# Einzelne Station
curl "http://localhost:8080/status?river=Rur&station=Dedenborn"

# Manueller Sync
curl -X POST http://localhost:8080/sync
```

### Beispiel-Response

```json
{
  "river": "Rur",
  "station": "Dedenborn",
  "status": "too_low",
  "label": "❌ Zu wenig Wasser",
  "current": 12.0,
  "min": 35.0,
  "ideal_min": 35.0,
  "ideal_max": 81.0,
  "max": 95.0,
  "hint": "NRW: nicht befahrbar",
  "source": "kanu_nrw",
  "pegelonline_uuid": null,
  "nrw_befahrbarkeit": "nicht befahrbar"
}
```

## Tests

```bash
python -m unittest discover tests
```

## Hinweise

- **Kanu NRW** liefert Mindestpegel (`Soll`) für ~35 NRW-Kleinflüsse – kein Lippe/Kaunitz.
- **PEGELONLINE** deckt Bundeswasserstraßen ab; Mapping per Stationsname.
- **LHP** liefert keine cm-Werte, nur Hochwasserklassen (Endpoint konfigurierbar).
- `ideal_max` / `max` werden aus Mindestpegel **heuristisch** abgeleitet, wenn keine Detailwerte vorliegen.

## Cron / Sync

Automatisch alle 120 Minuten (konfigurierbar via `SYNC_INTERVAL_MINUTES`).

Manuell:

```bash
python -m jobs.sync
```
