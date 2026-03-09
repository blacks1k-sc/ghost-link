"""
AI Mission Planner — Hybrid: Ollama (local LLM) + Algorithmic Layer
DSA: Greedy Algorithm (carrier placement), Hungarian (via assignment.py), Dijkstra (via routing.py)

Flow:
  1. Ollama receives world context + user query → returns JSON with suggested
     asset placements and rationale (natural language reasoning layer).
  2. Algorithmic layer validates & optimises:
     - Hungarian: assign weapons to targets (min total flight time)
     - Dijkstra: route each weapon (airbase → optional tanker → target)
     - Greedy: suggest carrier positions maximising target coverage
  3. Both layers merged → final PlanSuggestion returned to frontend.

If Ollama is unavailable (not running), falls back to purely algorithmic path.
"""

from __future__ import annotations
import asyncio
import json
import logging
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import aiohttp

from core.kdtree import haversine_km
from simulation.assignment import (
    TargetSpec, WeaponSpec, AssignmentResult,
    assign_weapons_to_targets, build_weapon_specs,
)
from simulation.routing import Waypoint, plan_routes


logger = logging.getLogger("planner")

OLLAMA_URL = "http://localhost:11434"
OLLAMA_MODEL = "llama3.1:8b"
OLLAMA_TIMEOUT_S = 30.0

# ---------------------------------------------------------------------------
# Data file helpers
# ---------------------------------------------------------------------------

def _load_weapons_catalog() -> dict:
    path = Path(__file__).parent.parent / "data" / "weapons.json"
    with open(path) as f:
        return json.load(f)


def _load_world_bases() -> list[dict]:
    """Load seeded airbases + military supplement.  Falls back to empty list if not yet seeded."""
    path = Path(__file__).parent.parent / "data" / "world_bases.json"
    if not path.exists():
        logger.warning("world_bases.json not found — airbase list empty")
        return []
    with open(path) as f:
        data = json.load(f)
    bases: list[dict] = data if isinstance(data, list) else data.get("airbases", [])

    # ── Clean world_bases.json of known bad data ────────────────────────────
    # 1. Drop all Wikidata entries — the existing world_bases.json has ~2,324
    #    Wikidata entries that are rivers/rapids/waterfalls due to wrong QIDs
    #    in the original SPARQL query.  Re-running seed.py with the fixed
    #    ingest_bases.py will regenerate this correctly.
    # 2. Drop OurAirports large-airport catch-all entries (civilian airports).
    #    The original ingest_airports.py included all large_airports in key
    #    countries; the fixed script only takes ones with military name keywords.
    _CIVILIAN_KEYWORDS = (
        "international airport", "domestic airport", "regional airport",
        "municipal airport", "civil airport", "commercial airport",
    )
    def _is_military_enough(ab: dict) -> bool:
        if ab.get("source") == "wikidata":
            return False   # all existing wikidata entries are junk — drop
        name_l = ab.get("name", "").lower()
        if ab.get("source") == "ourairports" and any(kw in name_l for kw in _CIVILIAN_KEYWORDS):
            return False   # clearly civilian airport that slipped through
        return True

    bases = [ab for ab in bases if _is_military_enough(ab)]
    logger.info("world_bases after cleaning: %d entries", len(bases))

    # ── Merge verified military bases supplement (highest priority) ──────────
    supp_path = Path(__file__).parent.parent / "data" / "military_bases_supplement.json"
    if supp_path.exists():
        with open(supp_path) as f:
            supplement = json.load(f)
        existing_ids = {ab["id"] for ab in supplement}
        bases = list(supplement) + [ab for ab in bases if ab["id"] not in existing_ids]
        logger.info("Loaded %d military supplement bases; total pool: %d", len(supplement), len(bases))

    # ── Fix OSM entries with empty country field ─────────────────────────────
    no_cc = [ab for ab in bases if not ab.get("country")]
    if no_cc:
        known = [ab for ab in bases if ab.get("country")]
        for ab in no_cc:
            nearest = min(known, key=lambda k: (k["lat"]-ab["lat"])**2 + (k["lon"]-ab["lon"])**2)
            ab["country"] = nearest["country"]

    return bases


# ---------------------------------------------------------------------------
# Greedy carrier placement
# DSA: Greedy O(n log n) — maximise target coverage with fewest carriers
# ---------------------------------------------------------------------------

CARRIER_RANGE_KM = 500.0   # carrier air-wing strike range

# Minimum distance an airbase must be from any target to be considered friendly territory.
# Country-code filtering is the primary guard; this is a belt-and-suspenders fallback.
FRIENDLY_STANDOFF_KM = 300.0

# Radius used to detect which country/countries the targets are in.
# Any airbase within this radius of any target contributes its country code to "enemy countries".
# 150 km keeps us well within the target country without catching friendly border bases.
ENEMY_DETECT_RADIUS_KM = 150.0

# Known ocean anchor points used for carrier placement heuristics.
# Algorithmic fallback picks the closest ocean body to the target centroid.
_OCEAN_ANCHORS: list[dict] = [
    {"lat": 20.0, "lon":  63.0, "label": "Arabian Sea"},
    {"lat": 15.0, "lon":  87.0, "label": "Bay of Bengal"},
    {"lat":  5.0, "lon":  73.0, "label": "Indian Ocean"},
    {"lat": 26.0, "lon":  55.0, "label": "Persian Gulf"},
    {"lat": 20.0, "lon":  38.0, "label": "Red Sea"},
    {"lat": 12.0, "lon":  45.0, "label": "Gulf of Aden"},
    {"lat": 35.0, "lon":  20.0, "label": "Mediterranean Sea"},
    {"lat": 43.0, "lon":  35.0, "label": "Black Sea"},
    {"lat": 55.0, "lon":   5.0, "label": "North Sea"},
    {"lat": 45.0, "lon": -30.0, "label": "North Atlantic"},
    {"lat": 35.0, "lon": -10.0, "label": "East Atlantic"},
    {"lat": 15.0, "lon": 115.0, "label": "South China Sea"},
    {"lat": 30.0, "lon": 125.0, "label": "East China Sea"},
    {"lat": 40.0, "lon": 145.0, "label": "Northwest Pacific"},
    {"lat":-20.0, "lon":  55.0, "label": "South Indian Ocean"},
]


def _nearest_ocean_anchor(lat: float, lon: float) -> dict:
    """Return the ocean anchor closest to the given coordinates."""
    return min(
        _OCEAN_ANCHORS,
        key=lambda a: haversine_km(a["lat"], a["lon"], lat, lon),
    )


def _greedy_carrier_placement(
    targets: list[TargetSpec],
    sea_accessible_regions: list[dict],
    n_carriers: int = 2,
) -> list[dict]:
    """
    Place up to n_carriers carriers so they cover the maximum number of targets.

    Candidate positions are either:
    - Explicitly supplied sea regions (from Ollama), or
    - The nearest ocean anchors to the target centroid (algorithmic fallback).

    DSA: Greedy Set Cover approximation — O(C × T) per iteration,
         optimal ratio guarantee: (1 - 1/e) ≈ 63% of optimal coverage.
    """
    if not targets:
        return []

    candidates = list(sea_accessible_regions) if sea_accessible_regions else []

    if not candidates:
        # Use nearest ocean anchors instead of blind lat offset
        avg_lat = sum(t.lat for t in targets) / len(targets)
        avg_lon = sum(t.lon for t in targets) / len(targets)

        # Sort all ocean anchors by distance to centroid; take the 4 closest as candidates
        sorted_anchors = sorted(
            _OCEAN_ANCHORS,
            key=lambda a: haversine_km(a["lat"], a["lon"], avg_lat, avg_lon),
        )
        candidates = [
            {"lat": a["lat"], "lon": a["lon"], "label": a["label"]}
            for a in sorted_anchors[:4]
        ]

    uncovered = set(range(len(targets)))
    placements: list[dict] = []

    for _ in range(n_carriers):
        if not uncovered:
            break
        best_candidate = None
        best_coverage: set[int] = set()

        for cand in candidates:
            covered_here = {
                i for i in uncovered
                if haversine_km(cand["lat"], cand["lon"], targets[i].lat, targets[i].lon)
                   <= CARRIER_RANGE_KM
            }
            if len(covered_here) > len(best_coverage):
                best_coverage = covered_here
                best_candidate = cand

        if best_candidate is None:
            # No candidate covers any remaining target — just place at closest ocean
            avg_lat = sum(targets[i].lat for i in uncovered) / len(uncovered)
            avg_lon = sum(targets[i].lon for i in uncovered) / len(uncovered)
            anchor = _nearest_ocean_anchor(avg_lat, avg_lon)
            placements.append({"lat": anchor["lat"], "lon": anchor["lon"], "label": anchor["label"]})
            break

        placements.append({
            "lat": best_candidate["lat"],
            "lon": best_candidate["lon"],
            "label": best_candidate.get("label", f"CVN-{len(placements)+1}"),
        })
        uncovered -= best_coverage

    return placements


# ---------------------------------------------------------------------------
# Ollama integration
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """You are a mission planning assistant for a multi-domain strike simulation.
The TARGETS are ENEMY installations to be destroyed by an attacking force.

STRICT RULES — violating any rule produces an invalid plan:
1. suggested_airbases are FRIENDLY LAUNCH BASES — they must be in territory that is geographically
   AWAY from the enemy targets (minimum 400 km from every target). Never pick an airbase that is
   inside, adjacent to, or in the same country as the target area. Choose bases in allied or
   neutral nations that have weapons with sufficient range to reach the targets.
2. carrier_positions must be in OPEN OCEAN or SEA — never on land. Use these reference ocean
   coordinates as anchors and interpolate: Arabian Sea (~20°N 63°E), Bay of Bengal (~15°N 87°E),
   Persian Gulf (~26°N 55°E), Red Sea (~20°N 38°E), Mediterranean (~35°N 20°E),
   South China Sea (~15°N 115°E), East China Sea (~30°N 125°E), North Atlantic (~45°N -30°E),
   Indian Ocean (~5°N 73°E). Pick the ocean body that is closest to the targets but NOT between
   the attacking force and the targets in a way that would require overflying enemy territory.
3. weapon_types must be IDs from the provided catalog — only choose weapons whose range_km is
   sufficient to reach the targets from the selected airbases or carriers.
4. Approach direction: weapons fly FROM airbases/carriers TOWARD targets. Plan the approach to
   minimise threat exposure and avoid known SAM zones.

Output ONLY a strict JSON object with these keys — no markdown, no commentary:
{
  "suggested_airbases": [{"id": str, "name": str, "lat": float, "lon": float}],
  "carrier_positions":  [{"lat": float, "lon": float, "label": str}],
  "tanker_waypoints":   [{"lat": float, "lon": float, "label": str}],
  "weapon_types":       [str],
  "rationale": str
}"""


async def _call_ollama(user_query: str, context_json: str) -> dict | None:
    """
    POST to Ollama's /api/generate endpoint.
    Returns parsed dict or None on failure (network error, timeout, bad JSON).
    """
    payload = {
        "model": OLLAMA_MODEL,
        "prompt": f"{_SYSTEM_PROMPT}\n\nWORLD CONTEXT:\n{context_json}\n\nOPERATOR INTENT: {user_query}",
        "stream": False,
        "format": "json",
    }
    try:
        timeout = aiohttp.ClientTimeout(total=OLLAMA_TIMEOUT_S)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(f"{OLLAMA_URL}/api/generate", json=payload) as resp:
                if resp.status != 200:
                    logger.warning("Ollama returned HTTP %d", resp.status)
                    return None
                body = await resp.json(content_type=None)
                raw = body.get("response", "")
                return json.loads(raw)
    except asyncio.TimeoutError:
        logger.warning("Ollama timed out after %ss", OLLAMA_TIMEOUT_S)
        return None
    except Exception as exc:
        logger.warning("Ollama unavailable: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Country-based hostile territory detection
# ---------------------------------------------------------------------------

def _infer_enemy_countries(targets: list[TargetSpec], airbases: list[dict]) -> set[str]:
    """
    Infer which ISO country codes are 'enemy territory' by finding every country
    that has at least one airbase within ENEMY_DETECT_RADIUS_KM of any target.

    This avoids hard-coded country lists — if a target is placed in Pakistan,
    all Pakistani airbases are automatically excluded from friendly suggestions.
    """
    enemy: set[str] = set()
    for t in targets:
        for ab in airbases:
            cc = ab.get("country", "")
            if cc and cc not in enemy:
                if haversine_km(ab["lat"], ab["lon"], t.lat, t.lon) <= ENEMY_DETECT_RADIUS_KM:
                    enemy.add(cc)
    return enemy


def _filter_friendly(
    airbases: list[dict],
    targets: list[TargetSpec],
    enemy_countries: set[str],
) -> list[dict]:
    """Return only airbases that are (a) not in an enemy country AND
    (b) at least FRIENDLY_STANDOFF_KM from every target."""
    return [
        ab for ab in airbases
        if ab.get("country", "") not in enemy_countries
        and all(
            haversine_km(ab["lat"], ab["lon"], t.lat, t.lon) >= FRIENDLY_STANDOFF_KM
            for t in targets
        )
    ]


# ---------------------------------------------------------------------------
# Algorithmic fallback — no Ollama needed
# ---------------------------------------------------------------------------

def _algorithmic_plan(
    targets: list[TargetSpec],
    airbases: list[dict],
    threat_zones: list[dict],
    weapon_catalog: dict,
) -> dict:
    """
    Pure-algorithmic plan when Ollama is unavailable.
    - Pick up to 3 closest airbases to the centroid of all targets.
    - Choose weapon types that cover the most targets from those airbases.
    - Run greedy carrier placement.
    """
    if not targets or not airbases:
        return {
            "suggested_airbases": [],
            "carrier_positions": [],
            "tanker_waypoints": [],
            "weapon_types": [],
        }

    avg_lat = sum(t.lat for t in targets) / len(targets)
    avg_lon = sum(t.lon for t in targets) / len(targets)

    # Detect enemy countries from targets, then filter out all airbases in those countries
    # AND any base that is too close to the targets (belt-and-suspenders).
    enemy_countries = _infer_enemy_countries(targets, airbases)
    logger.info("Inferred enemy countries: %s", enemy_countries)
    friendly_bases = _filter_friendly(airbases, targets, enemy_countries)

    # Among friendly bases, prefer those still within weapon range of at least one target.
    # Sort by distance to centroid so we pick the closest feasible launch point.
    max_weapon_range = max(
        (w["range_km"] for w in weapon_catalog.get("weapons", [])),
        default=2000.0,
    )
    in_range = [
        ab for ab in friendly_bases
        if any(
            haversine_km(ab["lat"], ab["lon"], t.lat, t.lon) <= max_weapon_range
            for t in targets
        )
    ]

    # Fall back to all friendly bases if none are in range (edge case)
    pool = in_range if in_range else friendly_bases if friendly_bases else airbases

    # Sort: supplement (verified military) bases come first within same distance band,
    # then by distance to centroid.  This ensures real air force stations are preferred
    # over civilian airports when both are equidistant.
    def sort_key(ab: dict):
        dist = haversine_km(ab["lat"], ab["lon"], avg_lat, avg_lon)
        is_military = 0 if ab.get("source") == "supplement" else 1
        return (is_military, dist)

    sorted_ab = sorted(pool, key=sort_key)
    suggested = sorted_ab[:3]

    # Pick long-range weapons that can reach targets from suggested airbases
    weapon_types = []
    for weapon in weapon_catalog.get("weapons", []):
        for ab in suggested:
            for t in targets:
                if haversine_km(ab["lat"], ab["lon"], t.lat, t.lon) <= weapon["range_km"]:
                    weapon_types.append(weapon["id"])
                    break
            else:
                continue
            break
    # Deduplicate, take up to 4 weapon types
    seen: set[str] = set()
    unique_weapons: list[str] = []
    for w in weapon_types:
        if w not in seen:
            seen.add(w)
            unique_weapons.append(w)
        if len(unique_weapons) >= 4:
            break

    carriers = _greedy_carrier_placement(targets, [])

    return {
        "suggested_airbases": [
            {"id": ab["id"], "name": ab.get("name", ab["id"]), "lat": ab["lat"], "lon": ab["lon"]}
            for ab in suggested
        ],
        "carrier_positions": carriers,
        "tanker_waypoints": [],
        "weapon_types": unique_weapons,
    }


# ---------------------------------------------------------------------------
# Main planner entrypoint
# ---------------------------------------------------------------------------

@dataclass
class PlanSuggestion:
    suggested_airbases: list[dict]      # [{id, name, lat, lon}]
    carrier_positions: list[dict]       # [{lat, lon, label}]
    tanker_waypoints: list[dict]        # [{lat, lon, label}]
    assignments: list[dict]             # [{weapon_type, target_id, airbase_id}]
    routes: list[dict]                  # [{weapon_type, target_id, waypoints[{lat,lon}], dist_km, time_s}]
    rationale: str
    used_ollama: bool


async def generate_plan(
    query: str,
    targets: list[dict],               # [{id, lat, lon, label}]
    existing_airbases: list[dict],     # from entity graph (overrides world_bases if provided)
    threat_zones: list[dict],          # [{lat, lon, radius_km}]
) -> PlanSuggestion:
    """
    Hybrid AI + algorithmic mission planner.

    1. Prepare context JSON for Ollama.
    2. Call Ollama (non-blocking); fall back to algorithmic if unavailable.
    3. Merge LLM suggestions with algorithmic layer (Hungarian + Dijkstra).
    4. Return PlanSuggestion with all data the frontend needs to overlay on the map.
    """
    weapon_catalog = _load_weapons_catalog()
    world_bases = _load_world_bases()

    # Merge: prefer explicitly placed airbases from entity graph, fall back to world_bases
    all_airbases = existing_airbases if existing_airbases else world_bases

    target_specs = [
        TargetSpec(target_id=t["id"], lat=t["lat"], lon=t["lon"], label=t.get("label", ""))
        for t in targets
    ]

    if not target_specs:
        return PlanSuggestion(
            suggested_airbases=[], carrier_positions=[], tanker_waypoints=[],
            assignments=[], routes=[], rationale="No targets specified.", used_ollama=False,
        )

    # Pre-compute enemy countries — used to filter both the Ollama context and results.
    enemy_countries = _infer_enemy_countries(target_specs, all_airbases)
    logger.info("Enemy countries detected: %s", enemy_countries)

    # Only show friendly bases in the Ollama context so the LLM can't pick enemy bases.
    friendly_for_context = _filter_friendly(all_airbases, target_specs, enemy_countries)

    # ---- Step 1: Ollama natural language layer --------------------------------
    context = {
        "targets": [{"id": t.target_id, "lat": t.lat, "lon": t.lon} for t in target_specs],
        "nearby_airbases": [
            {"id": ab["id"], "name": ab.get("name", ""), "lat": ab["lat"], "lon": ab["lon"]}
            for ab in friendly_for_context[:30]  # limit context window; only friendly
        ],
        "threat_zones": [
            {"lat": tz["lat"], "lon": tz["lon"], "radius_km": tz.get("radius_km", 100)}
            for tz in threat_zones[:10]
        ],
        "available_weapons": [
            {"id": w["id"], "range_km": w["range_km"], "domain": w["domain"]}
            for w in weapon_catalog.get("weapons", [])
        ],
    }
    context_json = json.dumps(context, indent=2)
    ollama_result = await _call_ollama(query, context_json)
    used_ollama = ollama_result is not None

    # ---- Step 2: Derive plan parameters from Ollama or algorithmic fallback ---
    if used_ollama:
        llm_ab_ids = {ab["id"] for ab in ollama_result.get("suggested_airbases", [])}
        selected_airbases = [ab for ab in all_airbases if ab["id"] in llm_ab_ids]
        # If LLM gave specific airbases not in our list, include them directly
        if not selected_airbases:
            selected_airbases = ollama_result.get("suggested_airbases", [])

        # Strip any Ollama-suggested bases that landed in enemy territory
        selected_airbases = _filter_friendly(selected_airbases, target_specs, enemy_countries)
        if not selected_airbases:
            # Ollama hallucinated enemy bases — fall back to algorithmic selection
            fallback = _algorithmic_plan(target_specs, all_airbases, threat_zones, weapon_catalog)
            selected_airbases = fallback["suggested_airbases"]

        carrier_positions = ollama_result.get("carrier_positions", [])
        tanker_waypoints = ollama_result.get("tanker_waypoints", [])
        weapon_type_ids = ollama_result.get("weapon_types", [])
        rationale = ollama_result.get("rationale", "Plan generated by Ollama.")

        # Greedy carrier placement to fill gaps
        if not carrier_positions:
            carrier_positions = _greedy_carrier_placement(target_specs, [])
    else:
        fallback = _algorithmic_plan(target_specs, all_airbases, threat_zones, weapon_catalog)
        selected_airbases = fallback["suggested_airbases"]
        carrier_positions = fallback["carrier_positions"]
        tanker_waypoints = fallback["tanker_waypoints"]
        weapon_type_ids = fallback["weapon_types"]
        rationale = (
            "Ollama unavailable — algorithmic plan: nearest airbases selected, "
            "weapons chosen by range coverage, carriers placed by greedy coverage."
        )

    # ---- Step 3: Hungarian weapon-to-target assignment -----------------------
    # Build combined launch-platform pool: selected airbases + carriers (tagged as naval)
    # Carriers are tagged with is_carrier=True so find_best_airbase enforces domain rules:
    # SEA-domain weapons (Tomahawk) will only select from carrier entries.
    carrier_entries = [
        {
            "id": f"carrier_{i}",
            "name": cp.get("label", f"CVN-{i + 1}"),
            "lat": cp["lat"],
            "lon": cp["lon"],
            "is_carrier": True,
            "source": "carrier",
        }
        for i, cp in enumerate(carrier_positions)
    ]

    base_pool = (
        selected_airbases
        if selected_airbases and isinstance(selected_airbases[0], dict) and "lat" in selected_airbases[0]
        else all_airbases
    )
    airbases_for_assignment = list(base_pool) + carrier_entries

    weapon_specs = build_weapon_specs(weapon_type_ids, target_specs, airbases_for_assignment, weapon_catalog)

    # Ensure we have at least as many weapon instances as targets
    while weapon_specs and len(weapon_specs) < len(target_specs):
        weapon_specs.extend(weapon_specs[:len(target_specs) - len(weapon_specs)])

    assignment_results: list[AssignmentResult] = []
    if weapon_specs and target_specs:
        assignment_results = assign_weapons_to_targets(
            weapon_specs, target_specs, threat_zones
        )

    assignments_out = [
        {
            "weapon_type": r.weapon_type,
            "target_id": r.target_id,
            "airbase_id": r.airbase_id,
            "feasible": bool(r.feasible),
            "distance_km": float(round(r.distance_km, 1)),
            "flight_time_s": float(round(r.flight_time_s, 0)),
        }
        for r in assignment_results
    ]

    # ---- Step 4: Dijkstra routes for each assignment -------------------------
    tanker_wps_for_routing = tanker_waypoints  # list of {lat, lon, label}
    target_dicts = [{"id": t.target_id, "lat": t.lat, "lon": t.lon} for t in target_specs]
    airbase_dicts = airbases_for_assignment if airbases_for_assignment else all_airbases

    route_results = plan_routes(
        assignments=[{"weapon_type": a["weapon_type"], "airbase_id": a["airbase_id"], "target_id": a["target_id"]}
                     for a in assignments_out if a.get("feasible", True)],
        airbases=airbase_dicts,
        targets=target_dicts,
        tanker_waypoints=tanker_wps_for_routing,
        threat_zones=threat_zones,
        weapon_catalog=weapon_catalog,
    )

    routes_out = []
    for wr in route_results:
        if wr.route.feasible:
            routes_out.append({
                "weapon_type": wr.weapon_type,
                "target_id": wr.target_id,
                "airbase_id": wr.airbase_id,
                "waypoints": [{"lat": wp.lat, "lon": wp.lon, "label": wp.label}
                               for wp in wr.route.waypoints],
                "total_dist_km": round(wr.route.total_dist_km, 1),
                "total_time_s": round(wr.route.total_time_s, 0),
                "uses_tanker": wr.route.uses_tanker,
                "threat_crossings": wr.route.threat_crossings,
            })

    # Normalise suggested_airbases format
    if selected_airbases and isinstance(selected_airbases[0], dict) and "id" not in selected_airbases[0]:
        selected_airbases = [
            {"id": ab.get("id", f"ab_{i}"), "name": ab.get("name", ""), "lat": ab["lat"], "lon": ab["lon"]}
            for i, ab in enumerate(selected_airbases)
        ]

    return PlanSuggestion(
        suggested_airbases=selected_airbases,
        carrier_positions=carrier_positions,
        tanker_waypoints=tanker_waypoints,
        assignments=assignments_out,
        routes=routes_out,
        rationale=rationale,
        used_ollama=used_ollama,
    )
