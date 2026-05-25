# FlowTrail Pegel-Feed

Statischer Befahrbarkeits-Datensatz für die [FlowTrail](https://github.com/3ddruck12/FlowTrail)-App.

Kanu-NRW-Mindestpegel + PEGELONLINE-Livewerte werden zusammengeführt und als JSON bereitgestellt — **ohne VPS**.

## Dateien

| Datei | Zweck |
|-------|-------|
| `manifest.json` | Version, Label, URL zu `pegel.json` |
| `pegel.json` | Flüsse + Abschnitte mit Befahrbarkeitsstatus |
| `scripts/build_pegel_json.py` | Export-Skript |
| `api/` | Python-Logik aus `befahrbarkeit-api` (Scraper, PEGELONLINE, Status) |

## Update-Zyklus

- **Automatisch:** GitHub Actions 2× täglich (05:00 und 17:00 UTC)
- **Manuell:** Actions → „update-pegel“ → Run workflow

## Lokal bauen

```bash
cd flowtrail-pegel
python3 -m venv .venv && source .venv/bin/activate
pip install -r scripts/requirements.txt
python scripts/build_pegel_json.py
```

## App-Konfiguration

```properties
PEGEL_FEED_MANIFEST_URL=https://raw.githubusercontent.com/3ddruck12/flowtrail-pegel/main/manifest.json
```

## Status-Werte

`too_low` · `ok` · `good` · `high` · `danger` · `unknown`

## Lizenz

Siehe [FlowTrail/LICENSE](https://github.com/3ddruck12/FlowTrail/blob/main/LICENSE).
