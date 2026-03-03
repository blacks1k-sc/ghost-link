"""
K-D Tree Spatial Index
DSA: K-Dimensional Tree (binary space partitioning tree)
Build: O(n log n)    Range query: O(log n + k)    Nearest-k: O(k log n)

Used every simulation tick to answer:
  - "Which weapons are within consensus communication range of weapon i?"  (SUDA: Sense)
  - "Which threats are within detection radius of weapon w?"               (SUDA: Sense)
  - "Which airbases are within range of target t?"                         (AI Planner)
  - "Is there already an entity within 2km of this new base?" (dedup)
"""

from __future__ import annotations
import math
from dataclasses import dataclass, field
from typing import Any


# ---------------------------------------------------------------------------
# Haversine distance (great-circle, km) — used as the actual distance metric
# ---------------------------------------------------------------------------

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine great-circle distance in km. O(1)."""
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


# ---------------------------------------------------------------------------
# Point3D — the coordinate type stored in the tree
# ---------------------------------------------------------------------------

@dataclass
class Point3D:
    lat: float          # degrees
    lon: float          # degrees
    alt_km: float = 0.0 # altitude in km
    entity_id: str = ""

    def __getitem__(self, axis: int) -> float:
        return (self.lat, self.lon, self.alt_km)[axis]

    def surface_distance_km(self, other: "Point3D") -> float:
        return haversine_km(self.lat, self.lon, other.lat, other.lon)

    def distance_3d_km(self, other: "Point3D") -> float:
        d_surface = haversine_km(self.lat, self.lon, other.lat, other.lon)
        d_alt = abs(self.alt_km - other.alt_km)
        return math.sqrt(d_surface ** 2 + d_alt ** 2)


# ---------------------------------------------------------------------------
# K-D Tree Node
# ---------------------------------------------------------------------------

@dataclass
class _KDNode:
    point: Point3D
    left: "_KDNode | None" = None
    right: "_KDNode | None" = None
    alive: bool = True   # lazy deletion flag


# ---------------------------------------------------------------------------
# K-D Tree
# ---------------------------------------------------------------------------

class KDTree:
    """
    3D K-D Tree over (lat, lon, alt_km) for spatial queries.

    Key interview concepts demonstrated:
      - Axis cycling: split dimension alternates 0→1→2→0...
      - Median split: guarantees balanced tree (O(log n) height)
      - Backtracking: range_query must backtrack when sphere intersects splitting plane
      - Lazy deletion: remove in O(1), periodic rebuild in O(n log n)

    Note: We use haversine for actual distances (correct on a sphere) but the
    K-D tree splitting uses raw lat/lon values. This is an approximation that
    breaks near the poles but is acceptable for most military simulation scenarios
    (targets are rarely at extreme latitudes). For polar accuracy, convert to ECEF.
    """

    DIMS = 3

    def __init__(self):
        self._root: _KDNode | None = None
        self._size: int = 0
        self._dead_count: int = 0
        # Rebuild threshold: if >30% of nodes are dead, trigger rebuild
        self._REBUILD_THRESHOLD = 0.3

    # ------------------------------------------------------------------
    # Build
    # ------------------------------------------------------------------

    def build(self, points: list[Point3D]):
        """
        Build balanced K-D Tree from a list of points.
        Time: O(n log n)  Space: O(n)

        Uses median-of-medians for O(n) median finding (simplified here
        to sorted-slice median for clarity).
        """
        self._root = self._build(points, depth=0)
        self._size = len(points)
        self._dead_count = 0

    def _build(self, points: list[Point3D], depth: int) -> _KDNode | None:
        if not points:
            return None
        axis = depth % self.DIMS
        # Sort by current axis and pick median
        points.sort(key=lambda p: p[axis])
        mid = len(points) // 2
        node = _KDNode(point=points[mid])
        node.left = self._build(points[:mid], depth + 1)
        node.right = self._build(points[mid + 1:], depth + 1)
        return node

    # ------------------------------------------------------------------
    # Insert (incremental, unbalanced — use rebuild after many inserts)
    # ------------------------------------------------------------------

    def insert(self, point: Point3D):
        """Insert a single point. O(log n) average, O(n) worst case (unbalanced)."""
        self._root = self._insert(self._root, point, depth=0)
        self._size += 1

    def _insert(self, node: _KDNode | None, point: Point3D, depth: int) -> _KDNode:
        if node is None:
            return _KDNode(point=point)
        axis = depth % self.DIMS
        if point[axis] < node.point[axis]:
            node.left = self._insert(node.left, point, depth + 1)
        else:
            node.right = self._insert(node.right, point, depth + 1)
        return node

    # ------------------------------------------------------------------
    # Lazy Deletion
    # ------------------------------------------------------------------

    def delete(self, entity_id: str) -> bool:
        """
        Lazy deletion: mark the node as dead in O(log n) average.
        The node stays in the tree but is excluded from results.
        Periodic rebuild removes dead nodes: call rebuild() when needed.
        """
        found = self._mark_dead(self._root, entity_id)
        if found:
            self._dead_count += 1
            if self._size > 0 and self._dead_count / self._size > self._REBUILD_THRESHOLD:
                self._rebuild_from_root()
        return found

    def _mark_dead(self, node: _KDNode | None, entity_id: str) -> bool:
        if node is None:
            return False
        if node.point.entity_id == entity_id:
            node.alive = False
            return True
        return self._mark_dead(node.left, entity_id) or self._mark_dead(node.right, entity_id)

    def _collect_alive(self, node: _KDNode | None, result: list[Point3D]):
        if node is None:
            return
        if node.alive:
            result.append(node.point)
        self._collect_alive(node.left, result)
        self._collect_alive(node.right, result)

    def _rebuild_from_root(self):
        alive_points: list[Point3D] = []
        self._collect_alive(self._root, alive_points)
        self.build(alive_points)

    # ------------------------------------------------------------------
    # Range Query — DSA core operation
    # ------------------------------------------------------------------

    def range_query(self, center: Point3D, radius_km: float) -> list[tuple[str, float]]:
        """
        Find all alive points within radius_km of center (haversine distance).
        Returns list of (entity_id, distance_km), sorted by distance ascending.

        Time: O(log n + k) average where k = result count.
        Worst case O(n) (e.g., all points within radius).

        Key insight: backtrack when the splitting plane is within radius of the
        query point — the other subtree may still have qualifying points.
        """
        results: list[tuple[str, float]] = []
        self._range_query(self._root, center, radius_km, depth=0, results=results)
        results.sort(key=lambda x: x[1])
        return results

    def _range_query(
        self,
        node: _KDNode | None,
        center: Point3D,
        radius_km: float,
        depth: int,
        results: list,
    ):
        if node is None:
            return
        if node.alive:
            dist = center.surface_distance_km(node.point)
            if dist <= radius_km:
                results.append((node.point.entity_id, dist))

        axis = depth % self.DIMS
        # Distance from query point to splitting plane (in degrees for lat/lon)
        # Convert to approximate km: 1 deg lat ≈ 111 km, 1 deg lon ≈ 111*cos(lat) km
        plane_val = node.point[axis]
        query_val = center[axis]
        if axis == 0:   # lat — 1 deg ≈ 111 km
            plane_dist_km = abs(query_val - plane_val) * 111.0
        elif axis == 1: # lon — varies with latitude
            plane_dist_km = abs(query_val - plane_val) * 111.0 * math.cos(math.radians(center.lat))
        else:           # alt_km — 1 unit = 1 km
            plane_dist_km = abs(query_val - plane_val)

        # Visit the subtree on the same side as the query point first
        near, far = (node.left, node.right) if query_val < plane_val else (node.right, node.left)
        self._range_query(near, center, radius_km, depth + 1, results)
        # Backtrack: only visit far subtree if splitting plane is within radius
        if plane_dist_km <= radius_km:
            self._range_query(far, center, radius_km, depth + 1, results)

    # ------------------------------------------------------------------
    # Nearest-K Query
    # ------------------------------------------------------------------

    def nearest_k(self, center: Point3D, k: int) -> list[tuple[str, float]]:
        """
        Find the k nearest alive points to center.
        Returns list of (entity_id, distance_km) sorted ascending.
        Time: O(k log n) average.

        Algorithm: maintains a max-heap of size k. Prunes subtrees whose
        minimum possible distance exceeds the current k-th best distance.
        """
        import heapq
        # Max-heap: store (-dist, entity_id) so smallest dist = top of heap when negated
        heap: list[tuple[float, str]] = []  # (-dist, entity_id)
        self._nearest_k(self._root, center, k, heap, depth=0)
        results = sorted([(-d, eid) for d, eid in heap], key=lambda x: x[0])
        return results

    def _nearest_k(
        self,
        node: _KDNode | None,
        center: Point3D,
        k: int,
        heap: list,
        depth: int,
    ):
        import heapq
        if node is None:
            return
        if node.alive:
            dist = center.surface_distance_km(node.point)
            if len(heap) < k:
                heapq.heappush(heap, (-dist, node.point.entity_id))
            elif dist < -heap[0][0]:
                heapq.heapreplace(heap, (-dist, node.point.entity_id))

        axis = depth % self.DIMS
        query_val = center[axis]
        plane_val = node.point[axis]

        near, far = (node.left, node.right) if query_val < plane_val else (node.right, node.left)
        self._nearest_k(near, center, k, heap, depth + 1)

        # Prune far subtree if it can't improve current best
        if axis == 0:
            plane_dist_km = abs(query_val - plane_val) * 111.0
        elif axis == 1:
            plane_dist_km = abs(query_val - plane_val) * 111.0 * math.cos(math.radians(center.lat))
        else:
            plane_dist_km = abs(query_val - plane_val)

        worst_in_heap = -heap[0][0] if heap else float("inf")
        if len(heap) < k or plane_dist_km < worst_in_heap:
            self._nearest_k(far, center, k, heap, depth + 1)

    # ------------------------------------------------------------------
    # Stats
    # ------------------------------------------------------------------

    def size(self) -> int:
        return self._size - self._dead_count

    def needs_rebuild(self) -> bool:
        return self._size > 0 and self._dead_count / self._size > self._REBUILD_THRESHOLD


# ---------------------------------------------------------------------------
# Spatial Manager — wraps KDTree with entity graph sync
# ---------------------------------------------------------------------------

class SpatialManager:
    """
    Maintains a KDTree synchronized with the entity graph.
    Provides the range_query and nearest_k interface used by SUDA and Planner.
    """

    def __init__(self):
        self._tree = KDTree()
        self._entity_positions: dict[str, Point3D] = {}

    def upsert(self, entity_id: str, lat: float, lon: float, alt_km: float = 0.0):
        """Add or update entity position. Rebuilds point if moved."""
        if entity_id in self._entity_positions:
            self._tree.delete(entity_id)
        point = Point3D(lat=lat, lon=lon, alt_km=alt_km, entity_id=entity_id)
        self._entity_positions[entity_id] = point
        self._tree.insert(point)

    def remove(self, entity_id: str):
        if entity_id in self._entity_positions:
            self._tree.delete(entity_id)
            del self._entity_positions[entity_id]

    def rebuild(self, entities: list[tuple[str, float, float, float]]):
        """
        Full rebuild from (entity_id, lat, lon, alt_km) list.
        O(n log n). Call on startup or after bulk changes.
        """
        points = [Point3D(lat=lat, lon=lon, alt_km=alt_km, entity_id=eid)
                  for eid, lat, lon, alt_km in entities]
        self._entity_positions = {p.entity_id: p for p in points}
        self._tree.build(points)

    def range_query(self, lat: float, lon: float, radius_km: float, alt_km: float = 0.0) -> list[tuple[str, float]]:
        """Return (entity_id, dist_km) pairs within radius_km."""
        center = Point3D(lat=lat, lon=lon, alt_km=alt_km)
        return self._tree.range_query(center, radius_km)

    def nearest_k(self, lat: float, lon: float, k: int, alt_km: float = 0.0) -> list[tuple[str, float]]:
        """Return k nearest (entity_id, dist_km) pairs."""
        center = Point3D(lat=lat, lon=lon, alt_km=alt_km)
        return self._tree.nearest_k(center, k)

    def within_2km(self, lat: float, lon: float) -> bool:
        """Dedup check: is there already an entity within 2km?"""
        results = self.range_query(lat, lon, radius_km=2.0)
        return len(results) > 0
