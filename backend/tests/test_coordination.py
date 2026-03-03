import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from core.entity_graph import EntityGraph, Entity, EntityType, DomainType, RelType, SudaState
from core.event_queue import EventQueue, EventType
from core.kdtree import SpatialManager, haversine_km
from simulation.suda import SudaEngine, MACH_TO_KMPS
from simulation.astar import astar_replan, ThreatRing, Vec3


TARGET_LAT = 30.0
TARGET_LON = 45.0

SAM_LAT = 35.1
SAM_LON = 45.0
SAM_RADIUS_KM = 80.0
SAM_P_INTERCEPT = 0.75

WEAPON_POSITIONS = [
    (35.2, 43.5),
    (35.0, 44.0),
    (35.4, 45.0),
    (35.2, 46.0),
    (35.3, 44.5),
]

CRUISE_MACH = 0.8
V_MIN_MACH = 0.5
V_MAX_MACH = 0.95
DETECTION_RADIUS_KM = 50.0


def _build_simulation():
    graph = EntityGraph()
    eq = EventQueue()
    spatial = SpatialManager()
    engine = SudaEngine(graph, eq, spatial)

    target = Entity(
        type=EntityType.TARGET,
        domain=DomainType.LAND,
        properties={"lat": TARGET_LAT, "lon": TARGET_LON, "alt_km": 0.0, "label": "Target Alpha"},
    )
    graph.add_entity(target)
    spatial.upsert(target.id, TARGET_LAT, TARGET_LON, 0.0)

    weapon_ids = []
    for lat, lon in WEAPON_POSITIONS:
        dist_km = haversine_km(lat, lon, TARGET_LAT, TARGET_LON)
        tau_i = dist_km / (CRUISE_MACH * MACH_TO_KMPS)
        weapon = Entity(
            type=EntityType.WEAPON,
            domain=DomainType.AIR,
            properties={
                "lat": lat,
                "lon": lon,
                "alt_km": 10.0,
                "speed_mach": CRUISE_MACH,
                "speed_min_mach": V_MIN_MACH,
                "speed_max_mach": V_MAX_MACH,
                "fuel_pct": 1.0,
                "fuel_burn_rate": 0.0005,
                "tau_i": tau_i,
                "suda_state": SudaState.CRUISE,
                "target_lat": TARGET_LAT,
                "target_lon": TARGET_LON,
                "alt_km_target": 0.0,
                "detection_radius_km": DETECTION_RADIUS_KM,
                "evasion_capable": True,
            },
        )
        graph.add_entity(weapon)
        spatial.upsert(weapon.id, lat, lon, 10.0)
        graph.add_relationship(weapon.id, RelType.ASSIGNED_TO, target.id)
        weapon_ids.append(weapon.id)

    sam = Entity(
        type=EntityType.THREAT,
        domain=DomainType.LAND,
        properties={
            "lat": SAM_LAT,
            "lon": SAM_LON,
            "alt_km": 0.0,
            "threat_type": "SAM",
            "radius_km": SAM_RADIUS_KM,
            "p_intercept_base": SAM_P_INTERCEPT,
        },
    )
    graph.add_entity(sam)
    spatial.upsert(sam.id, SAM_LAT, SAM_LON, 0.0)

    return graph, eq, spatial, engine, weapon_ids, sam.id


def _drain(eq: EventQueue) -> list:
    return eq.pop_until(eq.sim_time_ms)


def test_only_w3_detects_sam():
    graph, eq, spatial, engine, weapon_ids, sam_id = _build_simulation()
    w3_id = weapon_ids[2]

    dist_w3_to_sam = haversine_km(WEAPON_POSITIONS[2][0], WEAPON_POSITIONS[2][1], SAM_LAT, SAM_LON)
    assert dist_w3_to_sam < DETECTION_RADIUS_KM, (
        f"W3 must be within detection range: {dist_w3_to_sam:.1f} km vs {DETECTION_RADIUS_KM} km"
    )

    for i, wid in enumerate(weapon_ids):
        if wid == w3_id:
            continue
        lat, lon = WEAPON_POSITIONS[i]
        dist = haversine_km(lat, lon, SAM_LAT, SAM_LON)
        assert dist > DETECTION_RADIUS_KM, (
            f"W{i} must NOT be in detection range: {dist:.1f} km vs {DETECTION_RADIUS_KM} km"
        )


def test_suda_evasion_broadcasts_tot_updated():
    graph, eq, spatial, engine, weapon_ids, sam_id = _build_simulation()
    w3_id = weapon_ids[2]

    eq._sim_time_ms = 0.0
    engine._sense(w3_id, graph.get_entity(w3_id).properties, 0.0)
    engine._understand_and_decide(w3_id, graph.get_entity(w3_id).properties, 0.0)
    _drain(eq)

    w3 = graph.get_entity(w3_id)
    assert w3.properties.get("suda_state") == SudaState.EVADING, (
        f"W3 must be EVADING, got {w3.properties.get('suda_state')}"
    )

    tot_events = [e for e in eq._log if e.event_type == EventType.TOT_UPDATED]
    assert len(tot_events) >= 1, "TOT_UPDATED must be emitted after evasion"

    delta = tot_events[0].payload["delta_tau_s"]
    assert delta > 0.0, f"delta_tau_s must be positive, got {delta}"

    original_tau = haversine_km(*WEAPON_POSITIONS[2], TARGET_LAT, TARGET_LON) / (CRUISE_MACH * MACH_TO_KMPS)
    new_tau = w3.properties.get("tau_i")
    assert abs(new_tau - (original_tau + delta)) < 0.01


def test_greedy_schedule_syncs_arrival_times():
    graph, eq, spatial, engine, weapon_ids, sam_id = _build_simulation()
    w3_id = weapon_ids[2]

    eq._sim_time_ms = 0.0
    engine._sense(w3_id, graph.get_entity(w3_id).properties, 0.0)
    engine._understand_and_decide(w3_id, graph.get_entity(w3_id).properties, 0.0)
    _drain(eq)

    w3_tau = graph.get_entity(w3_id).properties["tau_i"]
    tau_star = max(graph.get_entity(wid).properties["tau_i"] for wid in weapon_ids)
    assert abs(tau_star - w3_tau) < 0.01, "W3 (delayed) must be the tau_star setter"

    engine.greedy_interval_schedule(0.0)
    _drain(eq)

    speed_events = [e for e in eq._log if e.event_type == EventType.SPEED_ADJUSTED]
    adjusted_ids = {e.entity_id for e in speed_events}

    for wid in weapon_ids:
        w = graph.get_entity(wid)
        if w.properties.get("suda_state") == SudaState.EVADING:
            continue

        assert wid in adjusted_ids, f"Weapon {wid} must receive SPEED_ADJUSTED event"

        v_mach = w.properties["speed_mach"]
        assert V_MIN_MACH <= v_mach <= V_MAX_MACH, (
            f"Speed {v_mach:.3f} Mach must be within [{V_MIN_MACH}, {V_MAX_MACH}]"
        )

        lat, lon = w.properties["lat"], w.properties["lon"]
        dist_km = haversine_km(lat, lon, TARGET_LAT, TARGET_LON)
        effective_tau = dist_km / (v_mach * MACH_TO_KMPS)
        loiter = w.properties.get("loiter", False)

        if not loiter:
            assert abs(effective_tau - tau_star) <= 2.0, (
                f"Weapon {wid}: effective arrival {effective_tau:.1f}s vs tau_star {tau_star:.1f}s "
                f"(diff={abs(effective_tau - tau_star):.3f}s)"
            )


def test_astar_route_avoids_threat_ring():
    astar_sam = ThreatRing(lat=32.0, lon=44.0, radius_km=60.0)
    start = Vec3(lat=33.5, lon=44.0, alt_km=10.0)
    tgt = Vec3(lat=30.5, lon=44.0, alt_km=0.0)

    assert haversine_km(start.lat, start.lon, astar_sam.lat, astar_sam.lon) > astar_sam.radius_km
    assert haversine_km(tgt.lat, tgt.lon, astar_sam.lat, astar_sam.lon) > astar_sam.radius_km

    midpoint_dist = haversine_km(
        (start.lat + tgt.lat) / 2, (start.lon + tgt.lon) / 2,
        astar_sam.lat, astar_sam.lon,
    )
    assert midpoint_dist < astar_sam.radius_km, "Direct path midpoint must be inside SAM zone"

    waypoints = astar_replan(start, tgt, [astar_sam], grid_resolution=0.1)

    assert len(waypoints) >= 1
    assert waypoints[-1].lat == pytest.approx(tgt.lat, abs=0.2)
    assert waypoints[-1].lon == pytest.approx(tgt.lon, abs=0.2)

    for wp in waypoints[:-1]:
        dist_to_sam = haversine_km(wp.lat, wp.lon, astar_sam.lat, astar_sam.lon)
        assert dist_to_sam >= astar_sam.radius_km, (
            f"Waypoint ({wp.lat:.2f},{wp.lon:.2f}) inside SAM zone: "
            f"{dist_to_sam:.1f} km < {astar_sam.radius_km} km"
        )


def test_full_loop_five_weapon_salvo():
    graph, eq, spatial, engine, weapon_ids, sam_id = _build_simulation()
    w3_id = weapon_ids[2]

    eq._sim_time_ms = 0.0
    engine._sense(w3_id, graph.get_entity(w3_id).properties, 0.0)
    engine._understand_and_decide(w3_id, graph.get_entity(w3_id).properties, 0.0)
    _drain(eq)

    assert graph.get_entity(w3_id).properties["suda_state"] == SudaState.EVADING

    engine.greedy_interval_schedule(0.0)
    _drain(eq)

    tau_star = max(graph.get_entity(wid).properties["tau_i"] for wid in weapon_ids)

    cruise_weapons = [
        wid for wid in weapon_ids
        if graph.get_entity(wid).properties.get("suda_state") != SudaState.EVADING
    ]
    assert len(cruise_weapons) == 4

    for wid in cruise_weapons:
        w = graph.get_entity(wid)
        lat, lon = w.properties["lat"], w.properties["lon"]
        dist_km = haversine_km(lat, lon, TARGET_LAT, TARGET_LON)
        v_kmps = w.properties["speed_mach"] * MACH_TO_KMPS
        effective_tau = dist_km / v_kmps
        loiter = w.properties.get("loiter", False)
        if not loiter:
            assert abs(effective_tau - tau_star) <= 2.0, (
                f"Full loop: weapon arrives at {effective_tau:.1f}s, "
                f"tau_star={tau_star:.1f}s (diff={abs(effective_tau-tau_star):.3f}s)"
            )

    astar_sam = ThreatRing(lat=32.0, lon=44.0, radius_km=60.0)
    w3_after_evasion = Vec3(lat=35.4, lon=46.0, alt_km=10.0)
    t_pos = Vec3(TARGET_LAT, TARGET_LON, 0.0)

    assert haversine_km(w3_after_evasion.lat, w3_after_evasion.lon, astar_sam.lat, astar_sam.lon) > astar_sam.radius_km

    route = astar_replan(w3_after_evasion, t_pos, [astar_sam], grid_resolution=0.1)
    assert len(route) >= 1

    for wp in route[:-1]:
        dist_to_sam = haversine_km(wp.lat, wp.lon, astar_sam.lat, astar_sam.lon)
        assert dist_to_sam >= astar_sam.radius_km, (
            f"Route enters SAM zone at ({wp.lat:.2f},{wp.lon:.2f}): "
            f"{dist_to_sam:.1f} km < {astar_sam.radius_km} km"
        )
