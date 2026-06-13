// SPDX-License-Identifier: MIT
//
// Benchmark Ed25519 sign/verify on a realistic-sized witness manifest.
// Per-release signing — must stay fast enough to not bottleneck CI publish.

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use ed25519_dalek::SigningKey;
use ruflo_kernel::witness::{sign_manifest, verify_manifest, WitnessEntry};

fn make_entries(n: usize) -> Vec<WitnessEntry> {
    (0..n).map(|i| WitnessEntry {
        id: format!("fix-{i:04}"),
        desc: format!("Entry {i} description"),
        marker: format!("src/file_{i}.rs"),
        sha256: format!("{:0>64}", i),
    }).collect()
}

fn bench_sign_small(c: &mut Criterion) {
    let key = SigningKey::from_bytes(&[7u8; 32]);
    let entries = make_entries(10);
    c.bench_function("witness sign (10 entries)", |b| {
        b.iter(|| {
            let _ = sign_manifest(&key, "demo", "1.0.0", black_box(entries.clone())).unwrap();
        })
    });
}

fn bench_sign_medium(c: &mut Criterion) {
    let key = SigningKey::from_bytes(&[7u8; 32]);
    let entries = make_entries(100);
    c.bench_function("witness sign (100 entries)", |b| {
        b.iter(|| {
            let _ = sign_manifest(&key, "demo", "1.0.0", black_box(entries.clone())).unwrap();
        })
    });
}

fn bench_verify(c: &mut Criterion) {
    let key = SigningKey::from_bytes(&[7u8; 32]);
    let m = sign_manifest(&key, "demo", "1.0.0", make_entries(50)).unwrap();
    c.bench_function("witness verify (50 entries)", |b| {
        b.iter(|| {
            let _ = verify_manifest(black_box(&m)).unwrap();
        })
    });
}

criterion_group!(benches, bench_sign_small, bench_sign_medium, bench_verify);
criterion_main!(benches);
