"""
GHOST-LINK Supabase persistence layer.

All simulation state (missions, weapons, targets, events, telemetry) is written
here at end-of-mission and every 10 physics ticks. The hot in-memory path
(EntityGraph + K-D Tree) is never blocked by these writes.

Tables (all in public schema, gl_ prefix):
  gl_missions     — one row per sim run
  gl_weapons_log  — final weapon state + launch coords
  gl_targets_log  — targets and hit/miss outcome
  gl_events_log   — full DES event stream
  gl_telemetry    — 1s-sampled position history per weapon
"""

from __future__ import annotations
import json
import logging
import os
from typing import Any

from supabase import acreate_client, AsyncClient

logger = logging.getLogger("ghost-link.db")

_client: AsyncClient | None = None


async def init_db() -> None:
    global _client
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        logger.warning("SUPABASE_URL / SUPABASE_SERVICE_KEY not set — DB persistence disabled")
        return
    _client = await acreate_client(url, key)
    logger.info("Supabase client initialised → %s", url)


def _db() -> AsyncClient | None:
    return _client


# ---------------------------------------------------------------------------
# Mission lifecycle
# ---------------------------------------------------------------------------

async def create_mission(mission_id: str, sim_speed: float) -> None:
    db = _db()
    if not db:
        return
    try:
        await db.table("gl_missions").insert({
            "id": mission_id,
            "status": "RUNNING",
            "sim_speed": sim_speed,
        }).execute()
    except Exception as e:
        logger.error("create_mission failed: %s", e)


async def finish_mission(
    mission_id: str,
    graph,              # EntityGraph
    event_queue,        # EventQueue
    launch_snapshots: dict[str, dict],
    rms_final: float,
    aborted: bool = False,
) -> None:
    """
    Called at end of simulation (SIMULATION_END or /simulation/stop).
    Bulk-inserts weapons_log, targets_log, events_log then updates missions row.
    """
    db = _db()
    if not db:
        return

    from core.entity_graph import EntityType, RelType

    try:
        weapons = list(graph.all_entities(EntityType.WEAPON))
        targets = list(graph.all_entities(EntityType.TARGET))

        # --- build evasion counts from event log ---
        evasion_events = event_queue.get_log(None)  # all events
        evasion_counts: dict[str, int] = {}
        for ev in evasion_events:
            if ev["event_type"] == "EVASION_START" and ev["entity_id"]:
                evasion_counts[ev["entity_id"]] = evasion_counts.get(ev["entity_id"], 0) + 1

        # --- build hit-target set from impacted weapons ---
        hit_target_ids: set[str] = set()
        for w in weapons:
            if w.properties.get("suda_state") == "IMPACTED":
                rels = graph.query_relationships(w.id, RelType.ASSIGNED_TO)
                hit_target_ids.update(rels)

        # --- weapons_log rows ---
        weapon_rows = []
        for w in weapons:
            snap = launch_snapshots.get(w.id, {})
            p = w.properties
            state = p.get("suda_state", "SURVIVING")
            weapon_rows.append({
                "id":                 w.id,
                "mission_id":         mission_id,
                "weapon_type":        p.get("weapon_type") or snap.get("weapon_type"),
                "domain":             w.domain.value,
                "launch_lat":         snap.get("lat"),
                "launch_lon":         snap.get("lon"),
                "launch_alt_km":      snap.get("alt_km"),
                "launch_platform_id": snap.get("launch_platform_id"),
                "target_lat":         snap.get("target_lat") or p.get("target_lat"),
                "target_lon":         snap.get("target_lon") or p.get("target_lon"),
                "target_label":       snap.get("target_label"),
                "final_state":        state if state in ("IMPACTED", "DESTROYED") else "SURVIVING",
                "final_lat":          p.get("lat"),
                "final_lon":          p.get("lon"),
                "fuel_remaining_pct": p.get("fuel_pct"),
                "speed_mach_final":   p.get("speed_mach"),
                "tau_i_final":        p.get("tau_i"),
                "evasion_count":      evasion_counts.get(w.id, 0),
                "stealth":            bool(p.get("stealth", False)),
                "evasion_capable":    bool(p.get("evasion_capable", False)),
            })

        # --- targets_log rows ---
        target_rows = []
        for t in targets:
            p = t.properties
            target_rows.append({
                "id":         t.id,
                "mission_id": mission_id,
                "lat":        p.get("lat"),
                "lon":        p.get("lon"),
                "alt_km":     p.get("alt_km", 0.0),
                "label":      p.get("label", "TARGET"),
                "was_hit":    t.id in hit_target_ids,
            })

        # --- events_log rows (skip high-frequency PHYSICS_TICK and THREAT_DETECTED) ---
        skip_types = {"PHYSICS_TICK", "THREAT_DETECTED", "SPEED_ADJUSTED"}
        event_rows = [
            {
                "mission_id":  mission_id,
                "sim_time_ms": ev["timestamp_ms"],
                "event_type":  ev["event_type"],
                "entity_id":   ev["entity_id"] or None,
                "payload":     ev["payload"] if ev["payload"] else None,
            }
            for ev in evasion_events
            if ev["event_type"] not in skip_types
        ]

        # --- summary stats ---
        n_launched  = len(weapons)
        n_destroyed = sum(1 for w in weapons if w.properties.get("suda_state") == "DESTROYED")
        n_survived  = n_launched - n_destroyed
        n_hit       = len(hit_target_ids)
        duration_s  = event_queue.sim_time_s

        # --- bulk inserts (in parallel where possible) ---
        if weapon_rows:
            await db.table("gl_weapons_log").upsert(weapon_rows).execute()
        if target_rows:
            await db.table("gl_targets_log").upsert(target_rows).execute()
        if event_rows:
            # Supabase has a 2MB payload limit — chunk if needed
            chunk = 500
            for i in range(0, len(event_rows), chunk):
                await db.table("gl_events_log").insert(event_rows[i:i + chunk]).execute()

        # --- update missions row ---
        await db.table("gl_missions").update({
            "status":           "ABORTED" if aborted else "COMPLETED",
            "duration_s":       duration_s,
            "weapons_launched": n_launched,
            "weapons_survived": n_survived,
            "weapons_destroyed":n_destroyed,
            "targets_hit":      n_hit,
            "tot_rms_final":    rms_final,
        }).eq("id", mission_id).execute()

        logger.info(
            "Mission %s persisted — %d weapons, %d targets, %d events",
            mission_id[:8], n_launched, len(target_rows), len(event_rows),
        )

    except Exception as e:
        logger.error("finish_mission failed: %s", e)


# ---------------------------------------------------------------------------
# Telemetry (periodic — called every 10 ticks from _run_physics_tick)
# ---------------------------------------------------------------------------

async def append_telemetry_batch(mission_id: str, rows: list[dict]) -> None:
    db = _db()
    if not db or not rows:
        return
    try:
        await db.table("gl_telemetry").insert(rows).execute()
    except Exception as e:
        logger.error("append_telemetry_batch failed: %s", e)


# ---------------------------------------------------------------------------
# Read helpers (used by GET /missions/* endpoints)
# ---------------------------------------------------------------------------

async def get_missions() -> list[dict]:
    db = _db()
    if not db:
        return []
    res = await db.table("gl_missions").select("*").order("created_at", desc=True).execute()
    return res.data or []


async def get_mission(mission_id: str) -> dict | None:
    db = _db()
    if not db:
        return None
    res = await db.table("gl_missions").select("*").eq("id", mission_id).maybe_single().execute()
    if not res.data:
        return None
    weapons = (await db.table("gl_weapons_log").select("*").eq("mission_id", mission_id).execute()).data or []
    targets = (await db.table("gl_targets_log").select("*").eq("mission_id", mission_id).execute()).data or []
    return {**res.data, "weapons": weapons, "targets": targets}


async def get_mission_events(
    mission_id: str,
    event_type: str | None = None,
    limit: int = 200,
    offset: int = 0,
) -> list[dict]:
    db = _db()
    if not db:
        return []
    q = db.table("gl_events_log").select("*").eq("mission_id", mission_id)
    if event_type:
        q = q.eq("event_type", event_type)
    res = await q.order("sim_time_ms").range(offset, offset + limit - 1).execute()
    return res.data or []


async def get_weapon_telemetry(mission_id: str, weapon_id: str) -> list[dict]:
    db = _db()
    if not db:
        return []
    res = (
        await db.table("gl_telemetry")
        .select("sim_time_ms,lat,lon,alt_km,suda_state,tau_i,speed_mach,fuel_pct")
        .eq("mission_id", mission_id)
        .eq("weapon_id", weapon_id)
        .order("sim_time_ms")
        .execute()
    )
    return res.data or []
