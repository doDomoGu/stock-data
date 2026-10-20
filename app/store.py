"""本地存储层：SQLite 同时承担行情缓存与历史数据仓库。

单机单用户的读多写少场景下，SQLite 单文件足够；将来要换成
RDS/PostgreSQL 时只需替换本文件的实现，上层不感知。
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Any, Iterable

from . import config

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS kv_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS kline (
    code TEXT NOT NULL,
    klt INTEGER NOT NULL,
    fqt INTEGER NOT NULL,
    trade_date TEXT NOT NULL,
    open REAL, high REAL, low REAL, close REAL,
    volume REAL, amount REAL, pct_chg REAL, turnover REAL,
    PRIMARY KEY (code, klt, fqt, trade_date)
);
CREATE TABLE IF NOT EXISTS financials (
    code TEXT NOT NULL,
    report_date TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (code, report_date)
);
CREATE TABLE IF NOT EXISTS valuation (
    code TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    pe_ttm REAL,
    pb_mrq REAL,
    close REAL,
    total_market_cap REAL,
    total_shares REAL,
    PRIMARY KEY (code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_kline_code ON kline (code, klt, fqt, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_valuation_code ON valuation (code, trade_date DESC);
CREATE TABLE IF NOT EXISTS favorites (
    code TEXT PRIMARY KEY,
    name TEXT,
    created_at REAL NOT NULL
);
"""


@contextmanager
def conn():
    """每个线程一个连接；FastAPI 的同步接口跑在线程池里，连接不能跨线程共享。"""
    c = getattr(_local, "conn", None)
    if c is None:
        c = sqlite3.connect(config.DB_PATH, timeout=30)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        _local.conn = c
    yield c


def init_db() -> None:
    with conn() as c:
        c.executescript(SCHEMA)
        _migrate(c)
        c.commit()


def _migrate(c: sqlite3.Connection) -> None:
    """给已存在的旧库补列，避免升级时要手工删库。"""
    columns = {row["name"] for row in c.execute("PRAGMA table_info(valuation)")}
    if "total_market_cap" not in columns:
        c.execute("ALTER TABLE valuation ADD COLUMN total_market_cap REAL")
    if "total_shares" not in columns:
        c.execute("ALTER TABLE valuation ADD COLUMN total_shares REAL")


# ---------------------------------------------------------------- key-value 缓存

def cache_get(key: str, ttl: float) -> Any | None:
    with conn() as c:
        row = c.execute("SELECT value, updated_at FROM kv_cache WHERE key = ?", (key,)).fetchone()
    if not row:
        return None
    if ttl >= 0 and time.time() - row["updated_at"] > ttl:
        return None
    try:
        return json.loads(row["value"])
    except json.JSONDecodeError:
        return None


def cache_set(key: str, value: Any) -> None:
    with conn() as c:
        c.execute(
            "INSERT INTO kv_cache (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (key, json.dumps(value, ensure_ascii=False), time.time()),
        )
        c.commit()


def cache_age(key: str) -> float | None:
    with conn() as c:
        row = c.execute("SELECT updated_at FROM kv_cache WHERE key = ?", (key,)).fetchone()
    return None if not row else round(time.time() - row["updated_at"], 1)


# ---------------------------------------------------------------- 日线

def save_kline(code: str, klt: int, fqt: int, rows: Iterable[dict]) -> None:
    payload = [
        (
            code, klt, fqt, r["date"], r.get("open"), r.get("high"), r.get("low"),
            r.get("close"), r.get("volume"), r.get("amount"), r.get("pct_chg"), r.get("turnover"),
        )
        for r in rows
    ]
    if not payload:
        return
    with conn() as c:
        c.executemany(
            "INSERT INTO kline (code, klt, fqt, trade_date, open, high, low, close, volume, amount, pct_chg, turnover) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(code, klt, fqt, trade_date) DO UPDATE SET "
            "open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, "
            "volume=excluded.volume, amount=excluded.amount, pct_chg=excluded.pct_chg, turnover=excluded.turnover",
            payload,
        )
        c.commit()


def load_kline(code: str, klt: int, fqt: int, limit: int) -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT trade_date, open, high, low, close, volume, amount, pct_chg, turnover FROM kline "
            "WHERE code = ? AND klt = ? AND fqt = ? ORDER BY trade_date DESC LIMIT ?",
            (code, klt, fqt, limit),
        ).fetchall()
    # 对外统一用 date 字段名，与数据源返回的 K 线结构保持一致
    return [
        {
            "date": r["trade_date"], "open": r["open"], "high": r["high"], "low": r["low"],
            "close": r["close"], "volume": r["volume"], "amount": r["amount"],
            "pct_chg": r["pct_chg"], "turnover": r["turnover"],
        }
        for r in reversed(rows)
    ]


def kline_last_date(code: str, klt: int, fqt: int) -> str | None:
    with conn() as c:
        row = c.execute(
            "SELECT MAX(trade_date) AS d FROM kline WHERE code = ? AND klt = ? AND fqt = ?",
            (code, klt, fqt),
        ).fetchone()
    return row["d"] if row else None


# ---------------------------------------------------------------- 财报

def save_financials(code: str, records: list[dict]) -> None:
    now = time.time()
    with conn() as c:
        c.executemany(
            "INSERT INTO financials (code, report_date, payload, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(code, report_date) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
            [(code, r["report_date"], json.dumps(r, ensure_ascii=False), now) for r in records],
        )
        c.commit()


def load_financials(code: str, limit: int = 8) -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT payload FROM financials WHERE code = ? ORDER BY report_date DESC LIMIT ?",
            (code, limit),
        ).fetchall()
    return [json.loads(r["payload"]) for r in rows]


def financials_updated_at(code: str) -> float | None:
    with conn() as c:
        row = c.execute("SELECT MAX(updated_at) AS t FROM financials WHERE code = ?", (code,)).fetchone()
    return row["t"] if row and row["t"] else None


# ---------------------------------------------------------------- 估值历史

def save_valuation(code: str, rows: list[dict]) -> None:
    if not rows:
        return
    with conn() as c:
        c.executemany(
            "INSERT INTO valuation (code, trade_date, pe_ttm, pb_mrq, close, total_market_cap, total_shares) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(code, trade_date) DO UPDATE SET pe_ttm = excluded.pe_ttm, pb_mrq = excluded.pb_mrq, "
            "close = excluded.close, total_market_cap = excluded.total_market_cap, total_shares = excluded.total_shares",
            [(code, r["trade_date"], r.get("pe_ttm"), r.get("pb_mrq"), r.get("close"),
              r.get("total_market_cap"), r.get("total_shares")) for r in rows],
        )
        c.commit()


def load_valuation(code: str, limit: int = 1250) -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT trade_date, pe_ttm, pb_mrq, close, total_market_cap, total_shares FROM valuation "
            "WHERE code = ? ORDER BY trade_date DESC LIMIT ?",
            (code, limit),
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


def latest_valuation(code: str) -> dict | None:
    with conn() as c:
        row = c.execute(
            "SELECT trade_date, pe_ttm, pb_mrq, close, total_market_cap, total_shares FROM valuation "
            "WHERE code = ? ORDER BY trade_date DESC LIMIT 1",
            (code,),
        ).fetchone()
    return dict(row) if row else None


def valuation_last_date(code: str) -> str | None:
    with conn() as c:
        row = c.execute("SELECT MAX(trade_date) AS d FROM valuation WHERE code = ?", (code,)).fetchone()
    return row["d"] if row else None


def stats() -> dict:
    with conn() as c:
        return {
            "db_path": str(config.DB_PATH),
            "kline_rows": c.execute("SELECT COUNT(*) AS n FROM kline").fetchone()["n"],
            "financial_rows": c.execute("SELECT COUNT(*) AS n FROM financials").fetchone()["n"],
            "valuation_rows": c.execute("SELECT COUNT(*) AS n FROM valuation").fetchone()["n"],
            "cache_keys": c.execute("SELECT COUNT(*) AS n FROM kv_cache").fetchone()["n"],
            "favorites": c.execute("SELECT COUNT(*) AS n FROM favorites").fetchone()["n"],
        }


# ---------------------------------------------------------------- 自选股（单用户共用）

def list_favorites() -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT code, name, created_at FROM favorites ORDER BY created_at ASC"
        ).fetchall()
    return [dict(r) for r in rows]


def add_favorite(code: str, name: str | None) -> None:
    with conn() as c:
        c.execute(
            "INSERT INTO favorites (code, name, created_at) VALUES (?, ?, ?) "
            "ON CONFLICT(code) DO UPDATE SET name = COALESCE(excluded.name, favorites.name)",
            (code, name, time.time()),
        )
        c.commit()


def is_favorite(code: str) -> bool:
    with conn() as c:
        row = c.execute("SELECT 1 FROM favorites WHERE code = ?", (code,)).fetchone()
    return row is not None


def remove_favorite(code: str) -> bool:
    with conn() as c:
        cur = c.execute("DELETE FROM favorites WHERE code = ?", (code,))
        c.commit()
        return cur.rowcount > 0


def update_favorite_name(code: str, name: str | None) -> None:
    if not name:
        return
    with conn() as c:
        c.execute("UPDATE favorites SET name = ? WHERE code = ? AND (name IS NULL OR name = '')", (name, code))
        c.commit()
