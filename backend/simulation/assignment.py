"""
Weapon-to-Target Assignment — Hungarian Algorithm
DSA: Bipartite Graph Matching, O(n³)

Given N weapons and M targets, find the minimum-cost assignment such that
every target gets at least one weapon. Handles N > M by allowing multiple
weapons per target (load-balanced).

Interview relevance:
  - Bipartite matching: two disjoint sets (weapons, targets) with weighted edges
  - Hungarian algorithm: finds global optimum — no greedy local swap can improve it
  - Cost matrix: classic 2D DP setup seen in many interview problems
"""

from __future__ import annotations
import math
import json
from pathlib import Path
from dataclasses import dataclass

import numpy as np
from scipy.optimize import linear_sum_assignment  # Jonker-Volgenant, O(n³)

from core.kdtree import haversine_km


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class WeaponSpec:
    """Lightweight weapon descriptor used by the planner."""
    weapon_type: str       # matches weapons.json id (e.g. "jassm_er")
    range_km: float
    speed_kmh: float
    domain: str            # AIR | SEA | LAND
    stealth: bool
    airbase_id: str        # which airbase/carrier this weapon launches from
    airbase_lat: float
    airbase_lon: float


@dataclass
class TargetSpec:
    target_id: str
    lat: float
    lon: float
    label: str = ""


@dataclass
class AssignmentResult:
    weapon_idx: int
    weapon_type: str
    airbase_id: str
    target_id: str
    flight_time_s: float
    distance_km: float
    feasible: bool         # False if weapon can't reach target even with tanker


# ---------------------------------------------------------------------------
# Cost computation
# ---------------------------------------------------------------------------

INFEASIBLE_COST = 1e9   # sentinel: weapon cannot reach target

def _flight_time_s(dist_km: float, speed_kmh: float) -> float:
    """Convert distance + speed to flight time in seconds."""
    if speed_kmh <= 0:
        return INFEASIBLE_COST
    return (dist_km / speed_kmh) * 3600.0


def _compute_cost(
    weapon: WeaponSpec,
    target: TargetSpec,
    threat_zones: list[dict],
    tanker_range_bonus_km: float = 0.0,
) -> float:
    """
    Cost = flight_time_s + threat_exposure_penalty

    threat_exposure_penalty: each SAM zone the straight-line path crosses
    adds 600s (10 min) penalty — favours routes that avoid dense defenses.

    tanker_range_bonus_km: added to weapon range when a tanker is available
    on this route (tanker placed at midpoint by planner.py).

    Returns INFEASIBLE_COST if weapon cannot reach target.
    """
    dist_km = haversine_km(weapon.airbase_lat, weapon.airbase_lon, target.lat, target.lon)
    effective_range = weapon.range_km + tanker_range_bonus_km

    if dist_km > effective_range:
        return INFEASIBLE_COST

    base_cost = _flight_time_s(dist_km, weapon.speed_kmh)

    # Threat exposure: count how many SAM zones the great-circle path intersects
    # Simplified: check if the midpoint of the path is inside any threat zone
    mid_lat = (weapon.airbase_lat + target.lat) / 2
    mid_lon = (weapon.airbase_lon + target.lon) / 2
    threat_penalty = 0.0
    for zone in threat_zones:
        z_lat = zone.get("lat", 0.0)
        z_lon = zone.get("lon", 0.0)
        z_rad = zone.get("radius_km", 100.0)
        if haversine_km(mid_lat, mid_lon, z_lat, z_lon) < z_rad:
            stealth_discount = 0.4 if weapon.stealth else 1.0
            threat_penalty += 600.0 * stealth_discount

    return base_cost + threat_penalty


# ---------------------------------------------------------------------------
# Hungarian Assignment
# ---------------------------------------------------------------------------

def assign_weapons_to_targets(
    weapons: list[WeaponSpec],
    targets: list[TargetSpec],
    threat_zones: list[dict],
    tanker_range_bonus_km: float = 0.0,
) -> list[AssignmentResult]:
    """
    Hungarian algorithm for minimum-cost weapon-to-target assignment.

    Algorithm overview:
      1. Build cost matrix C[i][j] = cost of weapon i attacking target j
      2. Run linear_sum_assignment (scipy wraps Jonker-Volgenant, O(n³))
      3. If N weapons > M targets, duplicate target columns to allow
         multiple weapons per target (each target gets ceil(N/M) weapons)
      4. Return list of (weapon, target, cost) assignments

    The cost matrix is the bridge between the combinatorial assignment
    problem and the real-world physics — a classic interview pattern.
    """
    n_w = len(weapons)
    n_t = len(targets)
    if n_w == 0 or n_t == 0:
        return []

    # ---------------------------------------------------------------------------
    # Handle unequal sizes
    # If more weapons than targets: expand targets by duplicating columns
    # so each target can receive multiple weapons.
    # ---------------------------------------------------------------------------
    weapons_per_target = math.ceil(n_w / n_t)
    expanded_targets: list[TargetSpec] = []
    for _ in range(weapons_per_target):
        expanded_targets.extend(targets)
    n_cols = len(expanded_targets)

    # ---------------------------------------------------------------------------
    # Build cost matrix   C[weapon_idx][expanded_target_idx]
    # ---------------------------------------------------------------------------
    C = np.full((n_w, n_cols), fill_value=INFEASIBLE_COST, dtype=np.float64)
    for i, weapon in enumerate(weapons):
        for j, target in enumerate(expanded_targets):
            C[i, j] = _compute_cost(weapon, target, threat_zones, tanker_range_bonus_km)

    # ---------------------------------------------------------------------------
    # Hungarian assignment — finds row_ind, col_ind that minimise sum(C[row,col])
    # Time: O(n³) via Jonker-Volgenant (faster than classic O(n³) Hungarian in practice)
    # ---------------------------------------------------------------------------
    row_ind, col_ind = linear_sum_assignment(C)

    results: list[AssignmentResult] = []
    for wi, ci in zip(row_ind, col_ind):
        cost = C[wi, ci]
        target = expanded_targets[ci]
        weapon = weapons[wi]
        dist_km = haversine_km(weapon.airbase_lat, weapon.airbase_lon, target.lat, target.lon)
        results.append(AssignmentResult(
            weapon_idx=wi,
            weapon_type=weapon.weapon_type,
            airbase_id=weapon.airbase_id,
            target_id=target.target_id,
            flight_time_s=_flight_time_s(dist_km, weapon.speed_kmh),
            distance_km=dist_km,
            feasible=bool(cost < INFEASIBLE_COST),
        ))

    return results


# ---------------------------------------------------------------------------
# Airbase selection for each weapon type
# ---------------------------------------------------------------------------

# Air-domain weapons that can also launch from naval carriers
_CARRIER_COMPATIBLE_AIR_WEAPONS: frozenset[str] = frozenset({"lrasm", "harpoon"})


def _load_weapons_catalog() -> dict:
    path = Path(__file__).parent.parent / "data" / "weapons.json"
    with open(path) as f:
        return json.load(f)


def find_best_airbase(
    weapon_type_id: str,
    target: TargetSpec,
    candidate_airbases: list[dict],
    weapon_catalog: dict | None = None,
) -> dict | None:
    """
    For a given weapon type and target, return the closest feasible launch platform.

    Platform compatibility rules:
    - SEA domain weapons (Tomahawk, SCALP Naval, etc.): carriers only
    - AIR domain weapons: airbases only, except carrier-compatible ones (LRASM, Harpoon)
    - LAND domain weapons: any platform (treated as ground-launched, no airbase filter)

    DSA used: linear scan O(n) — for planning this is called infrequently.
    """
    if weapon_catalog is None:
        weapon_catalog = _load_weapons_catalog()

    spec = next(
        (w for w in weapon_catalog.get("weapons", []) if w["id"] == weapon_type_id),
        None,
    )
    if spec is None:
        return None

    domain = spec.get("domain", "AIR")
    max_range = spec["range_km"] * 1.1  # 10% planning margin

    best: dict | None = None
    best_dist = float("inf")
    for ab in candidate_airbases:
        ab_is_carrier = ab.get("is_carrier", False)

        if domain == "SEA":
            # Sea-launched weapons: naval platforms only
            if not ab_is_carrier:
                continue
        elif domain == "AIR":
            # Air-launched weapons: airbases only, unless also carrier-compatible
            if ab_is_carrier and weapon_type_id not in _CARRIER_COMPATIBLE_AIR_WEAPONS:
                continue

        dist = haversine_km(ab["lat"], ab["lon"], target.lat, target.lon)
        if dist <= max_range and dist < best_dist:
            best = ab
            best_dist = dist

    return best


def build_weapon_specs(
    weapon_type_ids: list[str],
    targets: list[TargetSpec],
    airbases: list[dict],
    weapon_catalog: dict | None = None,
) -> list[WeaponSpec]:
    """
    For each requested weapon type, build a WeaponSpec with the best
    airbase for its (average) target set.

    Returns only feasible weapon specs (those that can reach at least
    one target from some airbase).
    """
    if weapon_catalog is None:
        weapon_catalog = _load_weapons_catalog()

    # Average target position — used to find best airbase
    avg_lat = sum(t.lat for t in targets) / max(len(targets), 1)
    avg_lon = sum(t.lon for t in targets) / max(len(targets), 1)
    avg_target = TargetSpec(target_id="_avg", lat=avg_lat, lon=avg_lon)

    specs: list[WeaponSpec] = []
    for wt_id in weapon_type_ids:
        raw = next((w for w in weapon_catalog.get("weapons", []) if w["id"] == wt_id), None)
        if raw is None:
            continue
        ab = find_best_airbase(wt_id, avg_target, airbases, weapon_catalog)
        if ab is None:
            continue  # no airbase in range — skip this weapon type
        specs.append(WeaponSpec(
            weapon_type=wt_id,
            range_km=raw["range_km"],
            speed_kmh=raw["speed_kmh"],
            domain=raw["domain"],
            stealth=raw.get("stealth", False),
            airbase_id=ab["id"],
            airbase_lat=ab["lat"],
            airbase_lon=ab["lon"],
        ))

    return specs
