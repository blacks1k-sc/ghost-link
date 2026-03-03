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

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Any

from core.entity_graph import EntityGraph, Entity, EntityType, DomainType, RelType
from core.event_queue import EventQueue, EventType
from core.kdtree import SpatialManager
from simulation.suda import SudaEngine
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

# Simulation control
sim_running = False
sim_speed_multiplier = 1.0
TICK_INTERVAL_MS = 100.0  # 100ms sim-time per tick


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
    """Called synchronously from EntityGraph; schedules async broadcast."""
    asyncio.get_event_loop().call_soon_threadsafe(
        lambda: asyncio.ensure_future(broadcast_entity_change(event_type, payload))
    )


# ---------------------------------------------------------------------------
# App lifespan — register graph listener on startup
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    graph.add_listener(_sync_notify)
    logger.info("GHOST-LINK backend started")
    yield
    logger.info("GHOST-LINK backend shutting down")


app = FastAPI(title="GHOST-LINK C2 Simulation API", version="0.1.0", lifespan=lifespan)

app.include_router(planner_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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
    global sim_running, sim_speed_multiplier
    if sim_running:
        raise HTTPException(400, "Simulation already running")
    sim_running = True
    sim_speed_multiplier = body.sim_speed
    event_queue.reset()
    event_queue.push(EventType.SIMULATION_START, timestamp_ms=0.0, priority=0)
    event_queue.schedule_recurring_tick(
        interval_ms=TICK_INTERVAL_MS,
        end_ms=body.duration_s * 1000,
    )
    asyncio.ensure_future(_simulation_loop())
    return {"status": "launched", "sim_speed": body.sim_speed}


@app.post("/simulation/stop")
def stop_simulation():
    global sim_running
    sim_running = False
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
            elif event.event_type == EventType.EVASION_END:
                _handle_evasion_end(event.entity_id)

        if not events or not sim_running:
            break

        await asyncio.sleep(wall_tick_s)

    sim_running = False
    logger.info("Simulation complete at T+%.1fs", event_queue.sim_time_s)


async def _run_physics_tick():
    """
    Physics tick: update all weapon positions via Rust engine,
    then run SUDA loop.
    """
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

        updated = ghost_engine.tick_weapons(weapon_dicts, TICK_INTERVAL_MS / 1000.0)
        # Write back to entity graph
        weapon_by_seq = {w.id: w for w in weapons}
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
    if weapon and weapon.properties.get("suda_state") == "EVADING":
        graph.update_entity(weapon_id, {
            "suda_state": "REALIGNING",
            "evasion_timer_s": 0.0,
        })
        event_queue.push_now(EventType.REALIGN_START, entity_id=weapon_id)


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
# Graph snapshot endpoint (for debugging)
# ---------------------------------------------------------------------------

@app.get("/graph/snapshot")
def graph_snapshot():
    return graph.snapshot()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
