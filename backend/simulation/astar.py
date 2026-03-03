from __future__ import annotations

import heapq
import math
from dataclasses import dataclass
from typing import NamedTuple


CELL_COST_INSIDE = 999
CELL_COST_BUFFER = 10
CELL_COST_FREE = 1
BUFFER_FACTOR = 1.15
BBOX_PADDING_DEG = 1.5
MAX_GRID_CELLS = 500

_NEIGHBORS_8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


@dataclass(frozen=True)
class ThreatRing:
    lat: float
    lon: float
    radius_km: float


class Vec3(NamedTuple):
    lat: float
    lon: float
    alt_km: float


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))


def _effective_resolution(lat_span: float, lon_span: float, base_res: float) -> float:
    return max(base_res, max(lat_span, lon_span) / MAX_GRID_CELLS)


def _build_threat_grid(
    lat_min: float,
    lon_min: float,
    rows: int,
    cols: int,
    resolution: float,
    threat_rings: list[ThreatRing],
) -> list[list[int]]:
    grid = [[CELL_COST_FREE] * cols for _ in range(rows)]
    for r in range(rows):
        cell_lat = lat_min + r * resolution
        for c in range(cols):
            cell_lon = lon_min + c * resolution
            for ring in threat_rings:
                d = _haversine_km(cell_lat, cell_lon, ring.lat, ring.lon)
                if d <= ring.radius_km:
                    grid[r][c] = CELL_COST_INSIDE
                    break
                if d <= ring.radius_km * BUFFER_FACTOR:
                    grid[r][c] = max(grid[r][c], CELL_COST_BUFFER)
    return grid


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def astar_replan(
    current: Vec3,
    target: Vec3,
    threat_rings: list[ThreatRing],
    grid_resolution: float = 0.1,
) -> list[Vec3]:
    lat_min = min(current.lat, target.lat) - BBOX_PADDING_DEG
    lat_max = max(current.lat, target.lat) + BBOX_PADDING_DEG
    lon_min = min(current.lon, target.lon) - BBOX_PADDING_DEG
    lon_max = max(current.lon, target.lon) + BBOX_PADDING_DEG

    lat_span = lat_max - lat_min
    lon_span = lon_max - lon_min
    res = _effective_resolution(lat_span, lon_span, grid_resolution)

    rows = max(2, int(lat_span / res) + 1)
    cols = max(2, int(lon_span / res) + 1)

    grid = _build_threat_grid(lat_min, lon_min, rows, cols, res, threat_rings)

    def to_cell(lat: float, lon: float) -> tuple[int, int]:
        return (
            _clamp(int((lat - lat_min) / res), 0, rows - 1),
            _clamp(int((lon - lon_min) / res), 0, cols - 1),
        )

    def to_world(r: int, c: int) -> tuple[float, float]:
        return lat_min + r * res, lon_min + c * res

    sr, sc = to_cell(current.lat, current.lon)
    gr, gc = to_cell(target.lat, target.lon)

    def h(r: int, c: int) -> float:
        return abs(r - gr) + abs(c - gc)

    INF = float("inf")
    g_score: list[list[float]] = [[INF] * cols for _ in range(rows)]
    g_score[sr][sc] = 0.0
    came_from: dict[tuple[int, int], tuple[int, int]] = {}
    open_heap: list[tuple[float, float, int, int]] = [(h(sr, sc), 0.0, sr, sc)]

    while open_heap:
        f, g, r, c = heapq.heappop(open_heap)

        if r == gr and c == gc:
            path: list[Vec3] = []
            node = (r, c)
            while node in came_from:
                wlat, wlon = to_world(node[0], node[1])
                path.append(Vec3(wlat, wlon, current.alt_km))
                node = came_from[node]
            path.reverse()
            path.append(Vec3(target.lat, target.lon, target.alt_km))
            return path

        if g > g_score[r][c]:
            continue

        for dr, dc in _NEIGHBORS_8:
            nr, nc = r + dr, c + dc
            if not (0 <= nr < rows and 0 <= nc < cols):
                continue
            move_cost = math.sqrt(2.0) if dr != 0 and dc != 0 else 1.0
            ng = g + grid[nr][nc] * move_cost
            if ng < g_score[nr][nc]:
                g_score[nr][nc] = ng
                came_from[(nr, nc)] = (r, c)
                heapq.heappush(open_heap, (ng + h(nr, nc), ng, nr, nc))

    return [Vec3(target.lat, target.lon, target.alt_km)]
