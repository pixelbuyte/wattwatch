"""SQLite persistence. One row per minute keeps a year of history around ~50 MB."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

from .config import merge_settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS minutes (
    ts           INTEGER PRIMARY KEY,   -- unix seconds, start of the minute
    seconds      REAL    NOT NULL,      -- seconds covered by samples
    wh           REAL    NOT NULL,      -- energy at the wall
    dc_wh        REAL    NOT NULL,      -- energy delivered to components
    loss_wh      REAL    NOT NULL,      -- PSU conversion loss (heat)
    idle_wh      REAL    NOT NULL,      -- wall energy while the user was idle
    idle_seconds REAL    NOT NULL,
    cost         REAL    NOT NULL,      -- money, priced at the rate in force at the time
    avg_w        REAL, max_w REAL, min_w REAL,
    components   TEXT,                  -- JSON {component: avg watts}
    source       TEXT                   -- estimated | calibrated | measured | sleep | off
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calibration (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL, raw_w REAL NOT NULL, measured_w REAL NOT NULL, source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS downtime (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start INTEGER NOT NULL, "end" INTEGER NOT NULL, kind TEXT NOT NULL  -- sleep | off | unknown
);
CREATE TABLE IF NOT EXISTS achievements (id TEXT PRIMARY KEY, unlocked_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_downtime_end ON downtime("end");
"""


class Database:
    def __init__(self, path: Path | str):
        self.path = str(path)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False, timeout=10)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    # ------------------------------------------------------------------ low level
    def execute(self, sql: str, params=()):
        with self._lock:
            cur = self._conn.execute(sql, params)
            self._conn.commit()
            return cur

    def query(self, sql: str, params=()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, params).fetchall()

    def one(self, sql: str, params=()):
        with self._lock:
            return self._conn.execute(sql, params).fetchone()

    def close(self):
        with self._lock:
            self._conn.close()

    # ------------------------------------------------------------------ settings
    def load_settings(self) -> dict:
        stored = {r["key"]: json.loads(r["value"]) for r in self.query("SELECT key, value FROM settings")}
        return merge_settings(stored)

    def save_settings(self, settings: dict) -> None:
        with self._lock:
            self._conn.executemany(
                "INSERT INTO settings(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [(k, json.dumps(v)) for k, v in settings.items()],
            )
            self._conn.commit()

    # ------------------------------------------------------------------ meta
    def get_meta(self, key: str, default=None):
        row = self.one("SELECT value FROM meta WHERE key=?", (key,))
        return json.loads(row["value"]) if row else default

    def set_meta(self, key: str, value) -> None:
        self.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )

    # ------------------------------------------------------------------ minutes
    def write_minute(self, row: dict) -> None:
        """Insert or merge a minute bucket (merging handles restarts within a minute)."""
        comps = json.dumps({k: round(v, 3) for k, v in row["components"].items()})
        with self._lock:
            existing = self._conn.execute("SELECT * FROM minutes WHERE ts=?", (row["ts"],)).fetchone()
            if existing:
                secs = existing["seconds"] + row["seconds"]
                old_c = json.loads(existing["components"] or "{}")
                merged = {}
                for k in set(old_c) | set(row["components"]):
                    a, b = old_c.get(k, 0.0), row["components"].get(k, 0.0)
                    merged[k] = round((a * existing["seconds"] + b * row["seconds"]) / max(secs, 1e-9), 3)
                self._conn.execute(
                    "UPDATE minutes SET seconds=?, wh=wh+?, dc_wh=dc_wh+?, loss_wh=loss_wh+?, idle_wh=idle_wh+?,"
                    " idle_seconds=idle_seconds+?, cost=cost+?, avg_w=?, max_w=MAX(max_w, ?), min_w=MIN(min_w, ?),"
                    " components=?, source=? WHERE ts=?",
                    (secs, row["wh"], row["dc_wh"], row["loss_wh"], row["idle_wh"], row["idle_seconds"],
                     row["cost"], (existing["wh"] + row["wh"]) * 3600 / max(secs, 1e-9),
                     row["max_w"], row["min_w"], json.dumps(merged), row["source"], row["ts"]),
                )
            else:
                self._conn.execute(
                    "INSERT INTO minutes(ts, seconds, wh, dc_wh, loss_wh, idle_wh, idle_seconds, cost,"
                    " avg_w, max_w, min_w, components, source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (row["ts"], row["seconds"], row["wh"], row["dc_wh"], row["loss_wh"], row["idle_wh"],
                     row["idle_seconds"], row["cost"], row["avg_w"], row["max_w"], row["min_w"], comps,
                     row["source"]),
                )
            self._conn.commit()

    def write_minutes_bulk(self, rows: list[dict]) -> None:
        with self._lock:
            self._conn.executemany(
                "INSERT OR REPLACE INTO minutes(ts, seconds, wh, dc_wh, loss_wh, idle_wh, idle_seconds, cost,"
                " avg_w, max_w, min_w, components, source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [(r["ts"], r["seconds"], r["wh"], r["dc_wh"], r["loss_wh"], r["idle_wh"], r["idle_seconds"],
                  r["cost"], r["avg_w"], r["max_w"], r["min_w"],
                  json.dumps({k: round(v, 3) for k, v in r["components"].items()}), r["source"]) for r in rows],
            )
            self._conn.commit()

    def totals(self, start: float, end: float | None = None) -> dict:
        end = end if end is not None else time.time() + 60
        r = self.one(
            "SELECT COALESCE(SUM(wh),0) wh, COALESCE(SUM(dc_wh),0) dc_wh, COALESCE(SUM(loss_wh),0) loss_wh,"
            " COALESCE(SUM(idle_wh),0) idle_wh, COALESCE(SUM(idle_seconds),0) idle_seconds,"
            " COALESCE(SUM(cost),0) cost,"
            " COALESCE(SUM(CASE WHEN source NOT IN ('sleep','off') THEN seconds ELSE 0 END),0) awake_seconds,"
            " COALESCE(SUM(CASE WHEN source IN ('sleep','off') THEN seconds ELSE 0 END),0) asleep_seconds,"
            " COALESCE(SUM(CASE WHEN source IN ('sleep','off') THEN wh ELSE 0 END),0) asleep_wh,"
            " COUNT(*) minutes FROM minutes WHERE ts >= ? AND ts < ?",
            (int(start), int(end)),
        )
        return dict(r)

    def last_minute_ts(self) -> int | None:
        r = self.one("SELECT MAX(ts) m FROM minutes")
        return r["m"] if r and r["m"] is not None else None

    def first_minute_ts(self) -> int | None:
        r = self.one("SELECT MIN(ts) m FROM minutes")
        return r["m"] if r and r["m"] is not None else None

    # ------------------------------------------------------------------ misc tables
    def add_downtime(self, start: float, end: float, kind: str) -> None:
        self.execute('INSERT INTO downtime(start, "end", kind) VALUES(?,?,?)', (int(start), int(end), kind))

    def add_event(self, kind: str, title: str, message: str) -> int:
        cur = self.execute("INSERT INTO events(ts, kind, title, message) VALUES(?,?,?,?)",
                           (int(time.time()), kind, title, message))
        return cur.lastrowid

    def events_since(self, since_id: int, limit: int = 50) -> list[dict]:
        return [dict(r) for r in self.query(
            "SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?", (since_id, limit))]

    def recent_events(self, limit: int = 30) -> list[dict]:
        return [dict(r) for r in self.query("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,))]
