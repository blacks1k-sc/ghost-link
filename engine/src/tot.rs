/// ghost_tot — Time-on-Target Consensus Engine
///
/// Implements distributed consensus so all weapons converge to a shared
/// impact time τ* despite disruptions, evasions, and destruction.
///
/// DSA: Distributed graph consensus, Ring Buffer (telemetry history)
///
/// τ̇_i = -k₁ Σ_{j∈N_i}(τ_i − τ_j) − k₂(τ_i − τ_nom,i)
///
/// Performance gate: <5ms for 100-missile scenario (criterion bench)

use crate::physics::haversine_km;

// ---------------------------------------------------------------------------
// ToT weapon record (lightweight, just what consensus needs)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct TotWeapon {
    pub id: u64,
    pub lat: f64,
    pub lon: f64,
    pub tau_i: f64,       // current time-to-go estimate (seconds)
    pub tau_nom: f64,     // nominal τ (straight-line distance / current speed)
    pub speed_mach: f64,
    pub alive: bool,
}

// ---------------------------------------------------------------------------
// Ring Buffer — telemetry history per weapon
// DSA: Circular buffer, O(1) amortized push and read
// ---------------------------------------------------------------------------

pub struct RingBuffer<T: Copy + Default> {
    data: Vec<T>,
    head: usize,
    len: usize,
    capacity: usize,
}

impl<T: Copy + Default> RingBuffer<T> {
    pub fn new(capacity: usize) -> Self {
        Self {
            data: vec![T::default(); capacity],
            head: 0,
            len: 0,
            capacity,
        }
    }

    /// Push a value, evicting oldest if full. O(1)
    pub fn push(&mut self, val: T) {
        let idx = (self.head + self.len) % self.capacity;
        self.data[idx] = val;
        if self.len == self.capacity {
            self.head = (self.head + 1) % self.capacity; // evict oldest
        } else {
            self.len += 1;
        }
    }

    /// Most recent value. O(1)
    pub fn latest(&self) -> Option<T> {
        if self.len == 0 {
            return None;
        }
        let idx = (self.head + self.len - 1) % self.capacity;
        Some(self.data[idx])
    }

    /// Ordered slice: oldest first. O(n)
    pub fn as_ordered_vec(&self) -> Vec<T> {
        (0..self.len)
            .map(|i| self.data[(self.head + i) % self.capacity])
            .collect()
    }

    pub fn len(&self) -> usize {
        self.len
    }
}

// ---------------------------------------------------------------------------
// TotEngine — the consensus orchestrator
// ---------------------------------------------------------------------------

pub struct TotEngine {
    /// Consensus gain: neighbor term weight
    pub k1: f64,
    /// Consensus gain: nominal τ restoring force
    pub k2: f64,
    /// Communication radius (km) — weapons within this talk to each other
    pub r_comm_km: f64,
    /// τ history per weapon (ring buffer of last 50 τ_i values)
    pub tau_history: Vec<RingBuffer<f64>>,
}

impl TotEngine {
    pub fn new(k1: f64, k2: f64, r_comm_km: f64, n_weapons: usize) -> Self {
        Self {
            k1,
            k2,
            r_comm_km,
            tau_history: (0..n_weapons).map(|_| RingBuffer::new(50)).collect(),
        }
    }

    /// Single consensus update step for all weapons.
    ///
    /// For each alive weapon i:
    ///   τ̇_i = -k₁ Σ_{j∈N_i}(τ_i − τ_j) − k₂(τ_i − τ_nom,i)
    ///   τ_i(t+dt) = τ_i(t) + τ̇_i * dt
    ///
    /// Also decrements τ_i by dt (time is passing).
    ///
    /// Time: O(n²) worst case (all weapons within r_comm of each other).
    /// In practice O(n * k) where k = average neighbor count (~5–10).
    pub fn tick(&mut self, weapons: &mut [TotWeapon], dt_s: f64) {
        let n = weapons.len();
        if n == 0 {
            return;
        }

        // Snapshot τ values before update (prevents order-dependence)
        let tau_snapshot: Vec<f64> = weapons.iter().map(|w| w.tau_i).collect();

        for i in 0..n {
            if !weapons[i].alive {
                continue;
            }

            // Find neighbors within r_comm
            let mut neighbor_sum = 0.0;
            let mut neighbor_count = 0;
            for j in 0..n {
                if i == j || !weapons[j].alive {
                    continue;
                }
                let dist = haversine_km(
                    weapons[i].lat, weapons[i].lon,
                    weapons[j].lat, weapons[j].lon,
                );
                if dist <= self.r_comm_km {
                    neighbor_sum += tau_snapshot[i] - tau_snapshot[j];
                    neighbor_count += 1;
                }
            }

            // Consensus update: τ̇_i
            let tau_dot = -self.k1 * neighbor_sum - self.k2 * (tau_snapshot[i] - weapons[i].tau_nom);

            // Integrate
            weapons[i].tau_i = (tau_snapshot[i] + tau_dot * dt_s - dt_s).max(0.0);

            // Record history
            if i < self.tau_history.len() {
                self.tau_history[i].push(weapons[i].tau_i);
            }
        }
    }

    /// Compute RMS(τ_i − τ*) — displayed in the UI convergence chart.
    /// τ* = mean of all alive τ_i values.
    pub fn rms_error(&self, weapons: &[TotWeapon]) -> f64 {
        let alive: Vec<f64> = weapons.iter().filter(|w| w.alive).map(|w| w.tau_i).collect();
        if alive.is_empty() {
            return 0.0;
        }
        let tau_star = alive.iter().sum::<f64>() / alive.len() as f64;
        let mse = alive.iter().map(|t| (t - tau_star).powi(2)).sum::<f64>() / alive.len() as f64;
        mse.sqrt()
    }

    /// τ* = consensus target (mean of alive τ_i values)
    pub fn tau_star(&self, weapons: &[TotWeapon]) -> f64 {
        let alive: Vec<f64> = weapons.iter().filter(|w| w.alive).map(|w| w.tau_i).collect();
        if alive.is_empty() {
            return 0.0;
        }
        alive.iter().sum::<f64>() / alive.len() as f64
    }

    /// Check convergence: is RMS < threshold?
    pub fn is_converged(&self, weapons: &[TotWeapon], threshold_s: f64) -> bool {
        self.rms_error(weapons) < threshold_s
    }

    /// Handle weapon destruction: mark as dead, consensus continues with survivors.
    /// No recomputation needed — next tick() call will naturally exclude it.
    pub fn weapon_destroyed(&mut self, weapons: &mut [TotWeapon], weapon_idx: usize) {
        if weapon_idx < weapons.len() {
            weapons[weapon_idx].alive = false;
        }
    }

    /// Apply a Δτ_i to a specific weapon (after evasion maneuver).
    /// Other weapons will compensate over next consensus ticks.
    pub fn apply_delta_tau(&mut self, weapons: &mut [TotWeapon], weapon_idx: usize, delta_tau_s: f64) {
        if weapon_idx < weapons.len() && weapons[weapon_idx].alive {
            weapons[weapon_idx].tau_i += delta_tau_s;
        }
    }

    /// Speed adjustment recommendation for a weapon to re-converge to τ*.
    /// Returns a speed multiplier [0.5, 1.5] the weapon should apply.
    pub fn speed_adjustment(&self, weapon: &TotWeapon, tau_star: f64) -> f64 {
        let error = weapon.tau_i - tau_star;
        // Negative error → weapon is ahead → slow down (speed < 1.0)
        // Positive error → weapon is behind → speed up
        let adjustment = 1.0 - (error / tau_star.max(1.0)) * 0.5;
        adjustment.clamp(0.5, 1.5)
    }
}
