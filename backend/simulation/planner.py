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
    """Load seeded airbases. Falls back to empty list if not yet seeded."""
    path = Path(__file__).parent.parent / "data" / "world_bases.json"
    if not path.exists():
        logger.warning("world_bases.json not found — airbase list empty")
        return []
    with open(path) as f:
        data = json.load(f)
    return data if isinstance(data, list) else data.get("airbases", [])


# ---------------------------------------------------------------------------
# Greedy carrier placement
# DSA: Greedy O(n log n) — maximise target coverage with fewest carriers
# ---------------------------------------------------------------------------

CARRIER_RANGE_KM = 500.0   # carrier air-wing strike range


def _greedy_carrier_placement(
    targets: list[TargetSpec],
    sea_accessible_regions: list[dict],
    n_carriers: int = 2,
) -> list[dict]:
    """
    Place up to n_carriers carriers so they cover the maximum number of targets.

    Algorithm:
      1. Generate candidate positions (sea regions provided or synthesised near targets).
      2. For each candidate, count targets within CARRIER_RANGE_KM (greedy coverage).
      3. Pick the candidate covering the most un-covered targets.
      4. Mark those targets as covered. Repeat.

    DSA: Greedy Set Cover approximation — O(C × T) per iteration,
         optimal ratio guarantee: (1 - 1/e) ≈ 63% of optimal coverage.
    """
    if not targets:
        return []

    # Generate candidates near targets if no sea regions given
    candidates = list(sea_accessible_regions) if sea_accessible_regions else []
    if not candidates:
        # Offset targets ~400 km south as rough sea position
        for t in targets:
            candidates.append({"lat": t.lat - 3.5, "lon": t.lon, "label": f"Sea near {t.label}"})

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
Given the current world state (targets, nearby airbases, weapon ranges, threat zones) and the
operator's intent, produce a structured mission plan in **strict JSON** with these keys:
{
  "suggested_airbases": [{"id": str, "name": str, "lat": float, "lon": float}],
  "carrier_positions":  [{"lat": float, "lon": float, "label": str}],
  "tanker_waypoints":   [{"lat": float, "lon": float, "label": str}],
  "weapon_types":       [str],          // weapon IDs from the catalog
  "rationale": str                      // brief plain-English reasoning
}
Output ONLY the JSON object — no markdown fences, no commentary."""


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

    # Sort airbases by distance to centroid
    sorted_ab = sorted(
        airbases,
        key=lambda ab: haversine_km(ab["lat"], ab["lon"], avg_lat, avg_lon),
    )
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

    # ---- Step 1: Ollama natural language layer --------------------------------
    context = {
        "targets": [{"id": t.target_id, "lat": t.lat, "lon": t.lon} for t in target_specs],
        "nearby_airbases": [
            {"id": ab["id"], "name": ab.get("name", ""), "lat": ab["lat"], "lon": ab["lon"]}
            for ab in all_airbases[:30]  # limit context window
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
        selected_airbases = (
            [ab for ab in all_airbases if ab["id"] in llm_ab_ids]
            or [ab for ab in all_airbases if ab["id"] in llm_ab_ids]
        )
        # If LLM gave specific airbases not in our list, include them directly
        if not selected_airbases:
            selected_airbases = ollama_result.get("suggested_airbases", [])

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
    # Build WeaponSpecs using selected airbases
    airbases_for_assignment = (
        selected_airbases if isinstance(selected_airbases[0], dict) and "lat" in selected_airbases[0]
        else all_airbases
    ) if selected_airbases else all_airbases

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
            "feasible": r.feasible,
            "distance_km": round(r.distance_km, 1),
            "flight_time_s": round(r.flight_time_s, 0),
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
