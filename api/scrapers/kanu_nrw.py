"""Scraper für Kanu-Verband NRW Pegeldienst."""

from __future__ import annotations

import logging
import re
from typing import Optional

import httpx
from bs4 import BeautifulSoup
from tenacity import retry, stop_after_attempt, wait_exponential

from config import settings
from logic.status import rules_from_nrw_minimum
from models.schemas import RiverRule

logger = logging.getLogger(__name__)

CM_VALUE_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*cm", re.IGNORECASE)


def parse_cm_value(raw: str) -> Optional[float]:
    """Extrahiert cm-Wert aus Strings wie '035 cm' oder '012 cm (Δ -23,00 cm)'."""
    if not raw:
        return None
    match = CM_VALUE_RE.search(raw.replace("\xa0", " "))
    if not match:
        return None
    return float(match.group(1).replace(",", "."))


class KanuNrwScraper:
    """Lädt Pegelregeln von sites.kanu-nrw.de/pegel.php (iframe-Inhalt)."""

    def __init__(self, url: str | None = None, timeout: float = 30.0) -> None:
        self.url = url or settings.kanu_nrw_pegel_url
        self.timeout = timeout
        self.headers = {"User-Agent": "KanuBefahrbarkeit/1.0 (+https://github.com/kanuapp)"}

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
    def fetch_html(self) -> str:
        with httpx.Client(timeout=self.timeout, headers=self.headers, follow_redirects=True) as client:
            response = client.get(self.url)
            response.raise_for_status()
            return response.text

    def parse_html(self, html: str) -> list[dict]:
        soup = BeautifulSoup(html, "html.parser")
        tables = soup.find_all("table")
        records: list[dict] = []

        for table in tables:
            row_data: dict[str, str] = {}
            link_href: Optional[str] = None

            for row in table.find_all("tr"):
                cells = row.find_all(["td", "th"])
                if len(cells) < 2:
                    continue
                key = cells[0].get_text(strip=True).lower()
                value_cell = cells[1]
                value = value_cell.get_text(" ", strip=True)
                row_data[key] = value

                anchor = value_cell.find("a", href=True)
                if anchor and key == "link":
                    link_href = anchor["href"]

            if not row_data.get("fluss") or not row_data.get("name"):
                continue

            records.append(
                {
                    "river": row_data.get("fluss", "").strip(),
                    "station": row_data.get("name", "").strip(),
                    "min_cm": parse_cm_value(row_data.get("soll", "")),
                    "current_cm": parse_cm_value(row_data.get("ist", "")),
                    "befahrbarkeit": row_data.get("befahrbarkeit"),
                    "hint": row_data.get("hinweis") or row_data.get("info"),
                    "link": link_href,
                    "raw": row_data,
                }
            )

        if not records:
            records = self._parse_fallback_blocks(soup)

        logger.info("Kanu NRW: %s Pegelstationen extrahiert", len(records))
        return records

    def _parse_fallback_blocks(self, soup: BeautifulSoup) -> list[dict]:
        """Fallback wenn Tabellenstruktur geändert wurde."""
        records: list[dict] = []
        text = soup.get_text("\n")
        current: dict = {}

        for line in text.split("\n"):
            line = line.strip()
            if not line:
                if current.get("river") and current.get("station"):
                    records.append(current)
                current = {}
                continue

            lower = line.lower()
            if lower.startswith("fluss:"):
                current["river"] = line.split(":", 1)[1].strip()
            elif lower.startswith("name:"):
                current["station"] = line.split(":", 1)[1].strip()
            elif lower.startswith("soll:"):
                current["min_cm"] = parse_cm_value(line)
            elif lower.startswith("ist:"):
                current["current_cm"] = parse_cm_value(line)
            elif lower.startswith("befahrbarkeit:"):
                current["befahrbarkeit"] = line.split(":", 1)[1].strip()

        if current.get("river") and current.get("station"):
            records.append(current)

        return records

    def scrape_rules(self) -> list[RiverRule]:
        html = self.fetch_html()
        records = self.parse_html(html)
        rules: list[RiverRule] = []

        for record in records:
            min_cm = record.get("min_cm")
            if min_cm is None:
                logger.warning("Überspringe %s/%s – kein Mindestpegel", record.get("river"), record.get("station"))
                continue

            hint_parts = []
            if record.get("befahrbarkeit"):
                hint_parts.append(f"NRW: {record['befahrbarkeit']}")
            if record.get("link"):
                hint_parts.append(f"Link: {record['link']}")

            rules.append(
                rules_from_nrw_minimum(
                    river=record["river"],
                    station=record["station"],
                    min_cm=min_cm,
                    hint=" | ".join(hint_parts) if hint_parts else None,
                    nrw_befahrbarkeit=record.get("befahrbarkeit"),
                )
            )

        return rules

    def scrape_live_readings(self) -> list[dict]:
        """NRW-Istwerte direkt von der Pegelseite (Fallback wenn PEGELONLINE nicht matcht)."""
        html = self.fetch_html()
        return self.parse_html(html)
