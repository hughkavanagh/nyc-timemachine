"""
Phase 1b: Load NYC PLUTO into the same SQLite database as the scraped photos.

PLUTO (Primary Land Use Tax Lot Output) is a public NYC Open Data dataset
containing one row per tax lot in NYC, including the canonical BBL, street
address, and lat/lon of the lot centroid. We'll later join it to the scraped
Preservica rows on BBL to give every photo a lat/lon.

Source: https://data.cityofnewyork.us/resource/64uk-42ks
(Socrata API, no auth required for public datasets, ~858k rows total.)

Runs independently of the Preservica scraper — writes to a different table
(`pluto`) in the same DB, which is safe under WAL mode.

Usage:
    python fetch_pluto.py           # full download
    python fetch_pluto.py --limit 10000  # small test
"""

from __future__ import annotations

import argparse
import json
import logging
import sqlite3
import sys
import time
from pathlib import Path

from curl_cffi import requests as cffi_requests

DATASET = "64uk-42ks"
BASE = f"https://data.cityofnewyork.us/resource/{DATASET}.json"
PAGE_SIZE = 50_000  # Socrata hard limit per request

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "nyc_photos.sqlite"

# PLUTO stores borough as 2-letter code; our photos DB uses the 1-5 code
# matching the NYC BBL borough digit. Keep both.
BOROUGH_CODE = {"MN": 1, "BX": 2, "BK": 3, "QN": 4, "SI": 5}

SCHEMA = """
CREATE TABLE IF NOT EXISTS pluto (
    bbl        INTEGER PRIMARY KEY,
    borough    INTEGER NOT NULL,        -- 1..5 to match photos.borough
    block      INTEGER NOT NULL,
    lot        INTEGER NOT NULL,
    address    TEXT,
    latitude   REAL,
    longitude  REAL,
    fetched_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pluto_borough       ON pluto(borough);
CREATE INDEX IF NOT EXISTS idx_pluto_borough_block ON pluto(borough, block);

-- Convenience view: photos enriched with lat/lon + address from PLUTO.
CREATE VIEW IF NOT EXISTS photos_geo AS
SELECT
    p.io_uuid,
    p.borough,
    p.block,
    p.lot,
    p.bbl,
    l.latitude,
    l.longitude,
    l.address
FROM photos p
LEFT JOIN pluto l ON l.bbl = p.bbl;
"""


def open_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30.0)
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


def to_float(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def to_int(s: str | None) -> int | None:
    if s is None or s == "":
        return None
    try:
        # BBL strings come like "1000040007.00000000" — truncate.
        return int(float(s))
    except ValueError:
        return None


def fetch_page(client: cffi_requests.Session, offset: int, limit: int) -> list[dict]:
    params = {
        "$select": "bbl,borough,block,lot,address,latitude,longitude",
        "$limit": limit,
        "$offset": offset,
        "$order": "bbl",
    }
    for attempt in range(1, 6):
        try:
            r = client.get(BASE, params=params, timeout=60.0)
            if r.status_code == 200:
                return r.json()
            logging.warning("offset=%d got %d, retrying", offset, r.status_code)
        except Exception as e:
            logging.warning("offset=%d attempt=%d error %s", offset, attempt, e)
        time.sleep(2 * attempt)
    raise RuntimeError(f"failed to fetch offset={offset}")


def save_batch(conn: sqlite3.Connection, rows: list[dict]) -> int:
    now = time.time()
    clean: list[tuple] = []
    for r in rows:
        bbl = to_int(r.get("bbl"))
        if bbl is None:
            continue
        b2 = r.get("borough") or ""
        borough = BOROUGH_CODE.get(b2)
        if borough is None:
            continue
        block = to_int(r.get("block"))
        lot = to_int(r.get("lot"))
        if block is None or lot is None:
            continue
        clean.append((
            bbl, borough, block, lot,
            r.get("address"),
            to_float(r.get("latitude")),
            to_float(r.get("longitude")),
            now,
        ))
    with conn:
        conn.executemany(
            "INSERT OR REPLACE INTO pluto "
            "(bbl, borough, block, lot, address, latitude, longitude, fetched_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            clean,
        )
    return len(clean)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--limit", type=int, default=None,
                   help="cap total rows for testing (default: all ~860k)")
    p.add_argument("--page-size", type=int, default=PAGE_SIZE)
    p.add_argument("--verbose", "-v", action="store_true")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    conn = open_db(DB_PATH)
    existing = conn.execute("SELECT COUNT(*) FROM pluto").fetchone()[0]
    logging.info("pluto table has %d existing rows", existing)

    t0 = time.time()
    total = 0
    offset = 0
    page_size = args.page_size

    with cffi_requests.Session(impersonate="chrome") as client:
        while True:
            fetch_size = page_size
            if args.limit is not None:
                remaining = args.limit - total
                if remaining <= 0:
                    break
                fetch_size = min(page_size, remaining)
            rows = fetch_page(client, offset, fetch_size)
            if not rows:
                break
            saved = save_batch(conn, rows)
            total += saved
            elapsed = time.time() - t0
            rate = total / max(elapsed, 0.001)
            logging.info(
                "offset=%d +%d saved, total=%d (%.0f rows/s, %.1fs elapsed)",
                offset, saved, total, rate, elapsed,
            )
            if len(rows) < fetch_size:
                break
            offset += len(rows)

    final = conn.execute("SELECT COUNT(*) FROM pluto").fetchone()[0]
    logging.info("done. pluto rows: %d (was %d, added %d)", final, existing, total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
