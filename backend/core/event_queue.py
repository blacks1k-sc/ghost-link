"""
Discrete Event Simulation (DES) Clock — Min-Heap Event Queue
DSA: Min-Heap / Priority Queue
O(log n) push and pop. Drives the simulation tick.

All simulation events are timestamped and processed in chronological order.
This is the backbone of the simulation engine: every state change flows
through the event queue, guaranteeing causal ordering.
"""

from __future__ import annotations
import heapq
import time
from enum import Enum
from dataclasses import dataclass, field
from typing import Any


class EventType(str, Enum):
    # Lifecycle
    WEAPON_LAUNCHED = "WEAPON_LAUNCHED"
    WEAPON_DESTROYED = "WEAPON_DESTROYED"
    IMPACT = "IMPACT"
    SIMULATION_START = "SIMULATION_START"
    SIMULATION_END = "SIMULATION_END"

    # Threat events
    THREAT_INJECTED = "THREAT_INJECTED"
    THREAT_DETECTED = "THREAT_DETECTED"
    THREAT_EXPIRED = "THREAT_EXPIRED"

    # SUDA events
    EVASION_START = "EVASION_START"
    EVASION_END = "EVASION_END"
    REALIGN_START = "REALIGN_START"

    # ToT consensus
    TOT_UPDATED = "TOT_UPDATED"
    TOT_CONVERGED = "TOT_CONVERGED"

    # ISR
    ISR_HANDOVER = "ISR_HANDOVER"
    ISR_TRACK_ACQUIRED = "ISR_TRACK_ACQUIRED"

    # Planner
    PLAN_SUGGESTED = "PLAN_SUGGESTED"

    # Cyber
    CYBER_ATTACK_START = "CYBER_ATTACK_START"
    CYBER_NODE_COMPROMISED = "CYBER_NODE_COMPROMISED"
    CYBER_LINK_SEVERED = "CYBER_LINK_SEVERED"

    # Auth
    SESSION_REAUTH_REQUIRED = "SESSION_REAUTH_REQUIRED"

    # Tick
    PHYSICS_TICK = "PHYSICS_TICK"


@dataclass(order=True)
class Event:
    """
    Heap-ordered by (timestamp_ms, priority, seq).
    Lower timestamp = higher priority in min-heap.
    seq is monotonically increasing to break ties deterministically.
    """
    timestamp_ms: float
    priority: int = field(default=10)   # lower = more urgent (0=critical, 10=normal)
    seq: int = field(default=0)          # tie-breaker — never compared on content
    event_type: EventType = field(default=EventType.PHYSICS_TICK, compare=False)
    entity_id: str = field(default="", compare=False)
    payload: dict[str, Any] = field(default_factory=dict, compare=False)

    def to_dict(self) -> dict:
        return {
            "timestamp_ms": self.timestamp_ms,
            "event_type": self.event_type.value,
            "entity_id": self.entity_id,
            "payload": self.payload,
        }


class EventQueue:
    """
    Min-heap event queue for discrete event simulation.

    Push: O(log n)
    Pop:  O(log n)
    Peek: O(1)

    Supports:
    - Scheduled future events (launch at T+300s)
    - Immediate events (threat detected NOW)
    - Recurring tick events (physics update every 100ms sim-time)
    - Lazy cancellation (mark event cancelled without restructuring heap)
    """

    def __init__(self):
        self._heap: list[Event] = []
        self._seq: int = 0
        self._cancelled: set[int] = set()  # cancelled event seqs (lazy deletion)
        # Log of all processed events — used by analytics
        self._log: list[Event] = []
        self._sim_time_ms: float = 0.0

    @property
    def sim_time_ms(self) -> float:
        return self._sim_time_ms

    @property
    def sim_time_s(self) -> float:
        return self._sim_time_ms / 1000.0

    def push(
        self,
        event_type: EventType,
        timestamp_ms: float,
        entity_id: str = "",
        payload: dict | None = None,
        priority: int = 10,
    ) -> int:
        """
        Push an event onto the heap.
        Returns the seq number (can be used to cancel).
        """
        seq = self._seq
        self._seq += 1
        event = Event(
            timestamp_ms=timestamp_ms,
            priority=priority,
            seq=seq,
            event_type=event_type,
            entity_id=entity_id,
            payload=payload or {},
        )
        heapq.heappush(self._heap, event)
        return seq

    def push_now(
        self,
        event_type: EventType,
        entity_id: str = "",
        payload: dict | None = None,
        priority: int = 5,
    ) -> int:
        """Push an event at current simulation time (immediate)."""
        return self.push(event_type, self._sim_time_ms, entity_id, payload, priority)

    def push_after(
        self,
        event_type: EventType,
        delay_ms: float,
        entity_id: str = "",
        payload: dict | None = None,
        priority: int = 10,
    ) -> int:
        """Push an event delay_ms from now."""
        return self.push(event_type, self._sim_time_ms + delay_ms, entity_id, payload, priority)

    def cancel(self, seq: int):
        """
        Lazy cancellation — mark seq as cancelled.
        The event stays in the heap but is skipped on pop.
        O(1) cancel vs O(n) removal.
        """
        self._cancelled.add(seq)

    def pop(self) -> Event | None:
        """
        Pop the next event in chronological order.
        Skips cancelled events.
        Returns None if heap is empty.
        O(log n) amortized (lazy deletion may require multiple pops).
        """
        while self._heap:
            event = heapq.heappop(self._heap)
            if event.seq in self._cancelled:
                self._cancelled.discard(event.seq)
                continue
            self._sim_time_ms = event.timestamp_ms
            self._log.append(event)
            return event
        return None

    def peek(self) -> Event | None:
        """Peek at next event without consuming it. O(1)."""
        while self._heap:
            if self._heap[0].seq not in self._cancelled:
                return self._heap[0]
            cancelled = heapq.heappop(self._heap)
            self._cancelled.discard(cancelled.seq)
        return None

    def pop_until(self, until_ms: float) -> list[Event]:
        """
        Pop all events with timestamp <= until_ms.
        Used by the simulation tick loop to advance time.
        """
        events = []
        while self._heap:
            next_event = self.peek()
            if next_event is None or next_event.timestamp_ms > until_ms:
                break
            event = self.pop()
            if event:
                events.append(event)
        self._sim_time_ms = until_ms
        return events

    def schedule_recurring_tick(self, interval_ms: float, end_ms: float):
        """
        Pre-schedule physics ticks at regular intervals.
        interval_ms: simulation time between ticks (e.g. 100ms = 10 Hz)
        end_ms: stop scheduling after this sim time
        """
        t = self._sim_time_ms + interval_ms
        while t <= end_ms:
            self.push(EventType.PHYSICS_TICK, t, priority=1)
            t += interval_ms

    def is_empty(self) -> bool:
        return len(self._heap) == 0 or all(e.seq in self._cancelled for e in self._heap)

    def size(self) -> int:
        return len(self._heap) - len(self._cancelled)

    def get_log(self, event_type: EventType | None = None) -> list[dict]:
        """Return processed event log, optionally filtered by type."""
        if event_type is None:
            return [e.to_dict() for e in self._log]
        return [e.to_dict() for e in self._log if e.event_type == event_type]

    def reset(self):
        self._heap.clear()
        self._seq = 0
        self._cancelled.clear()
        self._log.clear()
        self._sim_time_ms = 0.0
