"""
GHOST-LINK FastAPI Backend
Real-time C2 simulation server with WebSocket entity-change push.
"""

from __future__ import annotations
import asyncio
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

# Load .env before anything else touches os.environ
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Any

from core.entity_graph import EntityGraph, Entity, EntityType, DomainType, RelType
from core.event_queue import EventQueue, EventType
from core.kdtree import SpatialManager
from core import database
from simulation.suda import SudaEngine
from simulation.astar import astar_replan, ThreatRing, Vec3
from api.routes.planner import router as planner_router

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ghost-link")

# ---------------------------------------------------------------------------
# Global simulation state
# ---------------------------------------------------------------------------
graph = EntityGraph()
event_queue = EventQueue()
spatial = SpatialManager()
suda_engine = SudaEngine(graph, event_queue, spatial)

# Active WebSocket connections
websocket_clients: list[WebSocket] = []
_main_loop: asyncio.AbstractEventLoop | None = None

# Simulation control
sim_running = False
sim_speed_multiplier = 1.0
TICK_INTERVAL_MS = 100.0  # 100ms sim-time per tick

# DB persistence state
current_mission_id: str | None = None
_weapon_launch_snapshots: dict[str, dict] = {}  # weapon_id → initial properties
_telemetry_tick_counter: int = 0
_last_rms_error: float = 0.0


# ---------------------------------------------------------------------------
# WebSocket broadcast on entity change
# ---------------------------------------------------------------------------

async def broadcast_entity_change(event_type: str, payload):
    if not websocket_clients:
        return
    if isinstance(payload, Entity):
        msg = json.dumps({"event": event_type, "data": payload.to_dict()})
    elif isinstance(payload, str):
        msg = json.dumps({"event": event_type, "data": {"id": payload}})
    else:
        msg = json.dumps({"event": event_type, "data": payload})

    dead = []
    for ws in websocket_clients:
        try:
            await ws.send_text(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        websocket_clients.remove(ws)


def _sync_notify(event_type: str, payload):
    """Called synchronously from EntityGraph; schedules async broadcast on the main loop."""
    if _main_loop is not None:
        _main_loop.call_soon_threadsafe(
            _main_loop.create_task,
            broadcast_entity_change(event_type, payload),
        )


# ---------------------------------------------------------------------------
# App lifespan — register graph listener on startup
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _main_loop
    _main_loop = asyncio.get_running_loop()
    graph.add_listener(_sync_notify)
    await database.init_db()
    logger.info("GHOST-LINK backend started")
    yield
    logger.info("GHOST-LINK backend shutting down")


app = FastAPI(title="GHOST-LINK C2 Simulation API", version="0.1.0", lifespan=lifespan)

# CORS must be registered BEFORE include_router so it wraps the full ASGI stack.
# Also allow any localhost port so dev servers on :3000/:3001/etc all work.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(planner_router)


# Unhandled 500s bypass CORSMiddleware in Starlette — this handler re-adds the header.
@app.exception_handler(Exception)
async def _unhandled_exception(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled error: %s", exc)
    origin = request.headers.get("origin", "")
    headers = {"Access-Control-Allow-Origin": origin} if origin else {}
    return JSONResponse(
        status_code=500,
        content={"detail": f"Internal server error: {exc}"},
        headers=headers,
    )

# ---------------------------------------------------------------------------
# WebSocket endpoint — real-time entity push
# ---------------------------------------------------------------------------

@app.websocket("/ws/entities")
async def ws_entities(websocket: WebSocket):
    await websocket.accept()
    websocket_clients.append(websocket)
    # Send full graph snapshot on connect
    snapshot = json.dumps({"event": "snapshot", "data": graph.snapshot()})
    await websocket.send_text(snapshot)
    try:
        while True:
            # Keep connection alive; client sends pings
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        websocket_clients.remove(websocket)


# ---------------------------------------------------------------------------
# Entity CRUD endpoints
# ---------------------------------------------------------------------------

class EntityCreate(BaseModel):
    type: str
    domain: str
    properties: dict[str, Any] = {}

class EntityUpdate(BaseModel):
    properties: dict[str, Any]


@app.get("/entities")
def get_entities(entity_type: str | None = None):
    etype = EntityType(entity_type) if entity_type else None
    return [e.to_dict() for e in graph.all_entities(etype)]


@app.get("/entities/{entity_id}")
def get_entity(entity_id: str):
    e = graph.get_entity(entity_id)
    if not e:
        raise HTTPException(404, "Entity not found")
    return e.to_dict()


@app.post("/entities", status_code=201)
def create_entity(body: EntityCreate):
    entity = Entity(
        type=EntityType(body.type),
        domain=DomainType(body.domain),
        properties=body.properties,
    )
    graph.add_entity(entity)
    # Sync to spatial index
    lat = body.properties.get("lat")
    lon = body.properties.get("lon")
    if lat is not None and lon is not None:
        spatial.upsert(entity.id, lat, lon, body.properties.get("alt_km", 0.0))
    return entity.to_dict()


@app.patch("/entities/{entity_id}")
def update_entity(entity_id: str, body: EntityUpdate):
    e = graph.update_entity(entity_id, body.properties)
    if not e:
        raise HTTPException(404, "Entity not found")
    lat = body.properties.get("lat")
    lon = body.properties.get("lon")
    if lat is not None and lon is not None:
        spatial.upsert(entity_id, lat, lon, body.properties.get("alt_km", 0.0))
    return e.to_dict()


@app.delete("/entities/{entity_id}")
def delete_entity(entity_id: str):
    removed = graph.remove_entity(entity_id)
    spatial.remove(entity_id)
    if not removed:
        raise HTTPException(404, "Entity not found")
    return {"deleted": entity_id}


# ---------------------------------------------------------------------------
# Relationship endpoints
# ---------------------------------------------------------------------------

class RelationshipCreate(BaseModel):
    from_id: str
    rel_type: str
    to_id: str


@app.post("/relationships")
def create_relationship(body: RelationshipCreate):
    graph.add_relationship(body.from_id, RelType(body.rel_type), body.to_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Simulation control
# ---------------------------------------------------------------------------

class LaunchRequest(BaseModel):
    sim_speed: float = 1.0
    duration_s: float = 3600.0


@app.post("/simulation/launch")
async def launch_simulation(body: LaunchRequest):
    global sim_running, sim_speed_multiplier, current_mission_id
    global _weapon_launch_snapshots, _telemetry_tick_counter, _last_rms_error
    if sim_running:
        raise HTTPException(400, "Simulation already running")

    import uuid
    mission_id = str(uuid.uuid4())
    current_mission_id = mission_id
    _telemetry_tick_counter = 0
    _last_rms_error = 0.0

    # Snapshot weapon initial positions before sim starts moving them
    _weapon_launch_snapshots = {}
    for w in graph.all_entities(EntityType.WEAPON):
        p = w.properties
        # Resolve launch platform from LAUNCHED_FROM relationship
        platform_rels = graph.query_relationships(w.id, RelType.LAUNCHED_FROM)
        platform_id = platform_rels[0] if platform_rels else None
        # Resolve target label from ASSIGNED_TO relationship
        target_label = None
        target_rels = graph.query_relationships(w.id, RelType.ASSIGNED_TO)
        if target_rels:
            t = graph.get_entity(target_rels[0])
            if t:
                target_label = t.properties.get("label")
        _weapon_launch_snapshots[w.id] = {
            "lat":                p.get("lat"),
            "lon":                p.get("lon"),
            "alt_km":             p.get("alt_km", 10.0),
            "weapon_type":        p.get("weapon_type"),
            "target_lat":         p.get("target_lat"),
            "target_lon":         p.get("target_lon"),
            "target_label":       target_label,
            "launch_platform_id": platform_id,
        }

    await database.create_mission(mission_id, body.sim_speed)

    sim_running = True
    sim_speed_multiplier = body.sim_speed
    event_queue.reset()
    event_queue.push(EventType.SIMULATION_START, timestamp_ms=0.0, priority=0)
    event_queue.schedule_recurring_tick(
        interval_ms=TICK_INTERVAL_MS,
        end_ms=body.duration_s * 1000,
    )
    asyncio.ensure_future(_simulation_loop())
    await broadcast_entity_change("sim_status", {"running": True, "sim_time_s": 0.0})
    return {"status": "launched", "sim_speed": body.sim_speed, "mission_id": mission_id}


@app.post("/simulation/stop")
async def stop_simulation():
    global sim_running
    sim_running = False
    if current_mission_id:
        await database.finish_mission(
            current_mission_id, graph, event_queue,
            _weapon_launch_snapshots, _last_rms_error, aborted=True,
        )
    await broadcast_entity_change("sim_status", {"running": False, "sim_time_s": event_queue.sim_time_s})
    return {"status": "stopped"}


@app.get("/simulation/status")
def simulation_status():
    return {
        "running": sim_running,
        "sim_time_s": event_queue.sim_time_s,
        "queue_size": event_queue.size(),
        "active_weapons": len([e for e in graph.all_entities(EntityType.WEAPON)
                                if e.properties.get("suda_state") not in ("DESTROYED", "IMPACTED")]),
    }


# ---------------------------------------------------------------------------
# Simulation loop
# ---------------------------------------------------------------------------

async def _simulation_loop():
    global sim_running
    wall_tick_s = TICK_INTERVAL_MS / 1000.0 / sim_speed_multiplier

    while sim_running:
        until_ms = event_queue.sim_time_ms + TICK_INTERVAL_MS
        events = event_queue.pop_until(until_ms)

        for event in events:
            if event.event_type == EventType.SIMULATION_END:
                sim_running = False
                break
            if event.event_type == EventType.PHYSICS_TICK:
                await _run_physics_tick()
            elif event.event_type == EventType.TOT_UPDATED:
                suda_engine.greedy_interval_schedule(event_queue.sim_time_ms)
            elif event.event_type == EventType.EVASION_END:
                _handle_evasion_end(event.entity_id)

        if not events or not sim_running:
            break

        await asyncio.sleep(wall_tick_s)

    sim_running = False
    logger.info("Simulation complete at T+%.1fs", event_queue.sim_time_s)
    await broadcast_entity_change("sim_status", {"running": False, "sim_time_s": event_queue.sim_time_s})

    if current_mission_id:
        await database.finish_mission(
            current_mission_id, graph, event_queue,
            _weapon_launch_snapshots, _last_rms_error, aborted=False,
        )


async def _run_physics_tick():
    """
    Physics tick: update all weapon positions via Rust engine,
    then run SUDA loop.
    """
    global _last_rms_error, _telemetry_tick_counter
    sim_time_ms = event_queue.sim_time_ms
    weapons = graph.all_entities(EntityType.WEAPON)

    # Try to use Rust engine; fall back to pure-Python if not compiled yet
    try:
        import ghost_engine  # type: ignore
        weapon_dicts = []
        for w in weapons:
            p = w.properties
            if p.get("suda_state") in ("DESTROYED", "IMPACTED"):
                continue
            weapon_dicts.append({
                "id": int(w.id.replace("-", ""), 16) & 0xFFFFFFFFFFFFFFFF,
                "lat": p.get("lat", 0.0),
                "lon": p.get("lon", 0.0),
                "alt_km": p.get("alt_km", 10.0),
                "heading_deg": p.get("heading_deg", 0.0),
                "speed_mach": p.get("speed_mach", 0.8),
                "speed_max_mach": p.get("speed_max_mach", 0.9),
                "speed_min_mach": p.get("speed_min_mach", 0.5),
                "fuel_pct": p.get("fuel_pct", 1.0),
                "fuel_burn_rate": p.get("fuel_burn_rate", 0.0005),
                "domain": {"AIR": 0, "SEA": 1, "LAND": 2}.get(p.get("domain", "AIR"), 0),
                "tau_i": p.get("tau_i", 0.0),
                "suda_state": {"CRUISE": 0, "EVADING": 1, "REALIGNING": 2, "TERMINAL": 3, "DESTROYED": 4}.get(p.get("suda_state", "CRUISE"), 0),
                "evasion_timer_s": p.get("evasion_timer_s", 0.0),
                "evasion_g": p.get("evasion_g", 0.0),
                "evasion_lateral_offset": p.get("evasion_lateral_offset", 0.0),
                "target_lat": p.get("target_lat", 0.0),
                "target_lon": p.get("target_lon", 0.0),
                "alt_km_target": p.get("alt_km_target", 0.0),
            })

        dt_s = TICK_INTERVAL_MS / 1000.0
        updated = ghost_engine.tick_weapons(weapon_dicts, dt_s)
        # Write back physics results to entity graph
        for i, w in enumerate(weapons):
            if i < len(updated):
                upd = updated[i]
                graph.update_entity(w.id, {
                    "lat": upd["lat"],
                    "lon": upd["lon"],
                    "alt_km": upd["alt_km"],
                    "heading_deg": upd["heading_deg"],
                    "fuel_pct": upd["fuel_pct"],
                    "tau_i": upd["tau_i"],
                    "suda_state": ["CRUISE", "EVADING", "REALIGNING", "TERMINAL", "DESTROYED", "IMPACTED"][upd["suda_state"]],
                })
                spatial.upsert(w.id, upd["lat"], upd["lon"], upd["alt_km"])

                if upd["suda_state"] == 4:  # DESTROYED
                    suda_engine.handle_weapon_destroyed(w.id, sim_time_ms)

        # ToT consensus tick — distributed convergence (Rust TotEngine)
        alive_weapons = [w for w in weapons if w.properties.get("suda_state") not in ("DESTROYED", "IMPACTED")]
        if len(alive_weapons) >= 2:
            consensus_inputs = []
            id_map: dict[int, str] = {}
            for w in alive_weapons:
                p = w.properties
                lat, lon = p.get("lat", 0.0), p.get("lon", 0.0)
                tlat, tlon = p.get("target_lat", lat), p.get("target_lon", lon)
                dist_km = _haversine_py(lat, lon, tlat, tlon)
                speed_kmps = p.get("speed_mach", 0.8) * 0.299
                tau_nom = dist_km / speed_kmps if speed_kmps > 0 else 0.0
                seq_id = int(w.id.replace("-", ""), 16) & 0xFFFFFFFFFFFFFFFF
                id_map[seq_id] = w.id
                consensus_inputs.append({
                    "id": seq_id,
                    "lat": lat,
                    "lon": lon,
                    "tau_i": p.get("tau_i", 0.0),
                    "tau_nom": tau_nom,
                    "speed_mach": p.get("speed_mach", 0.8),
                    "alive": True,
                })
            consensus_results, rms_error = ghost_engine.tick_consensus(
                consensus_inputs, dt_s, 0.1, 0.05, 500.0
            )
            for r in consensus_results:
                wid = id_map.get(r["id"])
                if wid:
                    graph.update_entity(wid, {"tau_i": r["tau_i"]})
            _last_rms_error = rms_error
            await broadcast_entity_change("tot_rms", {"rms_error_s": rms_error})

        # Telemetry snapshot + sim_time broadcast — every 10 ticks (= 1s sim-time)
        global _telemetry_tick_counter
        _telemetry_tick_counter += 1
        if _telemetry_tick_counter % 10 == 0:
            await broadcast_entity_change("sim_time", {"time_s": event_queue.sim_time_s})
        if current_mission_id and _telemetry_tick_counter % 10 == 0:
                telemetry_rows = []
                for w in alive_weapons:
                    p = w.properties
                    telemetry_rows.append({
                        "mission_id":  current_mission_id,
                        "weapon_id":   w.id,
                        "sim_time_ms": sim_time_ms,
                        "lat":         p.get("lat"),
                        "lon":         p.get("lon"),
                        "alt_km":      p.get("alt_km"),
                        "suda_state":  p.get("suda_state"),
                        "tau_i":       p.get("tau_i"),
                        "speed_mach":  p.get("speed_mach"),
                        "fuel_pct":    p.get("fuel_pct"),
                    })
                if telemetry_rows:
                    asyncio.ensure_future(
                        database.append_telemetry_batch(current_mission_id, telemetry_rows)
                    )

    except ImportError:
        # Rust engine not compiled yet — pure Python fallback
        _python_physics_fallback(weapons, TICK_INTERVAL_MS / 1000.0)

    # SUDA loop — runs after physics tick updates positions
    suda_engine.tick(sim_time_ms)


def _python_physics_fallback(weapons, dt_s: float):
    """
    Pure Python physics fallback (used before Rust engine is compiled).
    Less accurate but allows development without Rust toolchain.
    """
    import math
    R = 6371.0
    for w in weapons:
        p = w.properties
        if p.get("suda_state") in ("DESTROYED", "IMPACTED"):
            continue
        lat, lon = p.get("lat", 0.0), p.get("lon", 0.0)
        tlat, tlon = p.get("target_lat", lat), p.get("target_lon", lon)
        speed_mach = p.get("speed_mach", 0.8)
        speed_kmps = speed_mach * 0.299
        dist_km = _haversine_py(lat, lon, tlat, tlon)
        if dist_km < speed_kmps * dt_s:
            graph.update_entity(w.id, {"suda_state": "IMPACTED", "lat": tlat, "lon": tlon})
            continue
        bearing_rad = _bearing_py(lat, lon, tlat, tlon)
        d = speed_kmps * dt_s
        ang = d / R
        lat_r, lon_r = math.radians(lat), math.radians(lon)
        new_lat = math.asin(math.sin(lat_r) * math.cos(ang) + math.cos(lat_r) * math.sin(ang) * math.cos(bearing_rad))
        new_lon = lon_r + math.atan2(math.sin(bearing_rad) * math.sin(ang) * math.cos(lat_r), math.cos(ang) - math.sin(lat_r) * math.sin(new_lat))
        graph.update_entity(w.id, {
            "lat": math.degrees(new_lat),
            "lon": math.degrees(new_lon),
            "tau_i": max(0.0, p.get("tau_i", 0.0) - dt_s),
        })
        spatial.upsert(w.id, math.degrees(new_lat), math.degrees(new_lon), p.get("alt_km", 10.0))


def _haversine_py(lat1, lon1, lat2, lon2):
    import math
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _bearing_py(lat1, lon1, lat2, lon2):
    import math
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlam = math.radians(lon2 - lon1)
    y = math.sin(dlam) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlam)
    return math.atan2(y, x)


def _handle_evasion_end(weapon_id: str):
    weapon = graph.get_entity(weapon_id)
    if not weapon or weapon.properties.get("suda_state") != "EVADING":
        return

    graph.update_entity(weapon_id, {
        "suda_state": "REALIGNING",
        "evasion_timer_s": 0.0,
    })
    event_queue.push_now(EventType.REALIGN_START, entity_id=weapon_id)

    props = weapon.properties
    current = Vec3(
        lat=props.get("lat", 0.0),
        lon=props.get("lon", 0.0),
        alt_km=props.get("alt_km", 10.0),
    )
    target = Vec3(
        lat=props.get("target_lat", props.get("lat", 0.0)),
        lon=props.get("target_lon", props.get("lon", 0.0)),
        alt_km=props.get("alt_km_target", 0.0),
    )

    active_threats = [
        ThreatRing(
            lat=t.properties.get("lat", 0.0),
            lon=t.properties.get("lon", 0.0),
            radius_km=t.properties.get("radius_km", 100.0),
        )
        for t in graph.all_entities(EntityType.THREAT)
    ]

    waypoints = astar_replan(current, target, active_threats)
    graph.update_entity(weapon_id, {
        "route_waypoints": [[wp.lat, wp.lon, wp.alt_km] for wp in waypoints],
    })


# ---------------------------------------------------------------------------
# Threat injection endpoint (used by frontend right-click)
# ---------------------------------------------------------------------------

class ThreatInject(BaseModel):
    lat: float
    lon: float
    threat_type: str   # "SAM" | "INTERCEPTOR_AIRCRAFT" | "TURBULENCE" | "EW_JAMMING"
    radius_km: float = 100.0
    p_intercept_base: float = 0.7
    label: str = "Injected Threat"
    threat_system: str = ""  # e.g. "s400", "patriot_pac3"


@app.post("/threats/inject", status_code=201)
def inject_threat(body: ThreatInject):
    threat = Entity(
        type=EntityType.THREAT,
        domain=DomainType.LAND,
        properties={
            "lat": body.lat,
            "lon": body.lon,
            "threat_type": body.threat_type,
            "radius_km": body.radius_km,
            "p_intercept_base": body.p_intercept_base,
            "label": body.label,
            "threat_system": body.threat_system,
        },
    )
    graph.add_entity(threat)
    spatial.upsert(threat.id, body.lat, body.lon, 0.0)
    event_queue.push_now(
        EventType.THREAT_INJECTED,
        entity_id=threat.id,
        payload={"lat": body.lat, "lon": body.lon, "type": body.threat_type},
        priority=2,
    )
    return threat.to_dict()


# ---------------------------------------------------------------------------
# Weapons database endpoint
# ---------------------------------------------------------------------------

@app.get("/weapons/catalog")
def get_weapons_catalog():
    catalog_path = Path(__file__).parent / "data" / "weapons.json"
    if not catalog_path.exists():
        raise HTTPException(404, "Weapons catalog not found")
    with open(catalog_path) as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Mission history endpoints (reads from Supabase)
# ---------------------------------------------------------------------------

@app.get("/missions")
async def list_missions():
    return await database.get_missions()


@app.get("/missions/{mission_id}")
async def get_mission(mission_id: str):
    result = await database.get_mission(mission_id)
    if not result:
        raise HTTPException(404, "Mission not found")
    return result


@app.get("/missions/{mission_id}/events")
async def get_mission_events(
    mission_id: str,
    event_type: str | None = None,
    limit: int = 200,
    offset: int = 0,
):
    return await database.get_mission_events(mission_id, event_type, limit, offset)


@app.get("/missions/{mission_id}/telemetry/{weapon_id}")
async def get_weapon_telemetry(mission_id: str, weapon_id: str):
    return await database.get_weapon_telemetry(mission_id, weapon_id)


# ---------------------------------------------------------------------------
# Saturation coefficient endpoint
# ---------------------------------------------------------------------------

@app.get("/saturation")
def get_saturation():
    """
    Run Monte Carlo saturation analysis over current entity state.
    Returns SC mean, penetration rate percentiles.
    """
    try:
        import ghost_engine  # type: ignore
    except ImportError:
        return {
            "error": "Rust engine not compiled",
            "sc_mean": 0.0,
            "penetration_rate_mean": 0.5,
            "penetration_rate_p10": 0.3,
            "penetration_rate_p50": 0.5,
            "penetration_rate_p90": 0.7,
            "trials_run": 0,
        }

    alive_weapons = [
        w for w in graph.all_entities(EntityType.WEAPON)
        if w.properties.get("suda_state") not in ("DESTROYED", "IMPACTED")
    ]
    threats = list(graph.all_entities(EntityType.THREAT))

    if not alive_weapons:
        return {
            "sc_mean": 0.0, "penetration_rate_mean": 1.0,
            "penetration_rate_p10": 1.0, "penetration_rate_p50": 1.0,
            "penetration_rate_p90": 1.0, "trials_run": 0,
        }

    n_attacking = len(alive_weapons)
    # Each threat battery: (n_interceptors=1, p_kill_base)
    batteries = [(1, float(t.properties.get("p_intercept_base") or 0.7)) for t in threats] or [(0, 0.0)]
    weapon_evasion_p = [0.3 if w.properties.get("evasion_capable") else 0.0 for w in alive_weapons]
    weapon_stealth = [0.5 if w.properties.get("stealth") else 1.0 for w in alive_weapons]

    return ghost_engine.run_saturation_monte_carlo(
        n_attacking, batteries, weapon_evasion_p, weapon_stealth, 1000
    )


# ---------------------------------------------------------------------------
# Graph snapshot endpoint (for debugging)
# ---------------------------------------------------------------------------

@app.get("/graph/snapshot")
def graph_snapshot():
    return graph.snapshot()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
