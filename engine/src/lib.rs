/// ghost-engine — PyO3 bindings for Python
/// Exposes ghost_physics, ghost_tot, ghost_saturation to the FastAPI backend.

mod physics;
mod tot;
mod saturation;

use pyo3::prelude::*;
use pyo3::types::PyDict;

// ---------------------------------------------------------------------------
// Physics bindings
// ---------------------------------------------------------------------------

#[pyfunction]
fn tick_weapons(
    _py: Python,
    weapons_data: Vec<&PyDict>,
    dt_s: f64,
) -> PyResult<Vec<PyObject>> {
    let mut states: Vec<physics::WeaponState> = weapons_data
        .iter()
        .map(|d| dict_to_weapon_state(d))
        .collect::<PyResult<Vec<_>>>()?;

    physics::tick_all(&mut states, dt_s);

    let results = states
        .iter()
        .map(|s| weapon_state_to_dict(_py, s))
        .collect::<PyResult<Vec<_>>>()?;
    Ok(results)
}

#[pyfunction]
fn initiate_sturn(
    _py: Python,
    weapon_dict: &PyDict,
    duration_s: f64,
    g_load: f64,
    lateral_offset_km: f64,
) -> PyResult<(PyObject, f64)> {
    let mut state = dict_to_weapon_state(weapon_dict)?;
    let delta_tau = physics::initiate_sturn_evasion(&mut state, duration_s, g_load, lateral_offset_km);
    let updated = weapon_state_to_dict(_py, &state)?;
    Ok((updated, delta_tau))
}

#[pyfunction]
fn haversine(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    physics::haversine_km(lat1, lon1, lat2, lon2)
}

#[pyfunction]
fn compute_bearing(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    physics::bearing(lat1, lon1, lat2, lon2)
}

// ---------------------------------------------------------------------------
// Saturation bindings
// ---------------------------------------------------------------------------

#[pyfunction]
fn run_saturation_monte_carlo(
    _py: Python,
    n_attacking: usize,
    batteries: Vec<(usize, f64)>,
    weapon_evasion_p: Vec<f64>,
    weapon_stealth_factor: Vec<f64>,
    n_trials: usize,
) -> PyResult<PyObject> {
    let scenario = saturation::SaturationScenario {
        n_attacking,
        batteries,
        weapon_evasion_p,
        weapon_stealth_factor,
        n_trials,
    };
    let result = saturation::run_saturation(&scenario);

    let dict = _py.eval("dict()", None, None)?.extract::<&PyDict>()?;
    dict.set_item("sc_mean", result.sc_mean)?;
    dict.set_item("penetration_rate_mean", result.penetration_rate_mean)?;
    dict.set_item("penetration_rate_p10", result.penetration_rate_p10)?;
    dict.set_item("penetration_rate_p50", result.penetration_rate_p50)?;
    dict.set_item("penetration_rate_p90", result.penetration_rate_p90)?;
    dict.set_item("trials_run", result.trials_run)?;
    Ok(dict.into())
}

// ---------------------------------------------------------------------------
// Module registration
// ---------------------------------------------------------------------------

#[pymodule]
fn ghost_engine(_py: Python, m: &PyModule) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(tick_weapons, m)?)?;
    m.add_function(wrap_pyfunction!(initiate_sturn, m)?)?;
    m.add_function(wrap_pyfunction!(haversine, m)?)?;
    m.add_function(wrap_pyfunction!(compute_bearing, m)?)?;
    m.add_function(wrap_pyfunction!(run_saturation_monte_carlo, m)?)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

fn dict_to_weapon_state(d: &PyDict) -> PyResult<physics::WeaponState> {
    Ok(physics::WeaponState {
        id:                    d.get_item("id")?.map(|v| v.extract::<u64>()).transpose()?.unwrap_or(0),
        lat:                   d.get_item("lat")?.map(|v| v.extract::<f64>()).transpose()?.unwrap_or(0.0),
        lon:                   d.get_item("lon")?.map(|v| v.extract::<f64>()).transpose()?.unwrap_or(0.0),
        alt_km:                d.get_item("alt_km")?.map(|v| v.extract::<f64>()).transpose()?.unwrap_or(10.0),
        heading_deg:           d.get_item("heading_deg")?.map(|v| v.extract::<f64>()).transpose()?.unwrap_or(0.0),
        speed_mach:            d.get_item("speed_mach")?.map(|v| v.extract::<f64>()).transpose()?.unwrap_or(0.8),
        speed_max_mach:        d.get_item("speed_max_mach")?.map(|v| v.extract::<f64>()).transpose()?.unwrap_or(0.9),
        speed_min_mach:        d.get_item("speed_min_mach")?.map(|v| v.extract::<f64>()).transpose()?.unwrap_or(0.5),
        fuel_pct:              d.get_item("fuel_pct")?.map(|v| v.extract::<f64>()).transpose()?.unwrap_or(1.0),
        fuel_burn_rate:        d.get_item("fuel_burn_rate")?.map(|v| v.extract::<f64>()).transpose()?.unwrap_or(0.001),
        domain:                d.get_item("domain")?.map(|v| v.extract::<u8>()).transpose()?.unwrap_or(0),
        tau_i:                 d.get_item("tau_i")?.map(|v| v.extract::<f64>()).transpose()?.unwrap_or(0.0),
        suda_state:            d.get_item("suda_state")?.map(|v| v.extract::<u8>()).transpose()?.unwrap_or(0),
        evasion_timer_s:       d.get_item("evasion_timer_s")?.map(|v| v.extract::<f64>()).transpose()?.unwrap_or(0.0),
        evasion_g:             d.get_item("evasion_g")?.map(|v| v.extract::<f64>()).transpose()?.unwrap_or(0.0),
        evasion_lateral_offset:d.get_item("evasion_lateral_offset")?.map(|v| v.extract::<f64>()).transpose()?.unwrap_or(0.0),
        target_lat:            d.get_item("target_lat")?.map(|v| v.extract::<f64>()).transpose()?.unwrap_or(0.0),
        target_lon:            d.get_item("target_lon")?.map(|v| v.extract::<f64>()).transpose()?.unwrap_or(0.0),
        alt_km_target:         d.get_item("alt_km_target")?.map(|v| v.extract::<f64>()).transpose()?.unwrap_or(0.0),
    })
}

fn weapon_state_to_dict(py: Python, s: &physics::WeaponState) -> PyResult<PyObject> {
    let dict = PyDict::new(py);
    dict.set_item("id", s.id)?;
    dict.set_item("lat", s.lat)?;
    dict.set_item("lon", s.lon)?;
    dict.set_item("alt_km", s.alt_km)?;
    dict.set_item("heading_deg", s.heading_deg)?;
    dict.set_item("speed_mach", s.speed_mach)?;
    dict.set_item("fuel_pct", s.fuel_pct)?;
    dict.set_item("tau_i", s.tau_i)?;
    dict.set_item("suda_state", s.suda_state)?;
    dict.set_item("evasion_timer_s", s.evasion_timer_s)?;
    Ok(dict.into())
}
