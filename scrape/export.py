"""
Phase 1d: Export a compact, frontend-ready artifact from the DB.

Produces two files:
  data/export/photos.json       - one entry per placed BBL (90k-ish), for map/bbox queries.
                                  Shape: a packed array for smallest JSON size.
  data/export/alternates.json   - BBLs with >1 photo: bbl -> [io_uuids...],
                                  so tapping shows additional angles without
                                  bloating the main dataset.
  data/export/stats.json        - coverage / size stats for the frontend banner.

Design:
  - One row per unique BBL (the "primary" photo). The primary is just the
    lowest io_uuid lexicographically - deterministic and arbitrary is fine
    since we can let the user cycle through alternates in the UI.
  - Packed columns, not nested objects: keeps the JSON tight.
  - Only placed photos (has lat/lon) - unplaced ones are no use to the app.

Usage:
    python export.py          # run against current DB state
"""

from __future__ import annotations

import argparse
import gzip
import json
import logging
import sqlite3
import sys
import time
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "nyc_photos.sqlite"
OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "export"


def round_coord(x: float | None) -> float | None:
    # 5 decimal places = ~1.1m precision. Plenty for AR on a phone.
    return None if x is None else round(x, 5)


def export(db: Path, out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=60.0)

    t0 = time.time()

    # Primary photo per BBL: lowest io_uuid among placed matches.
    primary_sql = """
        WITH placed AS (
            SELECT p.io_uuid, p.bbl, g.latitude, g.longitude, g.address,
                   g.match_type
            FROM photos p
            JOIN geo_match g ON g.io_uuid = p.io_uuid
            WHERE g.latitude IS NOT NULL
        ),
        ranked AS (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY bbl ORDER BY io_uuid) AS rn
            FROM placed
        )
        SELECT io_uuid, bbl, latitude, longitude, address, match_type
        FROM ranked
        WHERE rn = 1
        ORDER BY bbl
    """
    rows = conn.execute(primary_sql).fetchall()
    logging.info("primary rows: %d (%.2fs)", len(rows), time.time() - t0)

    # Packed columnar form - much smaller JSON than array-of-objects.
    # match_type: 0 = exact lot, 1 = block fallback
    mt_code = {"lot": 0, "block_nearest_lot": 1}
    photos = {
        "version": 1,
        "generated_at": int(time.time()),
        "count": len(rows),
        "columns": ["io", "bbl", "lat", "lon", "addr", "mt"],
        "data": [
            [
                r[0][3:],           # strip "IO_" prefix to save 3 bytes x 90k
                r[1],
                round_coord(r[2]),
                round_coord(r[3]),
                r[4],
                mt_code.get(r[5], 1),
            ]
            for r in rows
        ],
    }

    photos_path = out / "photos.json"
    photos_path.write_text(json.dumps(photos, separators=(",", ":")))
    gz = photos_path.with_suffix(".json.gz")
    with gzip.open(gz, "wb", compresslevel=9) as f:
        f.write(photos_path.read_bytes())
    logging.info("photos.json: %d bytes (%d gz)",
                 photos_path.stat().st_size, gz.stat().st_size)

    # Alternates: for BBLs with >1 photo, list the extra io_uuids.
    alt_sql = """
        SELECT bbl, GROUP_CONCAT(io_uuid, ',')
        FROM (
            SELECT p.bbl, p.io_uuid
            FROM photos p
            JOIN geo_match g ON g.io_uuid = p.io_uuid
            WHERE g.latitude IS NOT NULL
            ORDER BY p.bbl, p.io_uuid
        )
        GROUP BY bbl
        HAVING COUNT(*) > 1
    """
    alternates: dict[str, list[str]] = {}
    for bbl, ios in conn.execute(alt_sql):
        # skip the first (the primary we already have)
        ids = ios.split(",")[1:]
        alternates[str(bbl)] = [i[3:] for i in ids]
    alt_path = out / "alternates.json"
    alt_path.write_text(json.dumps(alternates, separators=(",", ":")))
    logging.info("alternates.json: %d bytes (%d BBLs with extras)",
                 alt_path.stat().st_size, len(alternates))

    # Stats.
    stats = {
        "generated_at": int(time.time()),
        "total_photos_scraped": conn.execute("SELECT COUNT(*) FROM photos").fetchone()[0],
        "unique_bbls": conn.execute("SELECT COUNT(DISTINCT bbl) FROM photos").fetchone()[0],
        "placed_bbls": len(rows),
        "match_breakdown": dict(conn.execute(
            "SELECT match_type, COUNT(*) FROM geo_match GROUP BY match_type"
        ).fetchall()),
        "scrape_pages_done": dict(conn.execute(
            "SELECT borough_code, COUNT(*) FROM scrape_progress GROUP BY borough_code"
        ).fetchall()),
    }
    (out / "stats.json").write_text(json.dumps(stats, indent=2))
    logging.info("stats: %s", json.dumps(stats))
    return stats


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--verbose", "-v", action="store_true")
    args = p.parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    export(DB_PATH, OUT_DIR)
    return 0


if __name__ == "__main__":
    sys.exit(main())
