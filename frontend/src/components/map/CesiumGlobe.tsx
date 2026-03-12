"use client";

import type * as CesiumType from "cesium";
import { useEffect, useRef, useCallback } from "react";
import { useEntityGraph, Entity } from "@/stores/entityGraph";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

const WEAPON_COLORS: Record<string, string> = {
  AIR: "#3b82f6",
  SEA: "#94a3b8",
  LAND: "#22c55e",
};

const SUDA_COLORS: Record<string, string> = {
  CRUISE: "#3b82f6",
  EVADING: "#eab308",
  REALIGNING: "#f97316",
  TERMINAL: "#ef4444",
  DESTROYED: "#6b7280",
  IMPACTED: "#10b981",
};

interface PendingWeapon {
  name: string;
  domain: string;
  speed_mach: number;
  cruise_altitude_m: [number, number];
  stealth: boolean;
  evasion_capable: boolean;
}

interface PlanHighlights {
  airbases: Array<{ id: string; name: string; lat: number; lon: number }>;
  carriers: Array<{ lat: number; lon: number; label: string }>;
  routes: Array<{
    weapon_type: string;
    waypoints: Array<{ lat: number; lon: number; label: string }>;
    total_dist_km: number;
    total_time_s: number;
  }>;
}

// Distinct neon colors cycled per route
const ROUTE_COLORS = [
  "#f97316", // orange
  "#a855f7", // purple
  "#06b6d4", // cyan
  "#84cc16", // lime
  "#f43f5e", // rose
  "#fbbf24", // amber
  "#3b82f6", // blue
  "#10b981", // emerald
];

interface Props {
  mode: "planning" | "live";
  onEntitySelect: (id: string | null) => void;
  selectedEntityId: string | null;
  pendingWeapon?: PendingWeapon | null;
  onWeaponPlaced?: () => void;
  planHighlights?: PlanHighlights | null;
  hoveredRouteWeapon?: string | null;
  viewAllPaths?: boolean;
  pinTargetMode?: boolean;
  onTargetPinned?: (lat: number, lon: number) => void;
  onTargetHover?: (targetId: string | null) => void;
}

const MAX_TRAIL_POINTS = 120;

interface WeaponTrail {
  positions: CesiumType.Cartesian3[];
  entity: CesiumType.Entity;
}

export default function CesiumGlobe({ mode, onEntitySelect, selectedEntityId, pendingWeapon = null, onWeaponPlaced, planHighlights, hoveredRouteWeapon = null, viewAllPaths = false, pinTargetMode = false, onTargetPinned, onTargetHover }: Props) {
  const viewerRef = useRef<CesiumType.Viewer | null>(null);
  const entityRefs = useRef<Map<string, CesiumType.Entity>>(new Map());
  const planHighlightRefs = useRef<CesiumType.Entity[]>([]);
  const routeEntityRefs = useRef<Map<string, CesiumType.Entity[]>>(new Map());
  const weaponTrailsRef = useRef<Map<string, WeaponTrail>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  // Refs so stale-closure click handler always sees latest prop values
  const modeRef = useRef(mode);
  const pendingWeaponRef = useRef(pendingWeapon);
  const onWeaponPlacedRef = useRef(onWeaponPlaced);
  const pinTargetModeRef = useRef(pinTargetMode);
  const onTargetPinnedRef = useRef(onTargetPinned);
  const onTargetHoverRef = useRef(onTargetHover);

  const { entities, getWeapons, getTargets, getThreats, getAirbases } = useEntityGraph();
  const getTargetsRef = useRef(getTargets);
  useEffect(() => { getTargetsRef.current = getTargets; }, [getTargets]);

  // Keep a fast-lookup Set of target entity IDs for use in the MOUSE_MOVE handler
  const targetIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    targetIdsRef.current = new Set(getTargets().map((t) => t.id));
  }, [entities]);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { pendingWeaponRef.current = pendingWeapon; }, [pendingWeapon]);
  useEffect(() => { onWeaponPlacedRef.current = onWeaponPlaced; }, [onWeaponPlaced]);
  useEffect(() => { pinTargetModeRef.current = pinTargetMode; }, [pinTargetMode]);
  useEffect(() => { onTargetPinnedRef.current = onTargetPinned; }, [onTargetPinned]);
  useEffect(() => { onTargetHoverRef.current = onTargetHover; }, [onTargetHover]);

  // initDoneRef is set to true BEFORE the async import, so it survives the
  // StrictMode cleanup→remount cycle and blocks the second initialization.
  const initDoneRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || viewerRef.current || initDoneRef.current) return;
    initDoneRef.current = true;   // mark synchronously — not reset by cleanup

    import("cesium").then(async (Cesium) => {
      Cesium.Ion.defaultAccessToken =
        process.env.NEXT_PUBLIC_CESIUM_TOKEN ?? "";

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
        // skyBox + skyAtmosphere left as defaults — shows starfield + atmosphere halo on globe
        baseLayer: false,
      });

      // CartoDB Dark Matter — dark tactical map, country borders + labels, no API key required
      const baseProvider = new Cesium.UrlTemplateImageryProvider({
        url: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        maximumLevel: 19,
        credit: "© CARTO © OpenStreetMap contributors",
      });
      viewer.imageryLayers.add(new Cesium.ImageryLayer(baseProvider));

      viewer.scene.backgroundColor = Cesium.Color.BLACK;
      viewer.scene.fog.enabled = false;
      viewer.scene.globe.enableLighting = true;
      viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#050a12");
      if (viewer.scene.skyAtmosphere) {
        viewer.scene.skyAtmosphere.show = true;
        viewer.scene.skyAtmosphere.atmosphereLightIntensity = 5.0;
      }

      // Top-down centered view — right-click drag to tilt into 3D perspective
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(50, 25, 12_000_000),
        orientation: {
          heading: 0,
          pitch: Cesium.Math.toRadians(-90),
          roll: 0,
        },
      });

      viewerRef.current = viewer;

      // Force canvas to match container size immediately and on every resize
      viewer.resize();
      const ro = new ResizeObserver(() => { if (!viewer.isDestroyed()) viewer.resize(); });
      ro.observe(containerRef.current!);

      // Country borders — polygon outlines are unreliable in Cesium; convert to polylines instead
      const borderDs = new Cesium.CustomDataSource("country-borders");
      viewer.dataSources.add(borderDs);
      Cesium.GeoJsonDataSource.load(
        "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_110m_admin_0_countries.geojson",
      ).then((ds) => {
        if (viewer.isDestroyed()) return;
        const red = Cesium.Color.fromCssColorString("#ef4444").withAlpha(0.9);
        const now = Cesium.JulianDate.now();
        const addLine = (pts: CesiumType.Cartesian3[]) => {
          if (pts.length < 2) return;
          borderDs.entities.add({
            polyline: {
              positions: [...pts, pts[0]],
              material: red,
              width: 1.5,
              clampToGround: true,
            },
          });
        };
        ds.entities.values.forEach((entity) => {
          if (!entity.polygon) return;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hier = (entity.polygon.hierarchy as any)?.getValue(now);
          if (!hier) return;
          addLine(hier.positions);
          (hier.holes ?? []).forEach((h: { positions: CesiumType.Cartesian3[] }) =>
            addLine(h.positions),
          );
        });
      }).catch((e: unknown) => console.error("Country borders load failed:", e));
      // Store observer so cleanup can disconnect it
      (containerRef.current as HTMLDivElement & { _cesiumRO?: ResizeObserver })._cesiumRO = ro;

      const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

      clickHandler.setInputAction((click: { position: CesiumType.Cartesian2 }) => {
        const picked = viewer.scene.pick(click.position);
        if (Cesium.defined(picked) && picked.id) {
          const entityId = (picked.id as CesiumType.Entity).name;
          if (entityId) onEntitySelect(entityId);
        } else {
          if (modeRef.current === "planning") {
            const cartesian = viewer.camera.pickEllipsoid(
              click.position,
              viewer.scene.globe.ellipsoid,
            );
            if (cartesian) {
              const carto = Cesium.Cartographic.fromCartesian(cartesian);
              const lat = Cesium.Math.toDegrees(carto.latitude);
              const lon = Cesium.Math.toDegrees(carto.longitude);
              if (pinTargetModeRef.current) {
                onTargetPinnedRef.current?.(lat, lon);
              } else if (pendingWeaponRef.current) {
                placeWeapon(lat, lon);
              } else {
                placeTarget(lat, lon);
              }
            }
          }
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      clickHandler.setInputAction((click: { position: CesiumType.Cartesian2 }) => {
        if (mode !== "live") return;
        const cartesian = viewer.camera.pickEllipsoid(
          click.position,
          viewer.scene.globe.ellipsoid,
        );
        if (cartesian) {
          const carto = Cesium.Cartographic.fromCartesian(cartesian);
          showThreatMenu(
            Cesium.Math.toDegrees(carto.latitude),
            Cesium.Math.toDegrees(carto.longitude),
            click.position as unknown as { x: number; y: number },
          );
        }
      }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

      // Mouse move — hover detection for target entities
      clickHandler.setInputAction((move: { endPosition: CesiumType.Cartesian2 }) => {
        const picked = viewer.scene.pick(move.endPosition);
        if (Cesium.defined(picked) && picked.id) {
          const entityId = (picked.id as CesiumType.Entity).name;
          if (entityId && targetIdsRef.current.has(entityId)) {
            onTargetHoverRef.current?.(entityId);
          } else {
            onTargetHoverRef.current?.(null);
          }
        } else {
          onTargetHoverRef.current?.(null);
        }
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    });

    return () => {
      (containerRef.current as HTMLDivElement & { _cesiumRO?: ResizeObserver })?._cesiumRO?.disconnect();
      if (viewerRef.current) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
    };
  }, []);

  const showFetchError = useCallback((msg: string) => {
    if (!containerRef.current) return;
    const el = document.createElement("div");
    el.style.cssText =
      "position:absolute;top:1rem;left:50%;transform:translateX(-50%);z-index:9999;" +
      "background:rgba(69,10,10,0.97);border:1px solid #b91c1c;border-radius:6px;" +
      "padding:0.5rem 1.2rem;font-family:monospace;font-size:11px;color:#fca5a5;" +
      "pointer-events:none;white-space:nowrap;";
    el.textContent = `⚠ ${msg}`;
    containerRef.current.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }, []);

  const placeTarget = useCallback(async (lat: number, lon: number) => {
    try {
      await fetch(`${API}/entities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "TARGET",
          domain: "LAND",
          properties: { lat, lon, alt_km: 0, label: `Target ${Date.now()}` },
        }),
      });
    } catch {
      showFetchError("Backend unreachable — start the server on :8000");
    }
  }, [showFetchError]);

  const placeWeapon = useCallback(async (lat: number, lon: number) => {
    const w = pendingWeaponRef.current;
    if (!w) return;

    // Auto-assign nearest target so the weapon knows where to fly
    const targets = getTargetsRef.current();
    let target_lat = 0.0;
    let target_lon = 0.0;
    if (targets.length > 0) {
      const nearest = targets.reduce((best, t) => {
        const tLat = t.properties.lat as number;
        const tLon = t.properties.lon as number;
        const bLat = best.properties.lat as number;
        const bLon = best.properties.lon as number;
        const dThis = (tLat - lat) ** 2 + (tLon - lon) ** 2;
        const dBest = (bLat - lat) ** 2 + (bLon - lon) ** 2;
        return dThis < dBest ? t : best;
      });
      target_lat = nearest.properties.lat as number;
      target_lon = nearest.properties.lon as number;
    }

    try {
      await fetch(`${API}/entities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "WEAPON",
          domain: w.domain,
          properties: {
            lat,
            lon,
            alt_km: (w.cruise_altitude_m?.[0] ?? 0) / 1000,
            weapon_type: w.name,
            speed_mach: w.speed_mach,
            fuel_remaining_pct: 1.0,
            tau_i: 0.0,
            suda_state: "CRUISE",
            evasion_capable: w.evasion_capable,
            stealth: w.stealth,
            target_lat,
            target_lon,
          },
        }),
      });
      onWeaponPlacedRef.current?.();
    } catch {
      showFetchError("Backend unreachable — start the server on :8000");
    }
  }, [showFetchError]);

  const showThreatMenu = useCallback(
    (lat: number, lon: number, screenPos: { x: number; y: number }) => {
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
            body: JSON.stringify({ lat, lon, threat_type: type, radius_km: radius, p_intercept_base: p, label }),
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

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    import("cesium").then((Cesium) => {
      const currentIds = new Set(Object.keys(entities));

      for (const [id, cesiumEntity] of entityRefs.current.entries()) {
        if (!currentIds.has(id)) {
          viewer.entities.remove(cesiumEntity);
          entityRefs.current.delete(id);
          const trail = weaponTrailsRef.current.get(id);
          if (trail) {
            viewer.entities.remove(trail.entity);
            weaponTrailsRef.current.delete(id);
          }
        }
      }

      for (const entity of Object.values(entities)) {
        upsertCesiumEntity(Cesium, viewer, entity);
      }
    });
  }, [entities]);

  const upsertCesiumEntity = (
    Cesium: typeof import("cesium"),
    viewer: CesiumType.Viewer,
    entity: Entity,
  ) => {
    const { lat, lon, alt_km = 0 } = entity.properties as {
      lat?: number;
      lon?: number;
      alt_km?: number;
    };
    if (lat == null || lon == null) return;

    const altM = (alt_km as number) * 1000;
    const pos = Cesium.Cartesian3.fromDegrees(lon, lat, altM);
    const existing = entityRefs.current.get(entity.id);

    if (existing) {
      (existing.position as CesiumType.ConstantPositionProperty).setValue(pos);
      if (entity.type === "WEAPON") {
        const props = entity.properties as { suda_state?: string; heading_deg?: number };
        const suda = props.suda_state ?? "CRUISE";
        if (existing.billboard) {
          existing.billboard.color = new Cesium.ConstantProperty(
            Cesium.Color.fromCssColorString(SUDA_COLORS[suda] ?? "#3b82f6"),
          );
          // Rotate icon to face direction of travel
          const heading = props.heading_deg ?? 0;
          const rotation = Math.PI / 2 - Cesium.Math.toRadians(heading);
          existing.billboard.rotation = new Cesium.ConstantProperty(rotation);
        }
        // Append to flight trail
        const trail = weaponTrailsRef.current.get(entity.id);
        if (trail) {
          trail.positions.push(pos);
          if (trail.positions.length > MAX_TRAIL_POINTS) trail.positions.shift();
        }
      }
      return;
    }

    let cesiumEntity: CesiumType.Entity | undefined;

    switch (entity.type) {
      case "WEAPON": {
        const props = entity.properties as { suda_state?: string; heading_deg?: number; weapon_type?: string };
        const suda = props.suda_state ?? "CRUISE";
        const color = Cesium.Color.fromCssColorString(SUDA_COLORS[suda] ?? "#3b82f6");
        const heading = props.heading_deg ?? 0;
        const rotation = Math.PI / 2 - Cesium.Math.toRadians(heading);

        cesiumEntity = viewer.entities.add({
          name: entity.id,
          position: pos,
          billboard: {
            image: getWeaponSvg(entity.domain),
            width: 28,
            height: 28,
            color,
            rotation: new Cesium.ConstantProperty(rotation),
            heightReference: Cesium.HeightReference.NONE,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });

        // Initialise flight trail — CallbackProperty so positions array drives rendering live
        const trailPositions: CesiumType.Cartesian3[] = [pos];
        const trailEntity = viewer.entities.add({
          polyline: {
            positions: new Cesium.CallbackProperty(() => trailPositions.slice(), false),
            width: 1.5,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.15,
              color: color.withAlpha(0.45),
            }),
            clampToGround: false,
          },
        });
        weaponTrailsRef.current.set(entity.id, { positions: trailPositions, entity: trailEntity });
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

  // ── Plan highlights (suggested airbases + carriers from AI planner) ─────────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    import("cesium").then((Cesium) => {
      // Clear previous highlights
      for (const e of planHighlightRefs.current) {
        viewer.entities.remove(e);
      }
      planHighlightRefs.current = [];

      if (!planHighlights) return;

      // Suggested airbases — yellow with ring
      for (const ab of planHighlights.airbases) {
        if (ab.lat == null || ab.lon == null) continue;
        const pos = Cesium.Cartesian3.fromDegrees(ab.lon, ab.lat, 0);
        const color = Cesium.Color.fromCssColorString("#eab308");

        const ring = viewer.entities.add({
          position: pos,
          ellipse: {
            semiMajorAxis: 40000,
            semiMinorAxis: 40000,
            material: color.withAlpha(0.08),
            outline: true,
            outlineColor: color.withAlpha(0.6),
            outlineWidth: 1.5,
            height: 0,
          },
        });
        const icon = viewer.entities.add({
          position: pos,
          billboard: {
            image: getPlanAirbaseSvg(),
            width: 26,
            height: 26,
            color,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          },
          label: {
            text: ab.name || ab.id,
            font: "10px monospace",
            fillColor: Cesium.Color.fromCssColorString("#eab308"),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -30),
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString("#000000").withAlpha(0.55),
            backgroundPadding: new Cesium.Cartesian2(4, 3),
          },
        });
        planHighlightRefs.current.push(ring, icon);
      }

      // ── Route polylines — hidden by default, revealed on hover / viewAllPaths ─
      routeEntityRefs.current.clear();
      for (let i = 0; i < (planHighlights.routes ?? []).length; i++) {
        const route = planHighlights.routes[i];
        if (!route.waypoints || route.waypoints.length < 2) continue;
        const hex = ROUTE_COLORS[i % ROUTE_COLORS.length];
        const color = Cesium.Color.fromCssColorString(hex);
        const mins = Math.round(route.total_time_s / 60);

        const positions = route.waypoints.map((wp) =>
          Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, 8000),
        );

        // Glowing outer line (wider, dimmer)
        const glow = viewer.entities.add({
          show: false,
          polyline: {
            positions,
            width: 4,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.25,
              color: color.withAlpha(0.5),
            }),
            clampToGround: false,
          },
        });

        // Crisp inner line
        const line = viewer.entities.add({
          show: false,
          polyline: {
            positions,
            width: 1.5,
            material: new Cesium.ColorMaterialProperty(color.withAlpha(0.9)),
            clampToGround: false,
          },
        });

        // Label along the line — positioned at midpoint, rotated to follow route bearing
        const midIdx = Math.floor(route.waypoints.length / 2);
        const mid = route.waypoints[midIdx];
        const p1 = route.waypoints[Math.max(0, midIdx - 1)];
        const p2 = route.waypoints[Math.min(route.waypoints.length - 1, midIdx + 1)];
        const avgLat = ((p1.lat + p2.lat) / 2) * (Math.PI / 180);
        const dlat = p2.lat - p1.lat;
        const dlon = (p2.lon - p1.lon) * Math.cos(avgLat);
        // Bearing from north (clockwise) → Cesium screen rotation (CCW from east)
        const rotation = -(Math.atan2(dlon, dlat) - Math.PI / 2);
        const label = viewer.entities.add({
          show: false,
          position: Cesium.Cartesian3.fromDegrees(mid.lon, mid.lat, 12000),
          label: {
            text: `${route.weapon_type.replace(/_/g, " ").toUpperCase()}  ${Math.round(route.total_dist_km)}km  ${mins}m`,
            font: "9px monospace",
            fillColor: color,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString("#000000").withAlpha(0.7),
            backgroundPadding: new Cesium.Cartesian2(5, 2),
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...(({ rotation } as unknown) as any),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });

        const weaponKey = route.weapon_type;
        const existing = routeEntityRefs.current.get(weaponKey) ?? [];
        routeEntityRefs.current.set(weaponKey, [...existing, glow, line, label]);
        planHighlightRefs.current.push(glow, line, label);
      }

      // Suggested carriers — cyan with ring
      for (const cv of planHighlights.carriers) {
        if (cv.lat == null || cv.lon == null) continue;
        const pos = Cesium.Cartesian3.fromDegrees(cv.lon, cv.lat, 0);
        const color = Cesium.Color.fromCssColorString("#22d3ee");

        const ring = viewer.entities.add({
          position: pos,
          ellipse: {
            semiMajorAxis: 55000,
            semiMinorAxis: 55000,
            material: color.withAlpha(0.07),
            outline: true,
            outlineColor: color.withAlpha(0.5),
            outlineWidth: 1.5,
            height: 0,
          },
        });
        const icon = viewer.entities.add({
          position: pos,
          billboard: {
            image: getCarrierSvg(),
            width: 26,
            height: 26,
            color,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          },
          label: {
            text: cv.label || "CARRIER",
            font: "10px monospace",
            fillColor: color,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -30),
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString("#000000").withAlpha(0.55),
            backgroundPadding: new Cesium.Cartesian2(4, 3),
          },
        });
        planHighlightRefs.current.push(ring, icon);
      }
    });
  }, [planHighlights]);

  // ── Route visibility — hover-to-reveal + viewAllPaths override ─────────────
  useEffect(() => {
    for (const [weaponType, entities] of routeEntityRefs.current.entries()) {
      const visible = viewAllPaths || hoveredRouteWeapon === weaponType;
      for (const e of entities) {
        e.show = visible;
      }
    }
  }, [hoveredRouteWeapon, viewAllPaths]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      style={{ cursor: pendingWeapon || pinTargetMode ? "crosshair" : undefined }}
    />
  );
}

function svgUri(svg: string) {
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function getWeaponSvg(domain: string) {
  const color = WEAPON_COLORS[domain] ?? "#3b82f6";
  // Pointing UP (north) — billboard rotation will rotate to heading
  if (domain === "AIR") {
    // Cruise missile / aircraft silhouette — dart shape
    return svgUri(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
      `<polygon points="12,1 15,10 14,10 14,18 12,23 10,18 10,10 9,10" fill="${color}"/>` +
      `<polygon points="9,10 4,15 4,17 10,12" fill="${color}" opacity="0.8"/>` +
      `<polygon points="15,10 20,15 20,17 14,12" fill="${color}" opacity="0.8"/>` +
      `</svg>`,
    );
  }
  if (domain === "SEA") {
    // Naval cruise missile / torpedo — elongated with fin
    return svgUri(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
      `<ellipse cx="12" cy="12" rx="3" ry="10" fill="${color}"/>` +
      `<polygon points="12,2 14,7 10,7" fill="${color}"/>` +
      `<polygon points="9,17 12,22 15,17 12,19" fill="${color}" opacity="0.7"/>` +
      `<line x1="7" y1="15" x2="12" y2="18" stroke="${color}" stroke-width="1.5" opacity="0.7"/>` +
      `<line x1="17" y1="15" x2="12" y2="18" stroke="${color}" stroke-width="1.5" opacity="0.7"/>` +
      `</svg>`,
    );
  }
  // LAND — ballistic missile, tall narrow cone
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
    `<polygon points="12,1 16,14 12,12 8,14" fill="${color}"/>` +
    `<rect x="10" y="14" width="4" height="6" fill="${color}" opacity="0.9"/>` +
    `<polygon points="8,20 10,20 10,23 8,22" fill="${color}" opacity="0.7"/>` +
    `<polygon points="16,20 14,20 14,23 16,22" fill="${color}" opacity="0.7"/>` +
    `</svg>`,
  );
}

function getTargetSvg() {
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke="#ef4444" fill="none" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="7"/><line x1="12" y1="17" x2="12" y2="22"/><line x1="2" y1="12" x2="7" y2="12"/><line x1="17" y1="12" x2="22" y2="12"/></svg>`,
  );
}

function getThreatSvg() {
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ef4444"><polygon points="12,2 22,20 2,20" /><text x="12" y="18" text-anchor="middle" font-size="10" fill="white">!</text></svg>`,
  );
}

function getAirbaseSvg() {
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#eab308"><polygon points="12,2 22,22 2,22" /></svg>`,
  );
}

function getPlanAirbaseSvg() {
  // Runway cross + diamond — distinct from regular airbase triangle
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="1.8">` +
    `<rect x="2" y="10" width="20" height="4" rx="1" fill="#eab308" stroke="none"/>` +
    `<rect x="10" y="2" width="4" height="20" rx="1" fill="#eab308" stroke="none"/>` +
    `<polygon points="12,4 20,12 12,20 4,12" fill="none" stroke="#eab308" stroke-width="1.5"/>` +
    `</svg>`,
  );
}

function getCarrierSvg() {
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#22d3ee"><rect x="3" y="12" width="18" height="8" rx="2"/><rect x="8" y="8" width="10" height="4"/><line x1="6" y1="12" x2="6" y2="20" stroke="#22d3ee" stroke-width="1"/></svg>`,
  );
}
