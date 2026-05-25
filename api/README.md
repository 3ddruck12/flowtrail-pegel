# Kanu-Befahrbarkeit API

REST-Backend zur **automatischen Bewertung der Flussbefahrbarkeit** für Kanufahrer in Deutschland.

## Architektur

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  data/rules.json│     │  PEGELONLINE     │     │  LHP            │
│  Mindestpegel   │     │  (Fallback cm)   │     │  Bundesland +   │
└────────┬────────┘     └────────┬─────────┘     │  Hochwasser     │
         │                       │               └────────┬────────┘
         │              ┌────────┴─────────┐              │
         │              │ LevelResolver    │◄─────────────┘
         │              │ + OpenHygon NRW  │
         └──────────────┤ + weitere BL…    │
                        └────────┬─────────┘
                                 ▼
                    ┌────────────────────────┐
                    │  RiverService          │
                    │  + SQLite              │
                    └────────────┬───────────┘
                                 ▼
                    ┌────────────────────────┐
                    │  get_canoe_status()    │
                    └────────────┬───────────┘
                                 ▼
                    ┌────────────────────────┐
                    │  FastAPI / pegel.json  │
                    └────────────────────────┘
```

| Modul | Aufgabe |
|-------|---------|
| `loaders/rules_file.py` | Lädt Mindestpegel aus `data/rules.json` |
| `clients/hochwasserzentralen.py` | LHP: `stateId`, Hochwasserklasse, `stationLink` |
| `clients/levels/openhygon_nrw.py` | Live-Pegel NRW (`DE-NW`) via [OpenHygon](https://www.opengeodata.nrw.de/produkte/umwelt_klima/wasser/oberflaechengewaesser/hygon/) |
| `clients/levels/pegelonline_provider.py` | Bundesweiter cm-Fallback |
| `services/level_resolver.py` | LHP → Bundesland → Provider |
| `clients/pegelonline.py` | PEGELONLINE REST-Client |
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
- **LHP** ([Public API](https://www.hochwasserzentralen.de/developers/api-docs-stable-swagger)): Bundesland (`stateId`), Hochwasserklasse, Links — **keine cm-Werte**
- **OpenHygon NRW** für `DE-NW`: Live-Pegel in cm; weitere Bundesländer über neue Provider unter `clients/levels/`
- Regeln optional mit `"state": "DE-NW"`, `"external_station_id"`, `"level_provider": "openhygon"`
- `ideal_max` / `max` werden aus Mindestpegel **heuristisch** abgeleitet, wenn keine Detailwerte vorliegen.

## Cron / Sync

Automatisch alle 120 Minuten (konfigurierbar via `SYNC_INTERVAL_MINUTES`).

Manuell:

```bash
python -m jobs.sync
```
