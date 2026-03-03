/**
 * WebSocket hook — connects to backend /ws/entities
 * Patches the Zustand entity graph store on every incoming message.
 */

"use client";

import { useEffect, useRef } from "react";
import { useEntityGraph } from "@/stores/entityGraph";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000";

export function useEntityWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const {
    upsertEntity,
    removeEntity,
    applySnapshot,
    appendEvent,
    setWsConnected,
    setSimTime,
  } = useEntityGraph();

  useEffect(() => {
    const ws = new WebSocket(`${WS_URL}/ws/entities`);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      // Keepalive ping every 10s
      const ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("ping");
        }
      }, 10_000);
      ws.addEventListener("close", () => clearInterval(ping));
    };

    ws.onclose = () => setWsConnected(false);

    ws.onmessage = (msg) => {
      try {
        const { event, data } = JSON.parse(msg.data);
        switch (event) {
          case "snapshot":
            applySnapshot(data);
            break;
          case "upsert":
            upsertEntity(data);
            break;
          case "remove":
            removeEntity(data.id);
            break;
          case "sim_time":
            setSimTime(data.time_s);
            break;
          default:
            // Treat as simulation event for the log
            if (data?.event_type) {
              appendEvent(data);
            }
        }
      } catch {
        // malformed message — ignore
      }
    };

    return () => {
      ws.close();
    };
  }, []);

  return wsRef;
}
