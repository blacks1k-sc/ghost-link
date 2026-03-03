"""
Entity Graph — Adjacency List Property Graph
DSA: Property Graph (Adjacency List), BFS, DFS
Every object in the simulation is a typed Entity with UUID.
Lattice-inspired: entities are the single source of truth for all simulation state.
"""

from __future__ import annotations
import uuid
from enum import Enum
from dataclasses import dataclass, field
from typing import Any
from collections import deque


class EntityType(str, Enum):
    WEAPON = "WEAPON"
    TARGET = "TARGET"
    THREAT = "THREAT"
    TANKER = "TANKER"
    AIRBASE = "AIRBASE"
    CARRIER = "CARRIER"
    SATELLITE = "SATELLITE"


class DomainType(str, Enum):
    AIR = "AIR"
    SEA = "SEA"
    LAND = "LAND"
    SPACE = "SPACE"
    CYBER = "CYBER"


class RelType(str, Enum):
    ASSIGNED_TO = "ASSIGNED_TO"       # weapon → target
    THREATENS = "THREATENS"            # threat → weapon
    COORDINATES_WITH = "COORDINATES_WITH"  # weapon ↔ weapon (consensus neighbors)
    REFUELS_FROM = "REFUELS_FROM"      # weapon → tanker
    LAUNCHED_FROM = "LAUNCHED_FROM"    # weapon → airbase/carrier
    TRACKS = "TRACKS"                  # satellite → weapon/threat


class SudaState(str, Enum):
    CRUISE = "CRUISE"
    EVADING = "EVADING"
    REALIGNING = "REALIGNING"
    TERMINAL = "TERMINAL"
    DESTROYED = "DESTROYED"
    IMPACTED = "IMPACTED"


@dataclass
class Entity:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    type: EntityType = EntityType.WEAPON
    domain: DomainType = DomainType.AIR
    # Core properties stored as flat dict for flexibility
    # Weapons: lat, lon, alt_km, speed_mach, heading_deg, fuel_pct, tau_i, suda_state,
    #          weapon_type, range_km, p_kill_base, detection_radius_km
    # Targets: lat, lon, alt_km, label
    # Threats: lat, lon, threat_type, radius_km, p_intercept_base
    # Airbases/Carriers: lat, lon, name, country, runway_capable (list of weapon types)
    properties: dict[str, Any] = field(default_factory=dict)
    # Not stored in adjacency list — outgoing edges only (directed graph)
    # Stored separately in EntityGraph for O(1) lookup both ways
    _relationships: list[tuple[RelType, str]] = field(default_factory=list, repr=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "type": self.type.value,
            "domain": self.domain.value,
            "properties": self.properties,
        }


class EntityGraph:
    """
    Directed property graph stored as adjacency list.
    Adjacency list: adj[entity_id] = List[(RelType, target_entity_id)]

    BFS: used by planner to find all weapons assigned to a target
    DFS: used by analytics to traverse kill-chain dependency graph
    """

    def __init__(self):
        # Primary store: UUID → Entity
        self._entities: dict[str, Entity] = {}
        # Adjacency list (outgoing edges): UUID → [(RelType, UUID)]
        self._adj: dict[str, list[tuple[RelType, str]]] = {}
        # Reverse adjacency (incoming edges) for fast reverse-lookup
        self._radj: dict[str, list[tuple[RelType, str]]] = {}
        # Change listeners for WebSocket broadcast
        self._listeners: list = []

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    def add_entity(self, entity: Entity) -> Entity:
        self._entities[entity.id] = entity
        self._adj.setdefault(entity.id, [])
        self._radj.setdefault(entity.id, [])
        self._notify("upsert", entity)
        return entity

    def get_entity(self, entity_id: str) -> Entity | None:
        return self._entities.get(entity_id)

    def update_entity(self, entity_id: str, properties: dict[str, Any]) -> Entity | None:
        entity = self._entities.get(entity_id)
        if not entity:
            return None
        entity.properties.update(properties)
        self._notify("upsert", entity)
        return entity

    def remove_entity(self, entity_id: str) -> bool:
        if entity_id not in self._entities:
            return False
        # Remove all edges involving this entity
        for rel_type, target_id in self._adj.get(entity_id, []):
            self._radj[target_id] = [
                (r, s) for r, s in self._radj.get(target_id, []) if s != entity_id
            ]
        for rel_type, source_id in self._radj.get(entity_id, []):
            self._adj[source_id] = [
                (r, t) for r, t in self._adj.get(source_id, []) if t != entity_id
            ]
        del self._entities[entity_id]
        del self._adj[entity_id]
        del self._radj[entity_id]
        self._notify("remove", entity_id)
        return True

    def all_entities(self, entity_type: EntityType | None = None) -> list[Entity]:
        if entity_type is None:
            return list(self._entities.values())
        return [e for e in self._entities.values() if e.type == entity_type]

    # ------------------------------------------------------------------
    # Relationships
    # ------------------------------------------------------------------

    def add_relationship(self, from_id: str, rel_type: RelType, to_id: str):
        if from_id not in self._entities or to_id not in self._entities:
            raise ValueError(f"Entity not found: {from_id} or {to_id}")
        edge = (rel_type, to_id)
        if edge not in self._adj[from_id]:
            self._adj[from_id].append(edge)
            self._radj[to_id].append((rel_type, from_id))

    def remove_relationship(self, from_id: str, rel_type: RelType, to_id: str):
        self._adj[from_id] = [(r, t) for r, t in self._adj[from_id] if not (r == rel_type and t == to_id)]
        self._radj[to_id] = [(r, s) for r, s in self._radj[to_id] if not (r == rel_type and s == from_id)]

    def query_relationships(
        self, entity_id: str, rel_type: RelType | None = None, incoming: bool = False
    ) -> list[tuple[RelType, str]]:
        """
        Return outgoing (or incoming if incoming=True) edges of given rel_type.
        O(degree) — typically small for real simulation graphs.
        """
        edges = self._radj.get(entity_id, []) if incoming else self._adj.get(entity_id, [])
        if rel_type is None:
            return list(edges)
        return [(r, t) for r, t in edges if r == rel_type]

    # ------------------------------------------------------------------
    # Graph Traversal — DSA: BFS & DFS
    # ------------------------------------------------------------------

    def bfs(self, start_id: str, rel_type: RelType | None = None) -> list[str]:
        """
        BFS from start_id following outgoing edges.
        Returns ordered list of reachable entity IDs.
        Time: O(V + E)  Space: O(V)

        Used by: planner (find all weapons reachable from a carrier),
                 analytics (find all entities in a kill chain)
        """
        if start_id not in self._entities:
            return []
        visited: set[str] = {start_id}
        queue: deque[str] = deque([start_id])
        order: list[str] = []
        while queue:
            curr = queue.popleft()
            order.append(curr)
            for r, neighbor in self._adj.get(curr, []):
                if rel_type and r != rel_type:
                    continue
                if neighbor not in visited:
                    visited.add(neighbor)
                    queue.append(neighbor)
        return order

    def dfs(self, start_id: str, rel_type: RelType | None = None) -> list[str]:
        """
        Iterative DFS from start_id following outgoing edges.
        Time: O(V + E)  Space: O(V)

        Used by: cyber module (find all paths from attacker to target),
                 analytics (dependency-order event replay)
        """
        if start_id not in self._entities:
            return []
        visited: set[str] = set()
        stack: list[str] = [start_id]
        order: list[str] = []
        while stack:
            curr = stack.pop()
            if curr in visited:
                continue
            visited.add(curr)
            order.append(curr)
            for r, neighbor in reversed(self._adj.get(curr, [])):
                if rel_type and r != rel_type:
                    continue
                if neighbor not in visited:
                    stack.append(neighbor)
        return order

    def find_weapons_for_target(self, target_id: str) -> list[str]:
        """
        Return all weapon IDs assigned to a target.
        Uses reverse adjacency list — O(in-degree of target).
        """
        return [src for r, src in self._radj.get(target_id, []) if r == RelType.ASSIGNED_TO]

    def find_threats_to_weapon(self, weapon_id: str) -> list[str]:
        """Return all active threat IDs that are threatening this weapon."""
        return [src for r, src in self._radj.get(weapon_id, []) if r == RelType.THREATENS]

    def consensus_neighbors(self, weapon_id: str) -> list[str]:
        """Return weapons within consensus communication range (bidirectional)."""
        return [t for r, t in self._adj.get(weapon_id, []) if r == RelType.COORDINATES_WITH]

    # ------------------------------------------------------------------
    # Serialization
    # ------------------------------------------------------------------

    def snapshot(self) -> dict:
        """Full graph snapshot for initial WebSocket sync."""
        return {
            "entities": {eid: e.to_dict() for eid, e in self._entities.items()},
            "edges": {
                eid: [(r.value, t) for r, t in edges]
                for eid, edges in self._adj.items()
                if edges
            },
        }

    # ------------------------------------------------------------------
    # Change notification (WebSocket broadcast)
    # ------------------------------------------------------------------

    def add_listener(self, callback):
        self._listeners.append(callback)

    def _notify(self, event_type: str, payload):
        for cb in self._listeners:
            cb(event_type, payload)
