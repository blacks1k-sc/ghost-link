"""
SUDA Coordination Engine — Sense, Understand, Decide, Act
DSA: State Machine, Max-Heap (threat prioritization), A* (route replan)

Each weapon runs its own SUDA loop every physics tick.
This is the core autonomous behavior of GHOST-LINK.
"""

from __future__ import annotations
import math
import heapq

from enum import Enum
from typing import Any

from core.entity_graph import EntityGraph, EntityType, RelType, SudaState
from core.event_queue import EventQueue, EventType
from core.kdtree import SpatialManager, haversine_km

MACH_TO_KMPS = 0.299  # ISA at ~10km cruise altitude (matches Rust physics engine)


# ---------------------------------------------------------------------------
# Threat types and evasion decisions
# ---------------------------------------------------------------------------

class ThreatType(str, Enum):
    SAM = "SAM"
    INTERCEPTOR_AIRCRAFT = "INTERCEPTOR_AIRCRAFT"
    TURBULENCE = "TURBULENCE"
    EW_JAMMING = "EW_JAMMING"
    TERMINAL_INTERCEPTOR = "TERMINAL_INTERCEPTOR"


# Evasion parameters per threat type
EVASION_PARAMS: dict[ThreatType, dict] = {
    ThreatType.SAM: {
        "duration_s": 25.0,
        "g_load": 6.0,
        "lateral_offset_km": 8.0,
        "description": "S-turn evasion maneuver",
        "success_base_p": 0.55,
    },
    ThreatType.INTERCEPTOR_AIRCRAFT: {
        "duration_s": 15.0,
        "g_load": 4.0,
        "lateral_offset_km": 5.0,
        "description": "Chaff dispensing + weave maneuver",
        "success_base_p": 0.45,
    },
    ThreatType.TURBULENCE: {
        "duration_s": 30.0,
        "g_load": 0.0,
        "speed_factor": 0.85,
        "description": "Altitude change to avoid turbulence",
        "success_base_p": 1.0,
    },
    ThreatType.EW_JAMMING: {
        "duration_s": 0.0,
        "g_load": 0.0,
        "description": "Switch to inertial nav (accuracy penalty)",
        "cep_multiplier": 5.0,
        "success_base_p": 1.0,
    },
    ThreatType.TERMINAL_INTERCEPTOR: {
        "duration_s": 5.0,
        "g_load": 9.0,
        "lateral_offset_km": 3.0,
        "description": "High-G barrel roll",
        "success_base_p": 0.35,
    },
}


# ---------------------------------------------------------------------------
# Threat Heap — Max-Heap keyed by interception probability
# DSA: Max-Heap / Priority Queue
# ---------------------------------------------------------------------------

class ThreatHeap:
    """
    Per-weapon max-heap of active threats, ordered by interception probability.

    Max-Heap property: highest P_intercept at the root.
    Python's heapq is a min-heap → we store (-p_intercept, ...) to invert.

    Push: O(log n)    Pop: O(log n)    Peek: O(1)
    """

    def __init__(self):
        self._heap: list[tuple[float, str, str, dict]] = []
        # (-p_intercept, threat_id, threat_type, properties)

    def push(self, threat_id: str, threat_type: str, p_intercept: float, properties: dict):
        heapq.heappush(self._heap, (-p_intercept, threat_id, threat_type, properties))

    def pop_highest(self) -> tuple[float, str, str, dict] | None:
        if self._heap:
            neg_p, tid, ttype, props = heapq.heappop(self._heap)
            return (-neg_p, tid, ttype, props)
        return None

    def peek(self) -> tuple[float, str, str, dict] | None:
        if self._heap:
            neg_p, tid, ttype, props = self._heap[0]
            return (-neg_p, tid, ttype, props)
        return None

    def clear(self):
        self._heap.clear()

    def size(self) -> int:
        return len(self._heap)


# ---------------------------------------------------------------------------
# SUDA Engine
# ---------------------------------------------------------------------------

class SudaEngine:
    """
    Runs the SUDA loop for all active weapons each simulation tick.

    Called by the simulation loop (main.py) every 100ms sim-time after
    the Rust physics tick updates weapon positions.
    """

    def __init__(
        self,
        graph: EntityGraph,
        event_queue: EventQueue,
        spatial: SpatialManager,
    ):
        self.graph = graph
        self.eq = event_queue
        self.spatial = spatial
        # Per-weapon threat heaps: weapon_id → ThreatHeap
        self._threat_heaps: dict[str, ThreatHeap] = {}

    # ------------------------------------------------------------------
    # Main tick — called after each physics tick
    # ------------------------------------------------------------------

    def tick(self, sim_time_ms: float):
        """Run one SUDA cycle for all alive weapons."""
        weapons = self.graph.all_entities(EntityType.WEAPON)
        for weapon in weapons:
            props = weapon.properties
            suda_state = props.get("suda_state", SudaState.CRUISE)
            if suda_state in (SudaState.DESTROYED, SudaState.IMPACTED):
                continue
            self._sense(weapon.id, props, sim_time_ms)
            self._understand_and_decide(weapon.id, props, sim_time_ms)

    # ------------------------------------------------------------------
    # SENSE — K-D Tree range query
    # ------------------------------------------------------------------

    def _sense(self, weapon_id: str, props: dict, sim_time_ms: float):
        """
        Find all threats within this weapon's detection radius.
        Uses K-D Tree range_query: O(log n + k)
        """
        lat = props.get("lat", 0.0)
        lon = props.get("lon", 0.0)
        alt_km = props.get("alt_km", 10.0)
        detection_radius_km = props.get("detection_radius_km", 50.0)

        # Get nearby entities
        nearby = self.spatial.range_query(lat, lon, detection_radius_km, alt_km)

        # Filter to only THREAT entities
        threat_heap = self._threat_heaps.setdefault(weapon_id, ThreatHeap())
        threat_heap.clear()

        for entity_id, dist_km in nearby:
            if entity_id == weapon_id:
                continue
            entity = self.graph.get_entity(entity_id)
            if not entity or entity.type != EntityType.THREAT:
                continue

            threat_type = entity.properties.get("threat_type", "SAM")
            p_intercept = self._compute_p_intercept(
                dist_km, threat_type, entity.properties, props
            )
            if p_intercept > 0.05:  # only track meaningful threats
                threat_heap.push(entity_id, threat_type, p_intercept, entity.properties)
                # Add THREATENS relationship if not already present
                try:
                    self.graph.add_relationship(entity_id, RelType.THREATENS, weapon_id)
                except Exception:
                    pass

                # Emit THREAT_DETECTED if this is a new detection
                self.eq.push_now(
                    EventType.THREAT_DETECTED,
                    entity_id=weapon_id,
                    payload={
                        "threat_id": entity_id,
                        "threat_type": threat_type,
                        "p_intercept": p_intercept,
                        "dist_km": dist_km,
                    },
                    priority=3,
                )

    # ------------------------------------------------------------------
    # UNDERSTAND + DECIDE + ACT
    # ------------------------------------------------------------------

    def _understand_and_decide(self, weapon_id: str, props: dict, sim_time_ms: float):
        """
        Pop the highest-priority threat and select a countermeasure.
        State machine: CRUISE → EVADING → REALIGNING → CRUISE
        """
        suda_state = props.get("suda_state", SudaState.CRUISE)

        # If currently EVADING, don't interrupt with new decision
        if suda_state == SudaState.EVADING:
            return

        heap = self._threat_heaps.get(weapon_id)
        if not heap or heap.size() == 0:
            if suda_state == SudaState.REALIGNING:
                # Realignment complete — back to CRUISE
                self.graph.update_entity(weapon_id, {"suda_state": SudaState.CRUISE})
            return

        # UNDERSTAND: pop highest P_intercept threat
        p_intercept, threat_id, threat_type_str, threat_props = heap.pop_highest()

        try:
            threat_type = ThreatType(threat_type_str)
        except ValueError:
            threat_type = ThreatType.SAM

        # DECIDE: select countermeasure
        evasion = EVASION_PARAMS[threat_type]

        # ACT: update weapon state and emit events
        if threat_type == ThreatType.EW_JAMMING:
            # No maneuver — just degrade navigation accuracy
            self.graph.update_entity(weapon_id, {
                "nav_degraded": True,
                "cep_multiplier": evasion.get("cep_multiplier", 5.0),
                "suda_state": SudaState.CRUISE,
            })
            self.eq.push_now(
                EventType.EVASION_START,
                entity_id=weapon_id,
                payload={
                    "threat_id": threat_id,
                    "threat_type": threat_type_str,
                    "description": evasion["description"],
                    "delta_tau_s": 0.0,
                },
            )
            return

        if threat_type == ThreatType.TURBULENCE:
            speed_factor = evasion.get("speed_factor", 0.85)
            duration_s = evasion["duration_s"]
            dist_to_target = props.get("dist_to_target_km", 1000.0)
            speed_mach = props.get("speed_mach", 0.8)
            speed_kmps = speed_mach * MACH_TO_KMPS
            delta_tau_s = min(
                dist_to_target / (speed_kmps * speed_factor) - dist_to_target / speed_kmps,
                duration_s,
            )

            self.graph.update_entity(weapon_id, {
                "suda_state": SudaState.EVADING,
                "evasion_timer_s": duration_s,
                "speed_mach": speed_mach * speed_factor,
            })
            self._broadcast_tau_update(weapon_id, delta_tau_s, sim_time_ms)
            return

        # For SAM, INTERCEPTOR_AIRCRAFT, TERMINAL_INTERCEPTOR: S-turn or barrel roll
        duration_s = evasion["duration_s"]
        g_load = evasion["g_load"]
        lateral_km = evasion.get("lateral_offset_km", 5.0)

        speed_mach = props.get("speed_mach", 0.8)
        speed_kmps = speed_mach * MACH_TO_KMPS
        direct_path_km = speed_kmps * duration_s
        sturn_path_km = math.sqrt(direct_path_km ** 2 + (2.0 * lateral_km) ** 2)
        delta_tau_s = (sturn_path_km - direct_path_km) / speed_kmps

        # Update entity state → triggers Rust physics to execute S-turn
        self.graph.update_entity(weapon_id, {
            "suda_state": SudaState.EVADING,
            "evasion_timer_s": duration_s,
            "evasion_g": g_load,
            "evasion_lateral_offset": lateral_km,
        })

        self.eq.push_now(
            EventType.EVASION_START,
            entity_id=weapon_id,
            payload={
                "threat_id": threat_id,
                "threat_type": threat_type_str,
                "p_intercept": p_intercept,
                "description": evasion["description"],
                "delta_tau_s": delta_tau_s,
                "duration_s": duration_s,
                "g_load": g_load,
            },
            priority=2,
        )

        # Schedule EVASION_END event
        self.eq.push_after(
            EventType.EVASION_END,
            delay_ms=duration_s * 1000,
            entity_id=weapon_id,
            payload={"threat_id": threat_id},
            priority=2,
        )

        # Broadcast updated τ_i to consensus neighbors
        self._broadcast_tau_update(weapon_id, delta_tau_s, sim_time_ms)

    # ------------------------------------------------------------------
    # Re-coordination broadcast
    # ------------------------------------------------------------------

    def _broadcast_tau_update(self, weapon_id: str, delta_tau_s: float, sim_time_ms: float):
        """
        After a weapon's τ_i changes (due to evasion or destruction),
        emit TOT_UPDATED so consensus neighbors can adjust their speeds.
        """
        weapon = self.graph.get_entity(weapon_id)
        if not weapon:
            return
        old_tau = weapon.properties.get("tau_i", 0.0)
        new_tau = old_tau + delta_tau_s
        self.graph.update_entity(weapon_id, {"tau_i": new_tau})

        self.eq.push_now(
            EventType.TOT_UPDATED,
            entity_id=weapon_id,
            payload={
                "old_tau_i": old_tau,
                "new_tau_i": new_tau,
                "delta_tau_s": delta_tau_s,
            },
            priority=1,
        )

    def handle_weapon_destroyed(self, weapon_id: str, sim_time_ms: float):
        """
        Called when a weapon is destroyed (P_kill check fails).
        Removes from consensus pool; survivors re-converge naturally next tick.
        """
        self.graph.update_entity(weapon_id, {"suda_state": SudaState.DESTROYED})
        if weapon_id in self._threat_heaps:
            del self._threat_heaps[weapon_id]

        self.eq.push_now(
            EventType.WEAPON_DESTROYED,
            entity_id=weapon_id,
            payload={"sim_time_ms": sim_time_ms},
            priority=0,
        )

    def greedy_interval_schedule(self, sim_time_ms: float):
        survivors = [
            w for w in self.graph.all_entities(EntityType.WEAPON)
            if w.properties.get("suda_state") not in (SudaState.DESTROYED, SudaState.IMPACTED)
        ]
        if len(survivors) < 2:
            return

        tau_star = max(w.properties.get("tau_i", 0.0) for w in survivors)
        if tau_star <= 0.0:
            return

        survivors.sort(key=lambda w: tau_star - w.properties.get("tau_i", 0.0))

        for weapon in survivors:
            props = weapon.properties
            if props.get("suda_state") == SudaState.EVADING:
                continue

            lat = props.get("lat", 0.0)
            lon = props.get("lon", 0.0)
            target_lat = props.get("target_lat", lat)
            target_lon = props.get("target_lon", lon)
            dist_km = haversine_km(lat, lon, target_lat, target_lon)

            if dist_km <= 0.0:
                continue

            v_required_kmps = dist_km / tau_star
            v_min_mach = props.get("speed_min_mach", 0.5)
            v_max_mach = props.get("speed_max_mach", 0.9)
            v_min_kmps = v_min_mach * MACH_TO_KMPS
            v_max_kmps = v_max_mach * MACH_TO_KMPS

            loiter = False
            if v_required_kmps < v_min_kmps:
                v_adjusted_kmps = v_min_kmps
                loiter = True
            else:
                v_adjusted_kmps = min(v_required_kmps, v_max_kmps)

            v_adjusted_mach = v_adjusted_kmps / MACH_TO_KMPS
            current_mach = props.get("speed_mach", 0.8)
            burn_rate = props.get("fuel_burn_rate", 0.0005)
            fuel_pct = props.get("fuel_pct", 1.0)
            fuel_cost = abs(v_adjusted_mach - current_mach) * burn_rate * tau_star
            new_fuel = max(0.0, fuel_pct - fuel_cost)

            self.graph.update_entity(weapon.id, {
                "speed_mach": v_adjusted_mach,
                "fuel_pct": new_fuel,
                "loiter": loiter,
            })

            self.eq.push_now(
                EventType.SPEED_ADJUSTED,
                entity_id=weapon.id,
                payload={
                    "tau_star_s": tau_star,
                    "delta_tau_s": tau_star - props.get("tau_i", 0.0),
                    "v_adjusted_mach": v_adjusted_mach,
                    "dist_to_target_km": dist_km,
                    "loiter": loiter,
                    "fuel_pct": new_fuel,
                },
                priority=2,
            )

    # ------------------------------------------------------------------
    # P_intercept calculation
    # ------------------------------------------------------------------

    def _compute_p_intercept(
        self,
        dist_km: float,
        threat_type: str,
        threat_props: dict,
        weapon_props: dict,
    ) -> float:
        """
        Compute probability of successful intercept given geometry.
        Simplified but physically motivated model.
        """
        base_p = threat_props.get("p_intercept_base", 0.7)
        radius_km = threat_props.get("radius_km", 100.0)

        if dist_km > radius_km:
            return 0.0

        # Closer → higher probability
        proximity_factor = 1.0 - (dist_km / radius_km) ** 2

        # Weapon stealth reduces effective P
        stealth_factor = 0.5 if weapon_props.get("stealth", False) else 1.0

        # Evasion capable weapons have lower base P when not already evading
        evasion_factor = 0.7 if weapon_props.get("evasion_capable", False) else 1.0

        return min(base_p * proximity_factor * stealth_factor * evasion_factor, 0.99)
