"""SQLite persistence for river rules."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from config import settings
from models.schemas import RiverRule


class Database:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or settings.db_path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS river_rules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    river TEXT NOT NULL,
                    station TEXT NOT NULL,
                    min REAL NOT NULL,
                    ideal_min REAL NOT NULL,
                    ideal_max REAL NOT NULL,
                    max REAL NOT NULL,
                    hint TEXT,
                    pegelonline_uuid TEXT,
                    source TEXT NOT NULL,
                    nrw_befahrbarkeit TEXT,
                    updated_at TEXT NOT NULL,
                    UNIQUE(river, station)
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS sync_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source TEXT NOT NULL,
                    status TEXT NOT NULL,
                    message TEXT,
                    created_at TEXT NOT NULL
                )
                """
            )

    def upsert_rules(self, rules: list[RiverRule]) -> int:
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as conn:
            for rule in rules:
                conn.execute(
                    """
                    INSERT INTO river_rules (
                        river, station, min, ideal_min, ideal_max, max,
                        hint, pegelonline_uuid, source, nrw_befahrbarkeit, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(river, station) DO UPDATE SET
                        min=excluded.min,
                        ideal_min=excluded.ideal_min,
                        ideal_max=excluded.ideal_max,
                        max=excluded.max,
                        hint=excluded.hint,
                        pegelonline_uuid=excluded.pegelonline_uuid,
                        source=excluded.source,
                        nrw_befahrbarkeit=excluded.nrw_befahrbarkeit,
                        updated_at=excluded.updated_at
                    """,
                    (
                        rule.river,
                        rule.station,
                        rule.min,
                        rule.ideal_min,
                        rule.ideal_max,
                        rule.max,
                        rule.hint,
                        rule.pegelonline_uuid,
                        rule.source,
                        rule.nrw_befahrbarkeit,
                        now,
                    ),
                )
        return len(rules)

    def list_rules(self, river: Optional[str] = None) -> list[RiverRule]:
        query = "SELECT * FROM river_rules"
        params: tuple = ()
        if river:
            query += " WHERE lower(river) = lower(?)"
            params = (river,)
        query += " ORDER BY river, station"

        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()

        return [
            RiverRule(
                river=row["river"],
                station=row["station"],
                min=row["min"],
                ideal_min=row["ideal_min"],
                ideal_max=row["ideal_max"],
                max=row["max"],
                hint=row["hint"],
                pegelonline_uuid=row["pegelonline_uuid"],
                source=row["source"],
                nrw_befahrbarkeit=row["nrw_befahrbarkeit"],
            )
            for row in rows
        ]

    def list_rivers(self) -> list[str]:
        with self._connect() as conn:
            rows = conn.execute("SELECT DISTINCT river FROM river_rules ORDER BY river").fetchall()
        return [row["river"] for row in rows]

    def log_sync(self, source: str, status: str, message: str = "") -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO sync_log (source, status, message, created_at) VALUES (?, ?, ?, ?)",
                (source, status, message, datetime.now(timezone.utc).isoformat()),
            )

    def export_rules_json(self, path: Path) -> None:
        rules = self.list_rules()
        payload = [json.loads(rule.model_dump_json()) for rule in rules]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
