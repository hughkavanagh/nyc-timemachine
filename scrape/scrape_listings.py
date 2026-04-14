"""
Phase 1 scraper: walks every listing page of the 1940s Tax Department photos
at nycrecords.access.preservica.com, extracts (IO_uuid, borough, block, lot)
for each item, and writes them to a SQLite database.

Usage:
    python scrape_listings.py --borough manhattan            # just Manhattan
    python scrape_listings.py --borough all                  # all 4 boroughs
    python scrape_listings.py --borough manhattan --pages 1-5  # test slice
    python scrape_listings.py --borough manhattan --resume   # pick up where we stopped

Resumable: on restart, skips pages already fully ingested.
Polite: bounded concurrency, per-request delay, retries with backoff.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import random
import re
import sqlite3
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from curl_cffi import requests as cffi_requests
from curl_cffi.requests.errors import RequestsError

# ---------- Config ---------------------------------------------------------

BOROUGHS: dict[str, dict] = {
    # code matches the NYC BBL borough convention
    "manhattan": {"code": 1, "so": "SO_e6e79554-4227-414f-afc2-5f008fb9c96b", "est_pages": 3531},
    "bronx":     {"code": 2, "so": "SO_ad9565b5-e87e-4b78-96d1-ebb2035d0d9a", "est_pages": 2924},
    "brooklyn":  {"code": 3, "so": "SO_6619dce3-4174-450e-bcbb-ae5ef78060de", "est_pages": 11365},
    "queens":    {"code": 4, "so": "SO_c7d09c9c-66cb-4d9d-9f80-01a5401e58c9", "est_pages": 9131},
}

BASE = "https://nycrecords.access.preservica.com"
# curl_cffi handles User-Agent + TLS fingerprint via impersonate='chrome'.
IMPERSONATE = "chrome"

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "nyc_photos.sqlite"

# ---------- HTML parsing ---------------------------------------------------

RE_IO = re.compile(r"IO_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
RE_ID = re.compile(r"nynyma_rec0040_(\d+)_(\d+)_(\d+)")
# Links to items on listing pages
RE_ITEM_HREF = re.compile(
    r'href="https://nycrecords\.access\.preservica\.com/uncategorized/'
    r"(IO_[0-9a-f-]{36})/?"
)
RE_LAST_PAGE = re.compile(r"\?pg=(\d+)")


@dataclass(frozen=True)
class Row:
    io_uuid: str   # e.g. IO_07ea78aa-...
    borough: int   # 1..5
    block: int
    lot: int

    @property
    def bbl(self) -> int:
        # Standard NYC BBL: 1 digit borough + 5 digits block + 4 digits lot.
        return self.borough * 1_000_000_000 + self.block * 10_000 + self.lot


def parse_listing(html: str, expected_borough: int) -> list[Row]:
    """Extract (io_uuid, borough, block, lot) tuples from a listing page.

    Strategy: for each IO_uuid occurrence, scan the following ~3KB for the
    nearest nynyma_rec0040_B_BLOCK_LOT identifier. Dedupe so each io_uuid
    appears only once (they appear multiple times per page — thumbnail alt,
    link href, aria-label, etc.).
    """
    rows: dict[str, Row] = {}
    for m in RE_IO.finditer(html):
        io = m.group(0)
        if io in rows:
            continue
        window = html[m.start():m.start() + 3000]
        idm = RE_ID.search(window)
        if not idm:
            continue
        borough = int(idm.group(1))
        if borough != expected_borough:
            # Cross-borough noise (e.g. 'related items' sidebar) — skip.
            continue
        rows[io] = Row(
            io_uuid=io,
            borough=borough,
            block=int(idm.group(2)),
            lot=int(idm.group(3)),
        )
    return list(rows.values())


def parse_last_page(html: str) -> int | None:
    """Find the highest `?pg=N` in pagination links to know when to stop."""
    matches = [int(m.group(1)) for m in RE_LAST_PAGE.finditer(html)]
    return max(matches) if matches else None


# ---------- Storage --------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS photos (
    io_uuid    TEXT PRIMARY KEY,
    borough    INTEGER NOT NULL,
    block      INTEGER NOT NULL,
    lot        INTEGER NOT NULL,
    bbl        INTEGER NOT NULL,
    scraped_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_bbl     ON photos(bbl);
CREATE INDEX IF NOT EXISTS idx_photos_borough ON photos(borough);

CREATE TABLE IF NOT EXISTS scrape_progress (
    borough_code INTEGER NOT NULL,
    page         INTEGER NOT NULL,
    items        INTEGER NOT NULL,
    finished_at  REAL NOT NULL,
    PRIMARY KEY (borough_code, page)
);
"""


def open_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def pages_already_done(conn: sqlite3.Connection, borough_code: int) -> set[int]:
    cur = conn.execute(
        "SELECT page FROM scrape_progress WHERE borough_code = ?", (borough_code,)
    )
    return {r[0] for r in cur.fetchall()}


def save_page(
    conn: sqlite3.Connection, borough_code: int, page: int, rows: list[Row]
) -> None:
    now = time.time()
    with conn:
        conn.executemany(
            "INSERT OR REPLACE INTO photos "
            "(io_uuid, borough, block, lot, bbl, scraped_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            [(r.io_uuid, r.borough, r.block, r.lot, r.bbl, now) for r in rows],
        )
        conn.execute(
            "INSERT OR REPLACE INTO scrape_progress "
            "(borough_code, page, items, finished_at) VALUES (?, ?, ?, ?)",
            (borough_code, page, len(rows), now),
        )


# ---------- HTTP -----------------------------------------------------------

async def fetch_listing(
    client: cffi_requests.AsyncSession,
    so_uuid: str,
    page: int,
    *,
    attempts: int = 5,
) -> str:
    url = f"{BASE}/uncategorized/{so_uuid}/"
    params = {"pg": page} if page > 1 else None
    delay = 1.0
    for attempt in range(1, attempts + 1):
        try:
            r = await client.get(url, params=params, timeout=30.0)
            if r.status_code == 200:
                return r.text
            if r.status_code in (403, 429, 502, 503, 504):
                logging.warning(
                    "page=%d attempt=%d got %d, backing off %.1fs",
                    page, attempt, r.status_code, delay,
                )
            else:
                r.raise_for_status()
        except RequestsError as e:
            logging.warning(
                "page=%d attempt=%d transport error %s, backing off %.1fs",
                page, attempt, e, delay,
            )
        await asyncio.sleep(delay + random.uniform(0, 0.5))
        delay = min(delay * 2, 30.0)
    raise RuntimeError(f"failed to fetch page {page} after {attempts} attempts")


# ---------- Orchestration --------------------------------------------------

async def scrape_borough(
    name: str,
    pages_to_fetch: list[int],
    *,
    concurrency: int,
    per_request_delay: float,
) -> None:
    info = BOROUGHS[name]
    borough_code = info["code"]
    so = info["so"]

    conn = open_db(DB_PATH)
    done = pages_already_done(conn, borough_code)
    todo = [p for p in pages_to_fetch if p not in done]
    logging.info(
        "%s: %d pages requested, %d already done, %d to fetch",
        name, len(pages_to_fetch), len(pages_to_fetch) - len(todo), len(todo),
    )
    if not todo:
        return

    sem = asyncio.Semaphore(concurrency)
    completed = 0
    total = len(todo)
    t0 = time.time()

    async with cffi_requests.AsyncSession(impersonate=IMPERSONATE) as client:

        async def one(page: int) -> None:
            nonlocal completed
            async with sem:
                await asyncio.sleep(per_request_delay * random.uniform(0.5, 1.5))
                html = await fetch_listing(client, so, page)
                rows = parse_listing(html, borough_code)
                save_page(conn, borough_code, page, rows)
                completed += 1
                if completed % 25 == 0 or completed == total:
                    elapsed = time.time() - t0
                    rate = completed / max(elapsed, 0.001)
                    eta = (total - completed) / max(rate, 0.001)
                    logging.info(
                        "%s: %d/%d pages  (%.1f pg/s, ETA %.0fs, last page had %d items)",
                        name, completed, total, rate, eta, len(rows),
                    )

        await asyncio.gather(*(one(p) for p in todo))

    conn.close()


# ---------- CLI ------------------------------------------------------------

def parse_page_range(s: str, max_page: int) -> list[int]:
    s = s.strip().lower()
    if s in ("all", ""):
        return list(range(1, max_page + 1))
    if "-" in s:
        a, b = s.split("-", 1)
        return list(range(int(a), int(b) + 1))
    return [int(s)]


async def main_async(args: argparse.Namespace) -> int:
    targets = list(BOROUGHS) if args.borough == "all" else [args.borough]
    for name in targets:
        max_page = BOROUGHS[name]["est_pages"]
        pages = parse_page_range(args.pages, max_page)
        logging.info("=== %s: pages %d..%d ===", name, pages[0], pages[-1])
        await scrape_borough(
            name, pages,
            concurrency=args.concurrency,
            per_request_delay=args.delay,
        )
    # Quick summary.
    conn = open_db(DB_PATH)
    total = conn.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
    by_b = conn.execute(
        "SELECT borough, COUNT(*) FROM photos GROUP BY borough ORDER BY borough"
    ).fetchall()
    logging.info("DB totals: %d photos, by borough: %s", total, by_b)
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--borough", choices=[*BOROUGHS, "all"], default="manhattan",
        help="which borough(s) to scrape",
    )
    p.add_argument(
        "--pages", default="all",
        help='page range: "all", "1-5", or "42"',
    )
    p.add_argument(
        "--concurrency", type=int, default=5,
        help="max concurrent requests (default 5, be polite)",
    )
    p.add_argument(
        "--delay", type=float, default=0.3,
        help="per-request base delay in seconds (jittered 0.5x..1.5x)",
    )
    p.add_argument(
        "--verbose", "-v", action="store_true",
    )
    args = p.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    try:
        return asyncio.run(main_async(args))
    except KeyboardInterrupt:
        logging.info("interrupted — resume with --borough %s", args.borough)
        return 130


if __name__ == "__main__":
    sys.exit(main())
