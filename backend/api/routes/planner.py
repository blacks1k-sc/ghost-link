"""
FastAPI route: POST /planner/suggest
Handles AI mission planning requests from the frontend PlannerChat panel.
"""

from __future__ import annotations
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any

from simulation.planner import generate_plan, PlanSuggestion

router = APIRouter(prefix="/planner", tags=["planner"])


class PlanRequest(BaseModel):
    query: str
    context: dict[str, Any] = {}    # optional caller-supplied context (targets, threats, etc.)


class PlanResponse(BaseModel):
    suggested_airbases: list[dict]
    carrier_positions: list[dict]
    tanker_waypoints: list[dict]
    assignments: list[dict]
    routes: list[dict]
    rationale: str
    used_ollama: bool


@router.post("/suggest", response_model=PlanResponse)
async def suggest_plan(body: PlanRequest) -> PlanResponse:
    """
    Generate a mission plan from a natural language query.

    The caller can supply optional context overrides in the `context` field:
      - targets:   list of {id, lat, lon, label}
      - airbases:  list of {id, lat, lon, name}   (overrides world_bases.json)
      - threats:   list of {lat, lon, radius_km}

    If no targets are provided the planner returns an empty plan with an
    explanatory rationale.
    """
    ctx = body.context
    targets = ctx.get("targets", [])
    airbases = ctx.get("airbases", [])
    threat_zones = ctx.get("threats", [])

    try:
        plan: PlanSuggestion = await generate_plan(
            query=body.query,
            targets=targets,
            existing_airbases=airbases,
            threat_zones=threat_zones,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Planner error: {exc}") from exc

    return PlanResponse(
        suggested_airbases=plan.suggested_airbases,
        carrier_positions=plan.carrier_positions,
        tanker_waypoints=plan.tanker_waypoints,
        assignments=plan.assignments,
        routes=plan.routes,
        rationale=plan.rationale,
        used_ollama=plan.used_ollama,
    )
