"""
Naval base + military base ingestion from two free sources:

1. OSM Overpass API  (ODbL license)
   Query: nodes/ways tagged military=naval_base or military=airfield worldwide

2. Wikidata SPARQL   (CC0)
   Query: instances of Q695793 (military base) / Q12516 (naval base) with coordinates
   Used as supplement for bases not in OSM.

Returns list of dicts:
  {id, name, lat, lon, country, type: "CARRIER"|"AIRBASE", source: "osm"|"wikidata"}
"""

from __future__ import annotations
import logging
import time

import requests

logger = logging.getLogger("ingest_bases")

# ---------------------------------------------------------------------------
# OSM Overpass
# ---------------------------------------------------------------------------

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Query: nodes with military tags, worldwide.
# We use nodes only (not ways/relations) for simplicity — most major bases have a node centroid.
OVERPASS_QUERY = """
[out:json][timeout:90];
(
  node["military"="naval_base"];
  node["military"="airfield"];
  node["military"="air_base"];
  node["military"="base"];
  node["military"="barracks"]["name"~"Air",i];
);
out body;
"""


def _osm_type(tags: dict) -> str:
    mil = tags.get("military", "")
    if mil == "naval_base":
        return "CARRIER"   # naval base → carrier/destroyer home port
    return "AIRBASE"


def fetch_osm_bases(max_retries: int = 3) -> list[dict]:
    """Download OSM military base nodes via Overpass API."""
    logger.info("Querying OSM Overpass for military bases …")

    for attempt in range(max_retries):
        try:
            resp = requests.post(
                OVERPASS_URL,
                data={"data": OVERPASS_QUERY},
                timeout=120,
            )
            resp.raise_for_status()
            data = resp.json()
            break
        except Exception as exc:
            logger.warning("Overpass attempt %d failed: %s", attempt + 1, exc)
            if attempt < max_retries - 1:
                time.sleep(5 * (attempt + 1))
            else:
                logger.error("Overpass permanently failed — skipping OSM layer")
                return []

    results: list[dict] = []
    for element in data.get("elements", []):
        lat = element.get("lat")
        lon = element.get("lon")
        if lat is None or lon is None:
            continue
        tags = element.get("tags", {})
        name = tags.get("name") or tags.get("name:en") or ""
        if not name:
            continue
        osm_id = element.get("id", "")
        country = tags.get("addr:country") or tags.get("is_in:country_code") or ""
        results.append({
            "id": f"osm_{osm_id}",
            "name": name,
            "lat": float(lat),
            "lon": float(lon),
            "country": country,
            "type": _osm_type(tags),
            "source": "osm",
        })

    logger.info("OSM Overpass: %d entries", len(results))
    return results


# ---------------------------------------------------------------------------
# Wikidata SPARQL
# ---------------------------------------------------------------------------

WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql"

# Fetch military bases (Q695793) and naval bases (Q12516) with coordinates + country
WIKIDATA_QUERY = """
SELECT ?item ?itemLabel ?lat ?lon ?countryCode WHERE {
  {
    { ?item wdt:P31 wd:Q62447   . } UNION   # military air base
    { ?item wdt:P31 wd:Q216083  . } UNION   # air force base
    { ?item wdt:P31 wd:Q1312    . }         # naval air station
  }
  ?item wdt:P625 ?coord .
  BIND(geof:latitude(?coord)  AS ?lat)
  BIND(geof:longitude(?coord) AS ?lon)
  OPTIONAL { ?item wdt:P17 ?country .
             ?country wdt:P297 ?countryCode . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
}
LIMIT 3000
"""

# Name must contain at least one military keyword to be included.
_WIKIDATA_MILITARY_KEYWORDS = (
    "air base", "air force", "airbase", "air station", "afb", "raf ",
    "naval air", "marine corps air", "military airport", "base aér",
    "luftwaffe", "авиабаз", "авиабазы",
)


def fetch_wikidata_bases() -> list[dict]:
    """Run SPARQL query against Wikidata for military/naval bases."""
    logger.info("Querying Wikidata SPARQL for military bases …")
    try:
        resp = requests.get(
            WIKIDATA_SPARQL_URL,
            params={"query": WIKIDATA_QUERY, "format": "json"},
            headers={"User-Agent": "ghost-link-ingest/1.0 (research tool)"},
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        logger.warning("Wikidata SPARQL failed: %s — skipping Wikidata layer", exc)
        return []

    results: list[dict] = []
    for binding in data.get("results", {}).get("bindings", []):
        try:
            lat = float(binding["lat"]["value"])
            lon = float(binding["lon"]["value"])
        except (KeyError, ValueError):
            continue

        name = binding.get("itemLabel", {}).get("value", "")
        if not name or name.startswith("Q"):   # unnamed / only QID
            continue

        # Reject entries that don't look like military air bases
        lname = name.lower()
        if not any(kw in lname for kw in _WIKIDATA_MILITARY_KEYWORDS):
            continue

        qid = binding["item"]["value"].rsplit("/", 1)[-1]
        country = binding.get("countryCode", {}).get("value", "")

        # Determine type from label heuristic
        etype = "CARRIER" if any(w in lname for w in ("naval", "navy", "fleet", "port")) else "AIRBASE"

        results.append({
            "id": f"wikidata_{qid}",
            "name": name,
            "lat": lat,
            "lon": lon,
            "country": country,
            "type": etype,
            "source": "wikidata",
        })

    logger.info("Wikidata: %d entries", len(results))
    return results
