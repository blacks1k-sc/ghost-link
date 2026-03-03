"use client";

/**
 * CesiumGlobe — Main 3D globe component
 * Renders all entities as Cesium primitives, handles click + right-click.
 *
 * Entity icon colors:
 *   Weapons: blue (AIR) | gray (SEA) | green (LAND)
 *   Targets: red bullseye
 *   Threats: red pulsing ring
 *   Airbases: yellow triangle
 *   Carriers: cyan ship
 *   Tankers: white diamond
 */

import { useEffect, useRef, useCallback } from "react";
import { useEntityGraph, Entity } from "@/stores/entityGraph";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// Colors by entity type + domain
const WEAPON_COLORS: Record<string, string> = {
  AIR: "#3b82f6",   // blue
  SEA: "#94a3b8",   // slate
  LAND: "#22c55e",  // green
};

const SUDA_COLORS: Record<string, string> = {
  CRUISE: "#3b82f6",
  EVADING: "#eab308",
  REALIGNING: "#f97316",
  TERMINAL: "#ef4444",
  DESTROYED: "#6b7280",
  IMPACTED: "#10b981",
};

interface Props {
  mode: "planning" | "live";
  onEntitySelect: (id: string | null) => void;
  selectedEntityId: string | null;
}

export default function CesiumGlobe({ mode, onEntitySelect, selectedEntityId }: Props) {
  const viewerRef = useRef<unknown>(null);
  const entityRefs = useRef<Map<string, unknown>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  const { entities, getWeapons, getTargets, getThreats, getAirbases } = useEntityGraph();

  // ---------------------------------------------------------------------------
  // Initialize Cesium
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return;

    // Dynamic import to avoid SSR
    import("cesium").then((Cesium) => {
      // Set Cesium Ion token (set via env or use the community token)
      Cesium.Ion.defaultAccessToken =
        process.env.NEXT_PUBLIC_CESIUM_TOKEN ??
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI0OGE0ZjU1YS05NTZiLTRlNmMtOTFiYy1lY2ZhNzVhZWM4YTAiLCJpZCI6MjYwMzAzLCJpYXQiOjE3MzM5NjA5OTB9.placeholder";

      const viewer = new Cesium.Viewer(containerRef.current!, {
        animation: false,
        baseLayerPicker: false,
        fullscreenButton: false,
        geocoder: false,
        homeButton: false,
        infoBox: false,
        sceneModePicker: false,
        selectionIndicator: false,
        timeline: false,
        navigationHelpButton: false,
        skyBox: false,
        skyAtmosphere: false,
        // Dark imagery — use Cesium World Imagery or fallback to OpenStreetMap
        imageryProvider: new Cesium.TileMapServiceImageryProvider({
          url: Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII"),
        }),
      });

      // Dark scene settings
      viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#050a12");
      viewer.scene.fog.enabled = false;
      viewer.scene.globe.enableLighting = false;
      viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#0a1628");

      viewerRef.current = viewer;

      // Click handler — select entity
      const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      clickHandler.setInputAction((click: { position: unknown }) => {
        const picked = viewer.scene.pick(click.position as Cesium.Cartesian2);
        if (Cesium.defined(picked) && picked.id) {
          const entityId = (picked.id as { name?: string }).name;
          if (entityId) onEntitySelect(entityId);
        } else {
          if (mode === "planning") {
            // Place target on click
            const cartesian = viewer.camera.pickEllipsoid(
              click.position as Cesium.Cartesian2,
              viewer.scene.globe.ellipsoid,
            );
            if (cartesian) {
              const carto = Cesium.Cartographic.fromCartesian(cartesian);
              const lat = Cesium.Math.toDegrees(carto.latitude);
              const lon = Cesium.Math.toDegrees(carto.longitude);
              placeTarget(lat, lon);
            }
          }
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      // Right-click → inject threat (in live mode)
      clickHandler.setInputAction((click: { position: unknown }) => {
        if (mode !== "live") return;
        const cartesian = viewer.camera.pickEllipsoid(
          click.position as Cesium.Cartesian2,
          viewer.scene.globe.ellipsoid,
        );
        if (cartesian) {
          const carto = Cesium.Cartographic.fromCartesian(cartesian);
          showThreatMenu(
            Cesium.Math.toDegrees(carto.latitude),
            Cesium.Math.toDegrees(carto.longitude),
            click.position as { x: number; y: number },
          );
        }
      }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
    });

    return () => {
      if (viewerRef.current) {
        (viewerRef.current as { destroy?: () => void }).destroy?.();
        viewerRef.current = null;
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Place target on map click
  // ---------------------------------------------------------------------------
  const placeTarget = useCallback(async (lat: number, lon: number) => {
    await fetch(`${API}/entities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "TARGET",
        domain: "LAND",
        properties: { lat, lon, alt_km: 0, label: `Target ${Date.now()}` },
      }),
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Threat injection context menu
  // ---------------------------------------------------------------------------
  const showThreatMenu = useCallback(
    (lat: number, lon: number, screenPos: { x: number; y: number }) => {
      // Remove existing menu
      contextMenuRef.current?.remove();

      const menu = document.createElement("div");
      menu.className =
        "absolute z-50 bg-gray-900 border border-gray-600 rounded shadow-lg py-1 text-sm font-mono";
      menu.style.left = `${screenPos.x}px`;
      menu.style.top = `${screenPos.y}px`;

      const threats = [
        { label: "SAM Battery", type: "SAM", radius: 100, p: 0.75 },
        { label: "Enemy Aircraft", type: "INTERCEPTOR_AIRCRAFT", radius: 150, p: 0.6 },
        { label: "Turbulence Zone", type: "TURBULENCE", radius: 80, p: 1.0 },
        { label: "EW Jammer", type: "EW_JAMMING", radius: 200, p: 1.0 },
      ];

      threats.forEach(({ label, type, radius, p }) => {
        const btn = document.createElement("button");
        btn.className = "block w-full text-left px-4 py-1.5 hover:bg-gray-700 text-red-300";
        btn.textContent = `⚡ ${label}`;
        btn.onclick = async () => {
          await fetch(`${API}/threats/inject`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              lat,
              lon,
              threat_type: type,
              radius_km: radius,
              p_intercept_base: p,
              label,
            }),
          });
          menu.remove();
        };
        menu.appendChild(btn);
      });

      const cancel = document.createElement("button");
      cancel.className = "block w-full text-left px-4 py-1.5 hover:bg-gray-700 text-gray-400";
      cancel.textContent = "Cancel";
      cancel.onclick = () => menu.remove();
      menu.appendChild(cancel);

      containerRef.current?.appendChild(menu);
      contextMenuRef.current = menu;

      // Dismiss on outside click
      const dismiss = (e: MouseEvent) => {
        if (!menu.contains(e.target as Node)) {
          menu.remove();
          document.removeEventListener("click", dismiss);
        }
      };
      setTimeout(() => document.addEventListener("click", dismiss), 0);
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Sync entities to Cesium on every store change
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const viewer = viewerRef.current as {
      entities?: {
        getById: (id: string) => unknown;
        add: (opts: unknown) => unknown;
        remove: (e: unknown) => void;
      };
    } | null;
    if (!viewer?.entities) return;

    import("cesium").then((Cesium) => {
      const currentIds = new Set(Object.keys(entities));

      // Remove entities no longer in store
      for (const [id, cesiumEntity] of entityRefs.current.entries()) {
        if (!currentIds.has(id)) {
          viewer.entities!.remove(cesiumEntity);
          entityRefs.current.delete(id);
        }
      }

      // Upsert all entities
      for (const entity of Object.values(entities)) {
        upsertCesiumEntity(Cesium, viewer as unknown as { entities: Cesium.EntityCollection }, entity);
      }
    });
  }, [entities]);

  const upsertCesiumEntity = (
    Cesium: typeof import("cesium"),
    viewer: { entities: Cesium.EntityCollection },
    entity: Entity,
  ) => {
    const { lat, lon, alt_km = 0 } = entity.properties as {
      lat?: number;
      lon?: number;
      alt_km?: number;
    };
    if (lat == null || lon == null) return;

    const pos = Cesium.Cartesian3.fromDegrees(lon, lat, (alt_km as number) * 1000);
    const existing = entityRefs.current.get(entity.id) as Cesium.Entity | undefined;

    if (existing) {
      // Update position
      (existing.position as Cesium.ConstantPositionProperty).setValue(pos);
      // Update color for weapons based on SUDA state
      if (entity.type === "WEAPON" && existing.billboard) {
        const suda = (entity.properties as { suda_state?: string }).suda_state ?? "CRUISE";
        existing.billboard.color = new Cesium.ConstantProperty(
          Cesium.Color.fromCssColorString(SUDA_COLORS[suda] ?? "#3b82f6"),
        );
      }
      return;
    }

    // Create new Cesium entity
    let cesiumEntity: Cesium.Entity | undefined;

    switch (entity.type) {
      case "WEAPON": {
        const suda = (entity.properties as { suda_state?: string }).suda_state ?? "CRUISE";
        const color = Cesium.Color.fromCssColorString(SUDA_COLORS[suda] ?? "#3b82f6");
        cesiumEntity = viewer.entities.add({
          name: entity.id,
          position: pos,
          billboard: {
            image: getWeaponSvg(entity.domain),
            width: 20,
            height: 20,
            color,
            heightReference: Cesium.HeightReference.NONE,
          },
          label: {
            text: (entity.properties as { weapon_type?: string }).weapon_type ?? "WEAPON",
            font: "10px monospace",
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -18),
            show: false, // show on selection
          },
        });
        break;
      }

      case "TARGET":
        cesiumEntity = viewer.entities.add({
          name: entity.id,
          position: pos,
          billboard: {
            image: getTargetSvg(),
            width: 24,
            height: 24,
            color: Cesium.Color.fromCssColorString("#ef4444"),
          },
          label: {
            text: (entity.properties as { label?: string }).label ?? "TARGET",
            font: "10px monospace",
            fillColor: Cesium.Color.RED,
            pixelOffset: new Cesium.Cartesian2(0, -20),
          },
        });
        break;

      case "THREAT": {
        const radiusKm = (entity.properties as { radius_km?: number }).radius_km ?? 100;
        cesiumEntity = viewer.entities.add({
          name: entity.id,
          position: pos,
          ellipse: {
            semiMajorAxis: radiusKm * 1000,
            semiMinorAxis: radiusKm * 1000,
            material: Cesium.Color.fromCssColorString("#ef4444").withAlpha(0.12),
            outline: true,
            outlineColor: Cesium.Color.fromCssColorString("#ef4444").withAlpha(0.7),
            outlineWidth: 1.5,
          },
          billboard: {
            image: getThreatSvg(),
            width: 18,
            height: 18,
            color: Cesium.Color.fromCssColorString("#ef4444"),
          },
        });
        break;
      }

      case "AIRBASE":
        cesiumEntity = viewer.entities.add({
          name: entity.id,
          position: pos,
          billboard: {
            image: getAirbaseSvg(),
            width: 16,
            height: 16,
            color: Cesium.Color.fromCssColorString("#eab308"),
          },
        });
        break;

      case "CARRIER":
        cesiumEntity = viewer.entities.add({
          name: entity.id,
          position: pos,
          billboard: {
            image: getCarrierSvg(),
            width: 18,
            height: 18,
            color: Cesium.Color.fromCssColorString("#22d3ee"),
          },
        });
        break;
    }

    if (cesiumEntity) {
      entityRefs.current.set(entity.id, cesiumEntity);
    }
  };

  return (
    <div ref={containerRef} className="w-full h-full" />
  );
}

// ---------------------------------------------------------------------------
// SVG icon generators (inline data URIs — no external asset files needed)
// ---------------------------------------------------------------------------

function svgUri(svg: string) {
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function getWeaponSvg(domain: string) {
  const color = WEAPON_COLORS[domain] ?? "#3b82f6";
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${color}">
    <polygon points="12,2 22,22 12,17 2,22" />
  </svg>`);
}

function getTargetSvg() {
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke="#ef4444" fill="none" stroke-width="2">
    <circle cx="12" cy="12" r="10"/>
    <circle cx="12" cy="12" r="4"/>
    <line x1="12" y1="2" x2="12" y2="7"/>
    <line x1="12" y1="17" x2="12" y2="22"/>
    <line x1="2" y1="12" x2="7" y2="12"/>
    <line x1="17" y1="12" x2="22" y2="12"/>
  </svg>`);
}

function getThreatSvg() {
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ef4444">
    <polygon points="12,2 22,20 2,20" />
    <text x="12" y="18" text-anchor="middle" font-size="10" fill="white">!</text>
  </svg>`);
}

function getAirbaseSvg() {
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#eab308">
    <polygon points="12,2 22,22 2,22" />
  </svg>`);
}

function getCarrierSvg() {
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#22d3ee">
    <rect x="3" y="12" width="18" height="8" rx="2"/>
    <rect x="8" y="8" width="10" height="4"/>
    <line x1="6" y1="12" x2="6" y2="20" stroke="#22d3ee" stroke-width="1"/>
  </svg>`);
}
