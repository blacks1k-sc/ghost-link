/// ghost_physics — Per-tick weapon state update
///
/// Handles: haversine great-circle motion, domain-specific drag + fuel burn,
/// S-turn evasion geometry (triggered by SUDA DECIDE step).
///
/// Performance gate: <5ms for 100 active weapons (validated by criterion bench)

use std::f64::consts::PI;

const EARTH_RADIUS_KM: f64 = 6371.0;
const MS_PER_S: f64 = 1000.0;

// ---------------------------------------------------------------------------
// WeaponState — the complete per-weapon state updated each physics tick
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
#[repr(C)]
pub struct WeaponState {
    pub id: u64,              // entity UUID mapped to u64 for Rust perf
    pub lat: f64,             // degrees
    pub lon: f64,             // degrees
    pub alt_km: f64,          // km MSL
    pub heading_deg: f64,     // 0=North, 90=East
    pub speed_mach: f64,      // current speed in Mach
    pub speed_max_mach: f64,  // design maximum
    pub speed_min_mach: f64,  // minimum controllable speed
    pub fuel_pct: f64,        // 0.0..=1.0
    pub fuel_burn_rate: f64,  // pct per second at cruise speed
    pub domain: u8,           // 0=AIR, 1=SEA, 2=LAND
    pub tau_i: f64,           // time-to-go estimate (seconds)
    pub suda_state: u8,       // 0=CRUISE, 1=EVADING, 2=REALIGNING, 3=TERMINAL, 4=DESTROYED
    pub evasion_timer_s: f64, // remaining evasion time
    pub evasion_g: f64,       // current G-load during evasion (0 = no evasion)
    pub evasion_lateral_offset: f64, // km lateral offset for S-turn
    pub target_lat: f64,
    pub target_lon: f64,
    pub alt_km_target: f64,
}

impl WeaponState {
    /// Bearing to target (degrees, 0=North)
    pub fn bearing_to_target(&self) -> f64 {
        bearing(self.lat, self.lon, self.target_lat, self.target_lon)
    }

    /// Haversine distance to target (km)
    pub fn distance_to_target_km(&self) -> f64 {
        haversine_km(self.lat, self.lon, self.target_lat, self.target_lon)
    }
}

// ---------------------------------------------------------------------------
// Physics tick — called by Python every 100ms simulation time
// ---------------------------------------------------------------------------

/// Update a single weapon's state by dt_s seconds.
/// Returns updated state (or marks as DESTROYED/IMPACTED).
pub fn tick_weapon(state: &mut WeaponState, dt_s: f64) {
    if state.suda_state == 4 {
        // DESTROYED — skip
        return;
    }

    // Check impact
    let dist_km = state.distance_to_target_km();
    let speed_kmps = mach_to_kmps(state.speed_mach);
    if dist_km <= speed_kmps * dt_s {
        state.suda_state = 5; // IMPACTED
        state.lat = state.target_lat;
        state.lon = state.target_lon;
        return;
    }

    // Fuel burn
    state.fuel_pct -= state.fuel_burn_rate * dt_s;
    if state.fuel_pct <= 0.0 {
        state.fuel_pct = 0.0;
        state.suda_state = 4; // DESTROYED (fuel exhausted)
        return;
    }

    // Evasion timer countdown
    if state.suda_state == 1 && state.evasion_timer_s > 0.0 {
        state.evasion_timer_s -= dt_s;
        if state.evasion_timer_s <= 0.0 {
            state.suda_state = 2; // transition to REALIGNING
            state.evasion_g = 0.0;
        }
    }
    if state.suda_state == 2 {
        // REALIGNING: steer back to direct bearing
        let bearing_to_tgt = state.bearing_to_target();
        let diff = angle_diff(state.heading_deg, bearing_to_tgt);
        let turn_rate_deg_per_s = g_to_turn_rate(state.evasion_g.max(1.5), state.speed_mach);
        let max_turn = turn_rate_deg_per_s * dt_s;
        if diff.abs() < max_turn {
            state.heading_deg = bearing_to_tgt;
            state.suda_state = 0; // back to CRUISE
        } else {
            state.heading_deg = (state.heading_deg + diff.signum() * max_turn).rem_euclid(360.0);
        }
    }

    // S-turn evasion heading modulation
    let effective_heading = if state.suda_state == 1 && state.evasion_g > 0.0 {
        // Sinusoidal S-turn: oscillate ±offset around base bearing
        let base_bearing = state.bearing_to_target();
        let period_s = 20.0; // S-turn period
        let phase = (state.evasion_timer_s % period_s) / period_s * 2.0 * PI;
        let lateral_deg = state.evasion_lateral_offset / (dist_km + 1.0) * (180.0 / PI);
        (base_bearing + lateral_deg * phase.sin()).rem_euclid(360.0)
    } else {
        // CRUISE: steer directly to target
        state.bearing_to_target()
    };

    state.heading_deg = effective_heading;

    // Domain-specific drag factor
    let drag_factor = match state.domain {
        0 => aerodynamic_drag(state.speed_mach, state.alt_km), // AIR
        1 => 0.97, // SEA: hydrodynamic resistance (simplified)
        2 => 0.98, // LAND: ballistic (minimal drag correction for terminal phase)
        _ => 1.0,
    };

    // Advance position along great circle
    let distance_km = mach_to_kmps(state.speed_mach) * dt_s * drag_factor;
    let (new_lat, new_lon) = move_on_sphere(state.lat, state.lon, state.heading_deg, distance_km);
    state.lat = new_lat;
    state.lon = new_lon;

    // Altitude interpolation (cruise altitude, simple linear descent in terminal phase)
    if state.suda_state == 3 {
        // TERMINAL: dive toward target altitude
        let alt_diff = state.alt_km_target - state.alt_km;
        state.alt_km += alt_diff * (dt_s / (dist_km / mach_to_kmps(state.speed_mach) + 0.001));
    }
}

/// Batch update — called with slice of all active weapons.
/// Rayon parallel iteration is used in saturation.rs for Monte Carlo.
/// Here we do sequential for determinism (consensus requires ordered state).
pub fn tick_all(weapons: &mut [WeaponState], dt_s: f64) {
    for w in weapons.iter_mut() {
        tick_weapon(w, dt_s);
    }
}

// ---------------------------------------------------------------------------
// Evasion initiation — called when SUDA DECIDE triggers S-turn
// ---------------------------------------------------------------------------

/// Configure a weapon for S-turn evasion.
/// duration_s: how long to evade before realigning.
/// g_load: evasion aggressiveness (3–9G).
/// Returns Δτ_i (seconds of delay added to time-to-go).
pub fn initiate_sturn_evasion(
    state: &mut WeaponState,
    duration_s: f64,
    g_load: f64,
    lateral_offset_km: f64,
) -> f64 {
    state.suda_state = 1; // EVADING
    state.evasion_timer_s = duration_s;
    state.evasion_g = g_load;
    state.evasion_lateral_offset = lateral_offset_km;

    // Pythagorean path extension: S-turn ≈ hypotenuse of (direct_path, 2*lateral_offset)
    // Matches greedy_interval_schedule and suda.py for consistent τ accounting.
    let v_kmps = mach_to_kmps(state.speed_mach);
    let direct_path_km = v_kmps * duration_s;
    let sturn_path_km = (direct_path_km.powi(2) + (2.0 * lateral_offset_km).powi(2)).sqrt();
    (sturn_path_km - direct_path_km) / v_kmps
}

// ---------------------------------------------------------------------------
// Math utilities
// ---------------------------------------------------------------------------

/// Haversine great-circle distance (km)
pub fn haversine_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let phi1 = lat1.to_radians();
    let phi2 = lat2.to_radians();
    let dphi = (lat2 - lat1).to_radians();
    let dlambda = (lon2 - lon1).to_radians();
    let a = (dphi / 2.0).sin().powi(2)
        + phi1.cos() * phi2.cos() * (dlambda / 2.0).sin().powi(2);
    EARTH_RADIUS_KM * 2.0 * a.sqrt().atan2((1.0 - a).sqrt())
}

/// Forward bearing from (lat1,lon1) to (lat2,lon2) in degrees [0, 360)
pub fn bearing(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let phi1 = lat1.to_radians();
    let phi2 = lat2.to_radians();
    let dlambda = (lon2 - lon1).to_radians();
    let y = dlambda.sin() * phi2.cos();
    let x = phi1.cos() * phi2.sin() - phi1.sin() * phi2.cos() * dlambda.cos();
    y.atan2(x).to_degrees().rem_euclid(360.0)
}

/// Move a point on the sphere by `distance_km` in `bearing_deg` direction.
pub fn move_on_sphere(lat: f64, lon: f64, bearing_deg: f64, distance_km: f64) -> (f64, f64) {
    let angular_dist = distance_km / EARTH_RADIUS_KM;
    let bearing_rad = bearing_deg.to_radians();
    let lat_r = lat.to_radians();
    let lon_r = lon.to_radians();

    let new_lat_r = (lat_r.sin() * angular_dist.cos()
        + lat_r.cos() * angular_dist.sin() * bearing_rad.cos())
        .asin();
    let new_lon_r = lon_r
        + (bearing_rad.sin() * angular_dist.sin() * lat_r.cos())
            .atan2(angular_dist.cos() - lat_r.sin() * new_lat_r.sin());

    (new_lat_r.to_degrees(), new_lon_r.to_degrees())
}

/// Signed angle difference from `from` to `to` (degrees), range [-180, 180]
fn angle_diff(from: f64, to: f64) -> f64 {
    let diff = (to - from).rem_euclid(360.0);
    if diff > 180.0 { diff - 360.0 } else { diff }
}

/// Mach to km/s (using ISA at ~10km altitude: speed of sound ≈ 299 m/s = 0.299 km/s)
pub fn mach_to_kmps(mach: f64) -> f64 {
    mach * 0.299
}

/// Mach to km/h
pub fn mach_to_kmh(mach: f64) -> f64 {
    mach_to_kmps(mach) * 3600.0
}

/// Turn rate (deg/s) given G-load and Mach (simplified F=mv²/r)
fn g_to_turn_rate(g: f64, mach: f64) -> f64 {
    let v_ms = mach_to_kmps(mach) * 1000.0;
    let radius_m = v_ms.powi(2) / (g * 9.81);
    (v_ms / radius_m).to_degrees() // omega = v/r in rad/s → deg/s
}

/// Simplified aerodynamic drag factor based on Mach and altitude
/// Returns a multiplier [0.85, 1.0] applied to distance covered per tick.
fn aerodynamic_drag(mach: f64, alt_km: f64) -> f64 {
    // Transonic drag rise (Mach 0.8–1.2)
    let transonic_penalty = if mach > 0.8 && mach < 1.2 {
        0.05 * (1.0 - (mach - 1.0).abs() / 0.2)
    } else {
        0.0
    };
    // Altitude benefit: thinner air = less drag (very simplified)
    let alt_benefit = (alt_km / 40.0).min(0.05);
    (1.0 - transonic_penalty + alt_benefit).clamp(0.85, 1.0)
}
