"""
OurAirports ingestion — military airbases worldwide.
Source: https://davidmegginson.github.io/ourairports-data/airports.csv
License: CC0 (public domain)

Filters:
  - type == 'military'           (dedicated military airfields)
  - type == 'large_airport' with known military ICAO prefixes / country combos
    (dual-use large airports near NATO/allied hubs)
  - Must have valid lat/lon and ICAO code

Returns list of dicts:
  {id, name, lat, lon, country, icao, type: "AIRBASE", source: "ourairports"}
"""

from __future__ import annotations
import csv
import io
import logging
import requests

logger = logging.getLogger("ingest_airports")

AIRPORTS_CSV_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"

# Countries to include large_airport records for (NATO + key allies + adversaries for full coverage)
LARGE_AIRPORT_COUNTRIES = {
    "US", "GB", "FR", "DE", "IT", "ES", "TR", "PL", "NO", "NL", "BE", "DK",
    "CA", "AU", "JP", "KR", "IL", "SA", "AE", "IN", "SG", "TH", "PH",
    "RU", "CN", "IR", "KP",
}

# Keywords that identify a medium_airport as a military installation
MILITARY_NAME_KEYWORDS = (
    "air base", "air force base", "afb", "raf ", "marine corps air",
    "naval air", "joint base", "army airfield", "military airport",
    "luftwaffenstützpunkt", "base aérienne",
)


def fetch_ourairports() -> list[dict]:
    """
    Download and parse OurAirports CSV.
    Returns filtered list of airbase dicts.
    """
    logger.info("Downloading OurAirports CSV from %s …", AIRPORTS_CSV_URL)
    resp = requests.get(AIRPORTS_CSV_URL, timeout=60)
    resp.raise_for_status()

    reader = csv.DictReader(io.StringIO(resp.text))
    results: list[dict] = []

    for row in reader:
        try:
            lat = float(row["latitude_deg"])
            lon = float(row["longitude_deg"])
        except (ValueError, KeyError):
            continue

        icao = row.get("ident", "").strip()
        name = row.get("name", "").strip()
        atype = row.get("type", "").strip()
        country = row.get("iso_country", "").strip()

        if not icao or not name:
            continue

        lname = name.lower()

        # Always include dedicated military airports
        if atype == "military":
            results.append({
                "id": f"ourairports_{icao}",
                "name": name,
                "lat": lat,
                "lon": lon,
                "country": country,
                "icao": icao,
                "type": "AIRBASE",
                "source": "ourairports",
            })
            continue

        # Include medium airports whose name clearly signals a military base
        # (e.g. Ramstein Air Base = medium_airport in OurAirports)
        if atype == "medium_airport" and any(kw in lname for kw in MILITARY_NAME_KEYWORDS):
            results.append({
                "id": f"ourairports_{icao}",
                "name": name,
                "lat": lat,
                "lon": lon,
                "country": country,
                "icao": icao,
                "type": "AIRBASE",
                "source": "ourairports",
            })
            continue

        # Large airports: only include if the name clearly identifies a military installation.
        # (Removed the blanket country-based catch-all that pulled in civilian airports.)
        if atype == "large_airport" and any(kw in lname for kw in MILITARY_NAME_KEYWORDS):
            results.append({
                "id": f"ourairports_{icao}",
                "name": name,
                "lat": lat,
                "lon": lon,
                "country": country,
                "icao": icao,
                "type": "AIRBASE",
                "source": "ourairports",
            })

    logger.info("OurAirports: %d entries after filter", len(results))
    return results
