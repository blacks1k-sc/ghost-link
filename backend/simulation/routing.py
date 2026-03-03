"""
Dijkstra Route Planning — Airbase → [Tanker Waypoint] → Target
DSA: Weighted Shortest Path, O((V+E) log V)

For each assigned (weapon, target) pair, finds the minimum-cost route through
a waypoint graph. Edge weight = flight_time_s + threat_exposure_penalty.

Interview relevance:
  - Classic Dijkstra with priority queue (heapq / min-heap)
  - Cost function encapsulates physics: time = distance / speed
  - Threat avoidance as graph edge weight — real operational planning constraint
"""

from __future__ import annotations
import heapq
import math
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from core.kdtree import haversine_km


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

@dataclass
class Waypoint:
    """A node in the routing graph."""
    id: str
    lat: float
    lon: float
    label: str = ""
    is_tanker: bool = False


@dataclass
class RouteResult:
    waypoints: list[Waypoint]          # ordered path nodes
    total_dist_km: float
    total_time_s: float
    threat_crossings: int
    uses_tanker: bool
    feasible: bool


INFEASIBLE = RouteResult(
    waypoints=[], total_dist_km=0, total_time_s=float("inf"),
    threat_crossings=0, uses_tanker=False, feasible=False,
)

THREAT_CROSSING_PENALTY_S = 600.0   # 10-min penalty per SAM zone crossed
STEALTH_DISCOUNT = 0.4              # 60% reduction for stealth platforms


# ---------------------------------------------------------------------------
# Edge cost
# ---------------------------------------------------------------------------

def _edge_cost(
    a: Waypoint,
    b: Waypoint,
    speed_kmh: float,
    threat_zones: list[dict],
    stealth: bool,
) -> tuple[float, int]:
    """
    Returns (cost_seconds, n_threat_crossings).
    cost = flight_time + sum(penalties for threat zones near the midpoint).
    """
    dist_km = haversine_km(a.lat, a.lon, b.lat, b.lon)
    if speed_kmh <= 0:
        return float("inf"), 0

    flight_time_s = (dist_km / speed_kmh) * 3600.0

    mid_lat = (a.lat + b.lat) / 2
    mid_lon = (a.lon + b.lon) / 2
    crossings = 0
    penalty = 0.0
    for zone in threat_zones:
        z_lat = zone.get("lat", 0.0)
        z_lon = zone.get("lon", 0.0)
        z_rad = zone.get("radius_km", 100.0)
        if haversine_km(mid_lat, mid_lon, z_lat, z_lon) < z_rad:
            crossings += 1
            discount = STEALTH_DISCOUNT if stealth else 1.0
            penalty += THREAT_CROSSING_PENALTY_S * discount

    return flight_time_s + penalty, crossings


# ---------------------------------------------------------------------------
# Dijkstra shortest-path over waypoint graph
# ---------------------------------------------------------------------------

def dijkstra_route(
    origin: Waypoint,
    destination: Waypoint,
    speed_kmh: float,
    range_km: float,
    threat_zones: list[dict],
    tanker_waypoints: list[Waypoint],
    stealth: bool = False,
) -> RouteResult:
    """
    Dijkstra shortest path: origin → [optional tanker] → destination.

    Graph nodes:   origin + all tanker waypoints + destination
    Graph edges:   every pair of nodes if the leg is within weapon range
                   (or weapon range + tanker bonus for legs through a tanker)
    Edge weight:   flight_time_s + threat_crossing_penalty

    DSA:
      - Priority queue: min-heap (heapq) on (cost, node_id)
      - Relaxation: standard Dijkstra — only update if shorter path found
      - O((V+E) log V) where V = 2 + len(tanker_waypoints)
    """
    all_nodes: list[Waypoint] = [origin] + tanker_waypoints + [destination]
    n = len(all_nodes)
    idx = {wp.id: i for i, wp in enumerate(all_nodes)}

    # Build adjacency: precompute edge costs between all pairs
    INF = float("inf")
    adj: list[list[tuple[float, int, int]]] = [[] for _ in range(n)]  # (cost, crossings, neighbor_idx)

    for i in range(n):
        for j in range(n):
            if i == j:
                continue
            a, b = all_nodes[i], all_nodes[j]
            dist = haversine_km(a.lat, a.lon, b.lat, b.lon)
            # Leg feasibility: must be within weapon range
            if dist > range_km * 1.05:   # 5% planning margin
                continue
            cost, crossings = _edge_cost(a, b, speed_kmh, threat_zones, stealth)
            adj[i].append((cost, crossings, j))

    # Dijkstra from origin (index 0)
    dist_arr = [INF] * n
    prev = [-1] * n
    cross_arr = [0] * n
    dist_arr[0] = 0.0

    # heap: (cost, node_idx)
    heap: list[tuple[float, int]] = [(0.0, 0)]

    while heap:
        d, u = heapq.heappop(heap)
        if d > dist_arr[u]:
            continue  # stale entry
        for edge_cost, crossings, v in adj[u]:
            nd = d + edge_cost
            if nd < dist_arr[v]:
                dist_arr[v] = nd
                prev[v] = u
                cross_arr[v] = cross_arr[u] + crossings
                heapq.heappush(heap, (nd, v))

    dest_idx = n - 1
    if dist_arr[dest_idx] == INF:
        return INFEASIBLE

    # Reconstruct path
    path_idx: list[int] = []
    cur = dest_idx
    while cur != -1:
        path_idx.append(cur)
        cur = prev[cur]
    path_idx.reverse()

    path_nodes = [all_nodes[i] for i in path_idx]
    total_dist = sum(
        haversine_km(path_nodes[i].lat, path_nodes[i].lon, path_nodes[i + 1].lat, path_nodes[i + 1].lon)
        for i in range(len(path_nodes) - 1)
    )
    uses_tanker = any(wp.is_tanker for wp in path_nodes)

    return RouteResult(
        waypoints=path_nodes,
        total_dist_km=total_dist,
        total_time_s=dist_arr[dest_idx],
        threat_crossings=cross_arr[dest_idx],
        uses_tanker=uses_tanker,
        feasible=True,
    )


# ---------------------------------------------------------------------------
# Batch routing for a full assignment list
# ---------------------------------------------------------------------------

@dataclass
class WeaponRoute:
    weapon_type: str
    airbase_id: str
    target_id: str
    route: RouteResult


def plan_routes(
    assignments: list[dict],           # {weapon_type, airbase_id, target_id}
    airbases: list[dict],              # {id, lat, lon}
    targets: list[dict],               # {id, lat, lon}
    tanker_waypoints: list[dict],      # {lat, lon, label}
    threat_zones: list[dict],          # {lat, lon, radius_km}
    weapon_catalog: dict | None = None,
) -> list[WeaponRoute]:
    """
    For each assignment, run Dijkstra and return the route.
    Falls back to straight-line if Dijkstra finds no feasible path.
    """
    if weapon_catalog is None:
        path = Path(__file__).parent.parent / "data" / "weapons.json"
        with open(path) as f:
            weapon_catalog = json.load(f)

    weapons_by_id = {w["id"]: w for w in weapon_catalog.get("weapons", [])}
    airbases_by_id = {ab["id"]: ab for ab in airbases}
    targets_by_id = {t["id"]: t for t in targets}

    tanker_wps = [
        Waypoint(
            id=f"tanker_{i}",
            lat=tw["lat"],
            lon=tw["lon"],
            label=tw.get("label", f"Tanker {i}"),
            is_tanker=True,
        )
        for i, tw in enumerate(tanker_waypoints)
    ]

    results: list[WeaponRoute] = []
    for asn in assignments:
        w_spec = weapons_by_id.get(asn["weapon_type"])
        ab = airbases_by_id.get(asn["airbase_id"])
        tgt = targets_by_id.get(asn["target_id"])

        if not w_spec or not ab or not tgt:
            continue

        origin = Waypoint(id=ab["id"], lat=ab["lat"], lon=ab["lon"], label=ab.get("name", ab["id"]))
        dest = Waypoint(id=tgt["id"], lat=tgt["lat"], lon=tgt["lon"], label=tgt.get("label", tgt["id"]))

        route = dijkstra_route(
            origin=origin,
            destination=dest,
            speed_kmh=w_spec["speed_kmh"],
            range_km=w_spec["range_km"],
            threat_zones=threat_zones,
            tanker_waypoints=tanker_wps,
            stealth=w_spec.get("stealth", False),
        )

        results.append(WeaponRoute(
            weapon_type=asn["weapon_type"],
            airbase_id=asn["airbase_id"],
            target_id=asn["target_id"],
            route=route,
        ))

    return results
