"""
seed.py — Build world_bases.json from all ingestion sources.

Pipeline:
  1. Fetch OurAirports CSV   → military + large airports worldwide
  2. Fetch OSM Overpass      → military=naval_base / airfield nodes
  3. Fetch Wikidata SPARQL   → military/naval base instances with coords
  4. Deduplicate via K-D Tree: skip any entry within 2 km of an already-added entry
  5. Write backend/data/world_bases.json

Output schema (list of objects):
  {
    "id":      str,        e.g. "ourairports_KDOV", "osm_12345", "wikidata_Q12345"
    "name":    str,
    "lat":     float,
    "lon":     float,
    "country": str,        ISO 3166-1 alpha-2 where available
    "type":    "AIRBASE" | "CARRIER",
    "source":  "ourairports" | "osm" | "wikidata"
  }

Run:
  cd backend
  python data/seed.py [--no-wikidata] [--no-osm] [--out data/world_bases.json]

DSA used: K-D Tree (nearest-neighbour deduplication, O(n log n) build + O(log n) query)
"""

from __future__ import annotations
import argparse
import json
import logging
import math
import sys
from pathlib import Path

# Allow running from repo root or backend/
sys.path.insert(0, str(Path(__file__).parent.parent))

from data.ingest_airports import fetch_ourairports
from data.ingest_bases import fetch_osm_bases, fetch_wikidata_bases

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
logger = logging.getLogger("seed")

DEFAULT_OUT = Path(__file__).parent / "world_bases.json"
DEDUP_RADIUS_KM = 2.0    # entries within this distance are considered duplicates


# ---------------------------------------------------------------------------
# Minimal K-D Tree for deduplication (no external deps)
# ---------------------------------------------------------------------------

class _Node:
    __slots__ = ("lat", "lon", "left", "right")
    def __init__(self, lat: float, lon: float):
        self.lat = lat
        self.lon = lon
        self.left: "_Node | None" = None
        self.right: "_Node | None" = None


class _DedupeKDTree:
    """
    Simple 2-D K-D Tree for incremental deduplication.

    insert(lat, lon) → True  if more than DEDUP_RADIUS_KM from all existing points
                     → False if a duplicate exists within radius

    Build: O(1) per insert (unbalanced).  Query: O(log n) average, O(n) worst.
    Good enough for ~50k entries; rebalancing not needed for single-pass seeding.
    """

    def __init__(self, radius_km: float):
        self._root: _Node | None = None
        self._r = radius_km

    def insert(self, lat: float, lon: float) -> bool:
        """Returns True (and inserts) if no duplicate within radius."""
        if self._root is None:
            self._root = _Node(lat, lon)
            return True
        if self._has_close(self._root, lat, lon, depth=0):
            return False
        self._insert_node(self._root, lat, lon, depth=0)
        return True

    # ---- internal helpers ----

    @staticmethod
    def _hav(lat1, lon1, lat2, lon2) -> float:
        R = 6371.0
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        dphi = math.radians(lat2 - lat1)
        dlam = math.radians(lon2 - lon1)
        a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
        return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    def _has_close(self, node: _Node, lat: float, lon: float, depth: int) -> bool:
        if self._hav(node.lat, node.lon, lat, lon) < self._r:
            return True

        axis = depth % 2
        diff = (lat - node.lat) if axis == 0 else (lon - node.lon)

        # Which side to explore first
        near, far = (node.left, node.right) if diff < 0 else (node.right, node.left)

        if near and self._has_close(near, lat, lon, depth + 1):
            return True

        # Prune far branch: distance to splitting plane (degrees → km approx)
        plane_dist_km = abs(diff) * 111.0
        if plane_dist_km < self._r and far:
            return self._has_close(far, lat, lon, depth + 1)

        return False

    def _insert_node(self, node: _Node, lat: float, lon: float, depth: int):
        axis = depth % 2
        diff = (lat - node.lat) if axis == 0 else (lon - node.lon)
        if diff < 0:
            if node.left is None:
                node.left = _Node(lat, lon)
            else:
                self._insert_node(node.left, lat, lon, depth + 1)
        else:
            if node.right is None:
                node.right = _Node(lat, lon)
            else:
                self._insert_node(node.right, lat, lon, depth + 1)


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def run(
    include_osm: bool = True,
    include_wikidata: bool = True,
    out_path: Path = DEFAULT_OUT,
) -> int:
    """Fetch, deduplicate, and write world_bases.json. Returns entry count."""

    all_entries: list[dict] = []

    # --- Source 1: OurAirports (most comprehensive, best IDs) ---
    try:
        ap = fetch_ourairports()
        all_entries.extend(ap)
        logger.info("OurAirports loaded: %d entries", len(ap))
    except Exception as exc:
        logger.error("OurAirports fetch failed: %s", exc)

    # --- Source 2: OSM Overpass ---
    if include_osm:
        try:
            osm = fetch_osm_bases()
            all_entries.extend(osm)
            logger.info("OSM Overpass loaded: %d entries", len(osm))
        except Exception as exc:
            logger.error("OSM fetch failed: %s", exc)

    # --- Source 3: Wikidata SPARQL ---
    if include_wikidata:
        try:
            wd = fetch_wikidata_bases()
            all_entries.extend(wd)
            logger.info("Wikidata loaded: %d entries", len(wd))
        except Exception as exc:
            logger.error("Wikidata fetch failed: %s", exc)

    if not all_entries:
        logger.error("No data fetched from any source. Aborting.")
        return 0

    logger.info("Total raw entries before dedup: %d", len(all_entries))

    # --- Deduplication via K-D Tree ---
    # Priority: ourairports first (better IDs/names), then osm, then wikidata
    def _source_priority(src: str) -> int:
        return {"ourairports": 0, "osm": 1, "wikidata": 2}.get(src, 3)

    all_entries.sort(key=lambda e: _source_priority(e["source"]))

    tree = _DedupeKDTree(radius_km=DEDUP_RADIUS_KM)
    deduplicated: list[dict] = []
    skipped = 0

    for entry in all_entries:
        lat, lon = entry["lat"], entry["lon"]
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            skipped += 1
            continue
        if tree.insert(lat, lon):
            deduplicated.append(entry)
        else:
            skipped += 1

    logger.info(
        "After dedup: %d unique entries (%d duplicates/invalid removed)",
        len(deduplicated),
        skipped,
    )

    # --- Write output ---
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(deduplicated, f, indent=2)

    logger.info("Written → %s  (%d bases)", out_path, len(deduplicated))

    # Summary breakdown
    by_type = {"AIRBASE": 0, "CARRIER": 0}
    by_source: dict[str, int] = {}
    for e in deduplicated:
        by_type[e.get("type", "AIRBASE")] = by_type.get(e.get("type", "AIRBASE"), 0) + 1
        src = e["source"]
        by_source[src] = by_source.get(src, 0) + 1

    logger.info("Breakdown by type:   %s", by_type)
    logger.info("Breakdown by source: %s", by_source)

    return len(deduplicated)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seed world_bases.json from open data sources")
    parser.add_argument("--no-osm",       action="store_true", help="Skip OSM Overpass layer")
    parser.add_argument("--no-wikidata",  action="store_true", help="Skip Wikidata SPARQL layer")
    parser.add_argument("--out",          default=str(DEFAULT_OUT), help="Output JSON path")
    args = parser.parse_args()

    n = run(
        include_osm=not args.no_osm,
        include_wikidata=not args.no_wikidata,
        out_path=Path(args.out),
    )
    sys.exit(0 if n > 0 else 1)
