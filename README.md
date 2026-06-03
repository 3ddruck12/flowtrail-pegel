# FlowTrail Pegel-Feed

Statischer Befahrbarkeits-Datensatz für die [FlowTrail](https://github.com/3ddruck12/FlowTrail)-App.

**Mindestpegel** aus [`data/rules.json`](data/rules.json) + **LHP** (Bundesland & Hochwasser) + **OpenHygon NRW** (Live-cm für `DE-NW`) + **PEGELONLINE** (Fallback) — ohne VPS.

| Datei | Zweck |
|-------|-------|
| `data/rules.json` | **Mindestpegel pro Fluss/Messstelle** (Grundlage für grün/rot) |
| `manifest.json` | Version, Label, URL zu `pegel.json` |
| `pegel.json` | Flüsse + Abschnitte mit Status, `state`, `flood_class`, Live-cm |
| `scripts/build_pegel_json.py` | Export-Skript (GitHub Actions) |
| `api/clients/levels/` | Erweiterbare Landes-Provider (aktuell: OpenHygon NRW) |

## Gewässer-Feed (Flussläufe)

Statische GeoJSON-Linien als Alternative zur langsamen Overpass-API in der App (Phase 2).

| Datei | Zweck |
|-------|-------|
| [`community-waterways.geojson`](community-waterways.geojson) | Manuell gepflegte/korrigierte Gewässerlinien |
| [`osm-waterways.geojson`](osm-waterways.geojson) | OSM-Import (Flüsse + Kanäle, pro Region) |
| [`waterways.geojson`](waterways.geojson) | **Generierter App-Feed** (Merge, nicht manuell editieren) |
| [`waterways-manifest.json`](waterways-manifest.json) | Version, Label, URL für spätere App-Integration |
| [`editor/`](editor/) | Web-Editor (GitHub Pages) |
| `scripts/import_osm_waterways.py` | OSM → `osm-waterways.geojson` |
| `scripts/merge_waterways.py` | Community + OSM → `waterways.geojson` |

**Karten-Editor:** [3ddruck12.github.io/flowtrail-pegel](https://3ddruck12.github.io/flowtrail-pegel/) — Gewässer **und** POIs (Tab „POIs“)

### Gewässer bearbeiten

1. [Editor](https://3ddruck12.github.io/flowtrail-pegel/) — lädt **Gewässer, Flussführer und POIs** aus den Repos
2. Tab **Gewässer:** Fluss (blau) · **Umtrag** (gelb) · **Weg/Straße** · **Umtrag E/A** (am Gewässer)
3. **Flussführer:** Beschreibung + Abschnitte mit Regeln (`river-guides.json`)
4. Tab **POIs:** Navigation-POIs (Wehr, Rastplatz, Verboten …) und **Pegel** (Messstelle aus `pegel.json` verknüpfen) → `flowtrail-pois`
5. **Token** (Schreibrechte auf **pegel** + **pois**) + **In Repos speichern**
6. Actions `merge-waterways` / `merge-pois` → App-Feeds (~1 Min.)
7. App: Info → **Flussläufe** und **POI-Daten** aktualisieren

| Datei | Inhalt |
|-------|--------|
| `community-waterways.geojson` | Flüsse, Umträge, Ein-/Ausstieg (GeoJSON) |
| `river-guides.json` | Texte, Abschnitte, Regeln je Fluss |
| `waterways.geojson` | Merge für die App |

OSM-Basis aktualisieren: Actions → **import-osm-waterways** → Region `nw` oder `de`.

Import filtert auf `waterway=river` und `waterway=canal` (keine Gräben/Bäche) — kleineres, kanu-relevanteres Dataset.

### Phase 2 (App)

- `waterways-manifest.json` in Kanuapp laden statt Overpass-Overlay
- Einmal-Download + Viewport-Filter (deutlich schneller als Live-API)
- Pegel-Marker auf Flusslinien snappen (`lat`/`river_km` in `rules.json`)

---

## Regeln bearbeiten

### Eigene Pegel pflegen + auf der Karte zuordnen

1. **Regeln** in [`data/rules.json`](data/rules.json) (manuell oder im Editor Tab POIs → Typ Pegel → „Regel in rules.json übernehmen“).
2. **Karten-POI** Typ Pegel: Position setzen, Fluss/Messstelle aus Liste **oder Freitext**, optional PEGELONLINE-UUID / OpenHygon-ID.
3. **In Repos speichern** → schreibt `rules.json` + `community-pois.geojson`.
4. GitHub Action **update-pegel** baut `pegel.json` (Live-Werte für die App).

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
