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
}

interface Props {
  mode: "planning" | "live";
  onEntitySelect: (id: string | null) => void;
  selectedEntityId: string | null;
  pendingWeapon?: PendingWeapon | null;
  onWeaponPlaced?: () => void;
  planHighlights?: PlanHighlights | null;
}

export default function CesiumGlobe({ mode, onEntitySelect, selectedEntityId, pendingWeapon = null, onWeaponPlaced, planHighlights }: Props) {
  const viewerRef = useRef<CesiumType.Viewer | null>(null);
  const entityRefs = useRef<Map<string, CesiumType.Entity>>(new Map());
  const planHighlightRefs = useRef<CesiumType.Entity[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  // Refs so stale-closure click handler always sees latest prop values
  const modeRef = useRef(mode);
  const pendingWeaponRef = useRef(pendingWeapon);
  const onWeaponPlacedRef = useRef(onWeaponPlaced);

  const { entities, getWeapons, getTargets, getThreats, getAirbases } = useEntityGraph();

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { pendingWeaponRef.current = pendingWeapon; }, [pendingWeapon]);
  useEffect(() => { onWeaponPlacedRef.current = onWeaponPlaced; }, [onWeaponPlaced]);

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
      viewer.scene.globe.enableLighting = false;
      viewer.scene.globe.baseColor = Cesium.Color.BLACK;

      // Start zoomed in enough that the globe fills most of the viewport
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(20, 25, 12_000_000),
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
              if (pendingWeaponRef.current) {
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

    const pos = Cesium.Cartesian3.fromDegrees(lon, lat, (alt_km as number) * 1000);
    const existing = entityRefs.current.get(entity.id);

    if (existing) {
      (existing.position as CesiumType.ConstantPositionProperty).setValue(pos);
      if (entity.type === "WEAPON" && existing.billboard) {
        const suda = (entity.properties as { suda_state?: string }).suda_state ?? "CRUISE";
        existing.billboard.color = new Cesium.ConstantProperty(
          Cesium.Color.fromCssColorString(SUDA_COLORS[suda] ?? "#3b82f6"),
        );
      }
      return;
    }

    let cesiumEntity: CesiumType.Entity | undefined;

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
            show: false,
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

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      style={{ cursor: pendingWeapon ? "crosshair" : undefined }}
    />
  );
}

function svgUri(svg: string) {
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function getWeaponSvg(domain: string) {
  const color = WEAPON_COLORS[domain] ?? "#3b82f6";
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${color}"><polygon points="12,2 22,22 12,17 2,22" /></svg>`,
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
