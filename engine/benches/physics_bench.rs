use criterion::{criterion_group, criterion_main, Criterion};
use ghost_engine::*;

fn bench_physics_tick(c: &mut Criterion) {
    // 100-weapon physics tick — gate: <5ms
    c.bench_function("physics_tick_100", |b| {
        b.iter(|| {
            // Placeholder: actual bench wires into ghost_engine internals
            // Run via: cargo bench
            let _ = 1 + 1;
        });
    });
}

criterion_group!(benches, bench_physics_tick);
criterion_main!(benches);
