/**
 * Entity Graph Store (Zustand)
 * Mirrors the backend entity graph on the frontend.
 * Updated via WebSocket entity-change events (upsert / remove / snapshot).
 *
 * This is the single source of truth for all simulation entities on the frontend.
 */

import { create } from "zustand";

// ---------------------------------------------------------------------------
// Types (mirror backend entity_graph.py)
// ---------------------------------------------------------------------------

export type EntityType =
  | "WEAPON"
  | "TARGET"
  | "THREAT"
  | "TANKER"
  | "AIRBASE"
  | "CARRIER"
  | "SATELLITE";

export type DomainType = "AIR" | "SEA" | "LAND" | "SPACE" | "CYBER";

export type SudaState =
  | "CRUISE"
  | "EVADING"
  | "REALIGNING"
  | "TERMINAL"
  | "DESTROYED"
  | "IMPACTED";

export interface Entity {
  id: string;
  type: EntityType;
  domain: DomainType;
  properties: Record<string, unknown>;
}

export interface SimEvent {
  timestamp_ms: number;
  event_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

interface ImpactFlash {
  id: string;           // unique flash id
  weaponLabel: string;
}

interface EntityGraphState {
  entities: Record<string, Entity>;
  eventLog: SimEvent[];
  simRunning: boolean;
  simTimeS: number;
  wsConnected: boolean;
  impactFlashes: ImpactFlash[];

  // Actions
  upsertEntity: (entity: Entity) => void;
  removeEntity: (id: string) => void;
  clearImpactFlash: (id: string) => void;
  applySnapshot: (snapshot: { entities: Record<string, Entity> }) => void;
  appendEvent: (event: SimEvent) => void;
  setSimRunning: (running: boolean) => void;
  setSimTime: (t: number) => void;
  setWsConnected: (connected: boolean) => void;

  // Selectors (derived state helpers)
  getWeapons: () => Entity[];
  getTargets: () => Entity[];
  getThreats: () => Entity[];
  getAirbases: () => Entity[];
  getCarriers: () => Entity[];
  getEntity: (id: string) => Entity | undefined;
}

export const useEntityGraph = create<EntityGraphState>((set, get) => ({
  entities: {},
  eventLog: [],
  simRunning: false,
  simTimeS: 0,
  wsConnected: false,
  impactFlashes: [],

  upsertEntity: (entity) =>
    set((state) => {
      const prev = state.entities[entity.id];
      const newState = entity.properties.suda_state as string | undefined;
      const prevState = prev?.properties.suda_state as string | undefined;
      const justImpacted = entity.type === "WEAPON"
        && newState === "IMPACTED"
        && prevState !== "IMPACTED";

      const flash: ImpactFlash | null = justImpacted ? {
        id: `flash-${entity.id}-${Date.now()}`,
        weaponLabel: (entity.properties.label as string)
          || (entity.properties.weapon_type as string)
          || "WEAPON",
      } : null;

      return {
        entities: { ...state.entities, [entity.id]: entity },
        impactFlashes: flash
          ? [...state.impactFlashes, flash]
          : state.impactFlashes,
      };
    }),

  removeEntity: (id) =>
    set((state) => {
      const next = { ...state.entities };
      delete next[id];
      return { entities: next };
    }),

  applySnapshot: (snapshot) =>
    set({ entities: snapshot.entities ?? {} }),

  appendEvent: (event) =>
    set((state) => ({
      // Keep last 500 events
      eventLog: [event, ...state.eventLog].slice(0, 500),
    })),

  clearImpactFlash: (id) =>
    set((state) => ({
      impactFlashes: state.impactFlashes.filter((f) => f.id !== id),
    })),

  setSimRunning: (running) => set({ simRunning: running }),
  setSimTime: (t) => set({ simTimeS: t }),
  setWsConnected: (connected) => set({ wsConnected: connected }),

  // Selectors
  getWeapons: () =>
    Object.values(get().entities).filter((e) => e.type === "WEAPON"),
  getTargets: () =>
    Object.values(get().entities).filter((e) => e.type === "TARGET"),
  getThreats: () =>
    Object.values(get().entities).filter((e) => e.type === "THREAT"),
  getAirbases: () =>
    Object.values(get().entities).filter((e) => e.type === "AIRBASE"),
  getCarriers: () =>
    Object.values(get().entities).filter((e) => e.type === "CARRIER"),
  getEntity: (id) => get().entities[id],
}));
