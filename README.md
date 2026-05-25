# FlowTrail Pegel-Feed

Statischer Befahrbarkeits-Datensatz für die [FlowTrail](https://github.com/3ddruck12/FlowTrail)-App.

**Mindestpegel** aus [`data/rules.json`](data/rules.json) (manuell gepflegt, ursprünglich von Kanu-NRW übernommen) + **Live-Pegel** von PEGELONLINE + **Hochwasser** von LHP — ohne VPS.

## Dateien

| Datei | Zweck |
|-------|-------|
| `data/rules.json` | **Mindestpegel pro Fluss/Messstelle** (Grundlage für grün/rot) |
| `manifest.json` | Version, Label, URL zu `pegel.json` |
| `pegel.json` | Flüsse + Abschnitte mit berechnetem Befahrbarkeitsstatus |
| `scripts/build_pegel_json.py` | Export-Skript (GitHub Actions) |
| `api/` | Python-Logik (Regeln, PEGELONLINE, LHP, Status) |

## Regeln bearbeiten

`data/rules.json` anpassen — Beispiel:

```json
{
  "river": "Rur",
  "station": "Dedenborn",
  "min_cm": 35,
  "ideal_min_cm": 35,
  "ideal_max_cm": 60,
  "max_cm": 95,
  "hint": "Einstieg nur bei ausreichend Wasser",
  "nrw_befahrbarkeit": "nicht befahrbar"
}
```

Nach Commit + Push baut die Action `update-pegel` automatisch neues `pegel.json`.

## Update-Zyklus

- **Automatisch:** GitHub Actions 2× täglich (05:00 und 17:00 UTC)
- **Manuell:** Actions → „update-pegel“ → Run workflow
- **Regeln prüfen:** Workflow `validate-rules` bei Änderungen an `data/rules.json`

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
