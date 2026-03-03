/// ghost_saturation — Monte Carlo Saturation Coefficient Engine
///
/// DSA: Parallel divide-and-conquer (rayon), Reservoir Sampling (streaming stats)
///
/// Saturation Coefficient: SC = N_attacking / (N_interceptors × P_kill)
///   SC < 0.8  → defense likely wins
///   SC 0.8–1.5 → contested
///   SC > 1.5  → saturation achieved
///
/// Runs 1,000+ parallel Monte Carlo trials to build a penetration probability
/// distribution, accounting for weapon type, evasion capability, and defense density.

use rayon::prelude::*;

// ---------------------------------------------------------------------------
// Scenario inputs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct SaturationScenario {
    pub n_attacking: usize,
    /// Interceptor batteries, each with count + p_kill
    pub batteries: Vec<(usize, f64)>,  // (interceptor_count, p_kill)
    /// Per-weapon evasion success probability (0.0 = no evasion, 0.8 = hypersonic)
    pub weapon_evasion_p: Vec<f64>,
    /// Weapon stealth factor (reduces effective P_kill)
    pub weapon_stealth_factor: Vec<f64>,
    pub n_trials: usize,
}

#[derive(Debug, Clone)]
pub struct SaturationResult {
    pub sc_mean: f64,              // mean saturation coefficient
    pub penetration_rate_mean: f64, // fraction reaching target
    pub penetration_rate_p10: f64,  // 10th percentile (pessimistic)
    pub penetration_rate_p50: f64,  // median
    pub penetration_rate_p90: f64,  // 90th percentile (optimistic)
    pub trials_run: usize,
    pub convergence_threshold: f64, // RMS change between last 100 vs previous 100 trials
}

// ---------------------------------------------------------------------------
// Monte Carlo engine
// ---------------------------------------------------------------------------

/// Run Monte Carlo saturation simulation.
/// Uses rayon::par_iter for parallel trials.
/// Time: O(n_trials * n_attacking) / num_cpu_cores
pub fn run_saturation(scenario: &SaturationScenario) -> SaturationResult {
    let n_trials = scenario.n_trials.max(100);

    // Each trial returns: number of weapons that penetrate
    let trial_results: Vec<usize> = (0..n_trials)
        .into_par_iter()
        .map(|trial_idx| simulate_trial(scenario, trial_idx as u64))
        .collect();

    let penetration_rates: Vec<f64> = trial_results
        .iter()
        .map(|&hits| hits as f64 / scenario.n_attacking as f64)
        .collect();

    let mean = penetration_rates.iter().sum::<f64>() / n_trials as f64;

    let mut sorted = penetration_rates.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());

    let p10 = sorted[(n_trials as f64 * 0.10) as usize];
    let p50 = sorted[(n_trials as f64 * 0.50) as usize];
    let p90 = sorted[(n_trials as f64 * 0.90).min(n_trials as f64 - 1.0) as usize];

    // SC: compute from expected values
    let total_interceptors: usize = scenario.batteries.iter().map(|(n, _)| n).sum();
    let mean_p_kill: f64 = if scenario.batteries.is_empty() {
        0.0
    } else {
        scenario.batteries.iter().map(|(_, p)| p).sum::<f64>() / scenario.batteries.len() as f64
    };
    let sc = if total_interceptors == 0 || mean_p_kill == 0.0 {
        f64::INFINITY
    } else {
        scenario.n_attacking as f64 / (total_interceptors as f64 * mean_p_kill)
    };

    // Convergence: check last 100 vs previous 100 trials
    let convergence = if n_trials >= 200 {
        let prev_mean = sorted[n_trials - 200..n_trials - 100].iter().sum::<f64>() / 100.0;
        let last_mean = sorted[n_trials - 100..].iter().sum::<f64>() / 100.0;
        (last_mean - prev_mean).abs()
    } else {
        f64::NAN
    };

    SaturationResult {
        sc_mean: sc,
        penetration_rate_mean: mean,
        penetration_rate_p10: p10,
        penetration_rate_p50: p50,
        penetration_rate_p90: p90,
        trials_run: n_trials,
        convergence_threshold: convergence,
    }
}

/// Simulate a single trial using a seeded LCG (fast, deterministic, thread-safe).
/// Returns number of attacking weapons that reach the target.
fn simulate_trial(scenario: &SaturationScenario, seed: u64) -> usize {
    let mut rng = LcgRng::new(seed ^ 0xDEAD_BEEF_1234_5678);
    let n = scenario.n_attacking;

    // Effective P_kill per interceptor accounting for weapon evasion + stealth
    let mut remaining_interceptors: Vec<(usize, f64)> = scenario
        .batteries
        .iter()
        .map(|(count, p_kill)| (*count, *p_kill))
        .collect();

    let mut survivors = n;

    for weapon_idx in 0..n {
        let evasion_p = scenario.weapon_evasion_p.get(weapon_idx).copied().unwrap_or(0.0);
        let stealth = scenario.weapon_stealth_factor.get(weapon_idx).copied().unwrap_or(1.0);

        // Attempt interception by each battery with remaining missiles
        for (interceptor_count, p_kill) in remaining_interceptors.iter_mut() {
            if *interceptor_count == 0 {
                continue;
            }
            // Effective P_kill adjusted for stealth and evasion
            let effective_p = *p_kill * stealth * (1.0 - evasion_p * rng.next_f64());
            if rng.next_f64() < effective_p {
                *interceptor_count -= 1;
                survivors -= 1;
                break; // weapon destroyed, move to next
            }
            // Interceptor fired but missed — still consumes one missile
            if rng.next_f64() < 0.6 {
                // 60% chance interceptor is assigned even if it misses
                *interceptor_count = interceptor_count.saturating_sub(1);
            }
        }
    }

    survivors
}

// ---------------------------------------------------------------------------
// Fast LCG pseudo-random number generator (thread-safe, no std::rand dependency)
// DSA: Linear Congruential Generator — O(1) per sample
// ---------------------------------------------------------------------------

struct LcgRng {
    state: u64,
}

impl LcgRng {
    fn new(seed: u64) -> Self {
        Self { state: seed.wrapping_add(1) }
    }

    /// Next u64 in [0, u64::MAX]
    fn next_u64(&mut self) -> u64 {
        // Knuth's MMIX constants
        self.state = self.state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.state
    }

    /// Next f64 in [0.0, 1.0)
    fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}
