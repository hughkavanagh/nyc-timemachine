"""
Phase 1c: Geocode scraped photos to lat/lon using PLUTO, with a block-level
fallback for BBLs that no longer exist (old lots merged into larger modern
parcels over the last 80+ years).

Strategy:
  1. Exact match: photos.bbl  = pluto.bbl               -> 'lot'
  2. Fallback:    photos.(borough, block) = pluto.(borough, block),
                  pick the pluto row with the closest lot number
                                                        -> 'block_nearest_lot'
  3. No match:    block doesn't exist in modern PLUTO   -> 'none'

Why nearest-lot (not block centroid): NYC lot consolidations typically assign
the merged parcel the *lower* of the original lot numbers, and lot numbers run
roughly in order along the block frontage. So the PLUTO row with the closest
lot number is usually the parcel that physically contains the old 1940 lot.
Also, NYC blocks are small (often < 200 ft), so any surviving lot on the same
block is well within GPS error anyway.

Safe to run while the scraper is still going — it writes to its own table
(`geo_match`) and reads `photos` and `pluto` read-only. Re-run any time as new
photos are scraped; results are idempotent.

Usage:
    python geocode.py            # compute + show coverage report
    python geocode.py --quiet    # just compute
"""

from __future__ import annotations

import argparse
import logging
import sqlite3
import sys
import time
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "nyc_photos.sqlite"

SCHEMA = """
CREATE TABLE IF NOT EXISTS geo_match (
    io_uuid              TEXT PRIMARY KEY,
    match_type           TEXT NOT NULL,  -- 'lot' | 'block_nearest_lot' | 'none'
    latitude             REAL,
    longitude            REAL,
    matched_bbl          INTEGER,        -- PLUTO row used (NULL for 'none')
    match_distance_lots  INTEGER,        -- |photo.lot - pluto.lot| (0 for exact)
    address              TEXT,
    computed_at          REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_geo_match_type ON geo_match(match_type);
"""


def open_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=60.0)
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def compute(conn: sqlite3.Connection) -> None:
    t0 = time.time()
    now = time.time()

    # Step 1: wipe and rebuild (idempotent, and small enough to just do cleanly).
    with conn:
        conn.execute("DELETE FROM geo_match")

        # Exact BBL matches.
        conn.execute(
            """
            INSERT INTO geo_match
              (io_uuid, match_type, latitude, longitude,
               matched_bbl, match_distance_lots, address, computed_at)
            SELECT p.io_uuid, 'lot', l.latitude, l.longitude,
                   l.bbl, 0, l.address, ?
            FROM photos p
            JOIN pluto  l ON l.bbl = p.bbl
            WHERE l.latitude IS NOT NULL AND l.longitude IS NOT NULL
            """,
            (now,),
        )
        exact = conn.total_changes
        logging.info("exact lot matches: %d (%.1fs)", exact, time.time() - t0)

        # Block fallback: for every remaining photo, pick the PLUTO row on the
        # same (borough, block) with the smallest |lot - photo.lot|. Ties
        # broken by lower bbl so it's deterministic.
        conn.execute(
            """
            INSERT INTO geo_match
              (io_uuid, match_type, latitude, longitude,
               matched_bbl, match_distance_lots, address, computed_at)
            SELECT io_uuid, 'block_nearest_lot', latitude, longitude,
                   matched_bbl, dist, address, ?
            FROM (
                SELECT p.io_uuid,
                       l.latitude, l.longitude, l.bbl AS matched_bbl,
                       ABS(l.lot - p.lot) AS dist, l.address,
                       ROW_NUMBER() OVER (
                           PARTITION BY p.io_uuid
                           ORDER BY ABS(l.lot - p.lot), l.bbl
                       ) AS rn
                FROM photos p
                LEFT JOIN geo_match g ON g.io_uuid = p.io_uuid
                JOIN pluto l
                  ON l.borough = p.borough
                 AND l.block   = p.block
                 AND l.latitude  IS NOT NULL
                 AND l.longitude IS NOT NULL
                WHERE g.io_uuid IS NULL
            )
            WHERE rn = 1
            """,
            (now,),
        )

        # Mark the rest (block doesn't exist in modern PLUTO) as 'none' so we
        # can report coverage.
        conn.execute(
            """
            INSERT INTO geo_match
              (io_uuid, match_type, latitude, longitude,
               matched_bbl, match_distance_lots, address, computed_at)
            SELECT p.io_uuid, 'none', NULL, NULL, NULL, NULL, NULL, ?
            FROM photos p
            LEFT JOIN geo_match g ON g.io_uuid = p.io_uuid
            WHERE g.io_uuid IS NULL
            """,
            (now,),
        )

    logging.info("geo_match built in %.1fs", time.time() - t0)


def report(conn: sqlite3.Connection) -> None:
    total = conn.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
    if total == 0:
        print("no photos yet")
        return

    print(f"\nTotal photos:        {total:>8,}")
    print("Match type breakdown:")
    for mt, cnt in conn.execute(
        "SELECT match_type, COUNT(*) FROM geo_match GROUP BY match_type ORDER BY COUNT(*) DESC"
    ):
        pct = 100 * cnt / total
        print(f"  {mt:<22s} {cnt:>8,}  ({pct:5.1f}%)")

    placed = conn.execute(
        "SELECT COUNT(*) FROM geo_match WHERE latitude IS NOT NULL"
    ).fetchone()[0]
    print(f"\nPlaced on map:       {placed:>8,}  ({100*placed/total:.1f}%)")

    # Distribution of fallback distance (how many lots off)
    print("\nBlock-fallback 'lot-number distance' distribution:")
    for lo, hi, label in [(1, 1, "1"), (2, 3, "2-3"), (4, 10, "4-10"),
                          (11, 50, "11-50"), (51, 9999, "51+")]:
        cnt = conn.execute(
            "SELECT COUNT(*) FROM geo_match "
            "WHERE match_type='block_nearest_lot' AND match_distance_lots BETWEEN ? AND ?",
            (lo, hi),
        ).fetchone()[0]
        print(f"  {label:>6s} lots away: {cnt:>7,}")

    print("\nPer-borough placement rate:")
    for b, name in [(1, "Manhattan"), (2, "Bronx"), (3, "Brooklyn"),
                    (4, "Queens"), (5, "Staten Island")]:
        tot = conn.execute("SELECT COUNT(*) FROM photos WHERE borough=?", (b,)).fetchone()[0]
        if tot == 0:
            continue
        pl = conn.execute(
            "SELECT COUNT(*) FROM geo_match g JOIN photos p USING(io_uuid) "
            "WHERE p.borough=? AND g.latitude IS NOT NULL",
            (b,),
        ).fetchone()[0]
        print(f"  {name:<14s} {pl:>7,} / {tot:>7,}  ({100*pl/tot:.1f}%)")

    # Spot-check: show a handful of block-fallback matches to eyeball
    print("\nSample block-fallback matches (sanity check):")
    rows = conn.execute(
        "SELECT p.borough, p.block, p.lot, g.matched_bbl, g.match_distance_lots, "
        "g.latitude, g.longitude, g.address "
        "FROM photos p JOIN geo_match g USING(io_uuid) "
        "WHERE g.match_type='block_nearest_lot' "
        "ORDER BY RANDOM() LIMIT 5"
    ).fetchall()
    for r in rows:
        b, blk, lot, mbbl, d, lat, lon, addr = r
        print(f"  b={b} blk={blk} lot={lot}  ->  bbl={mbbl} ({d} lots away)  "
              f"{lat:.4f},{lon:.4f}  {addr}")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--quiet", action="store_true")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    conn = open_db()
    compute(conn)
    if not args.quiet:
        report(conn)
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
