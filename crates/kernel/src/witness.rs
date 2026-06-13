// SPDX-License-Identifier: MIT
//
// Witness manifest — Ed25519-signed provenance.
//
// Mirrors ruflo ADR-103 (witness-manifest) applied per ADR-011 to generated
// harnesses. Every harness ships with a signed `witness.json` plus a JSONL
// temporal history; the kernel owns the manifest SHAPE, the CANONICALISER
// (deterministic JSON ordering so signatures verify across CI runners and
// across our two compile targets), and the SIGN/VERIFY primitives via
// `ed25519-dalek`.
//
// Wasm byte-determinism is what makes this work — see ADR-002a's
// "wasm makes the witness work" section.

//! Witness manifest shape, canonicaliser, and Ed25519 sign/verify.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// A single fix / artifact entry in the witness manifest.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WitnessEntry {
    /// Stable id (e.g. `fix-2364` or a sha256).
    pub id: String,
    /// What this entry describes.
    pub desc: String,
    /// File path or grep-marker that uniquely identifies the artifact.
    pub marker: String,
    /// sha256 of the marker target.
    pub sha256: String,
}

/// A signed witness manifest. Sign with `sign_manifest`, ship as JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WitnessManifest {
    /// Manifest schema version. Bump only on breaking shape changes.
    pub schema: u32,
    /// The harness this manifest belongs to.
    pub harness: String,
    /// Semver version of the harness this manifest signs.
    pub version: String,
    /// Per-entry fix/artifact records, sorted by id ascending for determinism.
    pub entries: Vec<WitnessEntry>,
    /// Hex-encoded Ed25519 public key (32 bytes => 64 hex chars).
    pub public_key: String,
    /// Hex-encoded Ed25519 signature over the canonicalised payload.
    pub signature: String,
}

/// Canonicalise the manifest payload (everything except the signature
/// itself) into a deterministic byte sequence suitable for signing.
///
/// Determinism contract:
///   1. Entries are sorted by `id` ascending before serialisation.
///   2. Serialisation uses serde_json with the default ordering of struct
///      fields (deterministic because serde_json preserves struct order).
///   3. Strings are NOT normalised — caller's responsibility.
///
/// The output bytes are exactly what gets signed. Use the same function
/// for verify.
pub fn canonical_payload(harness: &str, version: &str, entries: &[WitnessEntry]) -> crate::Result<Vec<u8>> {
    let mut sorted = entries.to_vec();
    sorted.sort_by(|a, b| a.id.cmp(&b.id));
    #[derive(Serialize)]
    struct Payload<'a> {
        schema: u32,
        harness: &'a str,
        version: &'a str,
        entries: &'a [WitnessEntry],
    }
    let payload = Payload {
        schema: 1,
        harness,
        version,
        entries: &sorted,
    };
    serde_json::to_vec(&payload).map_err(|e| crate::Error::Witness(format!("canonical: {e}")))
}

/// Sign a witness manifest payload with the given signing key.
/// Returns the signed `WitnessManifest`.
pub fn sign_manifest(
    signing_key: &SigningKey,
    harness: &str,
    version: &str,
    entries: Vec<WitnessEntry>,
) -> crate::Result<WitnessManifest> {
    let bytes = canonical_payload(harness, version, &entries)?;
    let sig: Signature = signing_key.sign(&bytes);
    let mut sorted = entries;
    sorted.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(WitnessManifest {
        schema: 1,
        harness: harness.to_string(),
        version: version.to_string(),
        entries: sorted,
        public_key: hex::encode(signing_key.verifying_key().to_bytes()),
        signature: hex::encode(sig.to_bytes()),
    })
}

/// Verify a witness manifest's signature. Returns `Ok(true)` on a valid
/// signature, `Ok(false)` on a structurally-correct but invalid signature,
/// and `Err` on parse failures (malformed hex, wrong length, etc.).
pub fn verify_manifest(m: &WitnessManifest) -> crate::Result<bool> {
    if m.schema != 1 {
        return Err(crate::Error::Witness(format!(
            "unsupported schema version {}",
            m.schema
        )));
    }
    let pk_bytes = hex::decode(&m.public_key)
        .map_err(|e| crate::Error::Witness(format!("public_key hex: {e}")))?;
    let pk_arr: [u8; 32] = pk_bytes
        .try_into()
        .map_err(|_| crate::Error::Witness("public_key must be 32 bytes".into()))?;
    let vk = VerifyingKey::from_bytes(&pk_arr)
        .map_err(|e| crate::Error::Witness(format!("public_key: {e}")))?;
    let sig_bytes = hex::decode(&m.signature)
        .map_err(|e| crate::Error::Witness(format!("signature hex: {e}")))?;
    let sig_arr: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| crate::Error::Witness("signature must be 64 bytes".into()))?;
    let sig = Signature::from_bytes(&sig_arr);
    let payload = canonical_payload(&m.harness, &m.version, &m.entries)?;
    Ok(vk.verify(&payload, &sig).is_ok())
}

/// Compute the sha256 of arbitrary bytes (used by the witness CLI to
/// fingerprint marker files).
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    // A deterministic test signing key (32 zero bytes -> not a real key
    // but lets us pin signatures across runs without rand_core).
    fn test_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    #[test]
    fn entry_serializes() {
        let e = WitnessEntry {
            id: "fix-x".into(),
            desc: "x".into(),
            marker: "src/x.rs".into(),
            sha256: "0".repeat(64),
        };
        let s = serde_json::to_string(&e).unwrap();
        assert!(s.contains("fix-x"));
    }

    #[test]
    fn sign_then_verify_succeeds() {
        let key = test_key();
        let entries = vec![
            WitnessEntry {
                id: "a".into(),
                desc: "first".into(),
                marker: "src/a.rs".into(),
                sha256: "0".repeat(64),
            },
            WitnessEntry {
                id: "b".into(),
                desc: "second".into(),
                marker: "src/b.rs".into(),
                sha256: "1".repeat(64),
            },
        ];
        let m = sign_manifest(&key, "demo", "1.0.0", entries).unwrap();
        assert!(verify_manifest(&m).unwrap());
    }

    #[test]
    fn entries_are_sorted_for_determinism() {
        let key = test_key();
        let entries_unsorted = vec![
            WitnessEntry { id: "z".into(), desc: "z".into(), marker: "z".into(), sha256: "0".repeat(64) },
            WitnessEntry { id: "a".into(), desc: "a".into(), marker: "a".into(), sha256: "0".repeat(64) },
        ];
        let m1 = sign_manifest(&key, "h", "1.0.0", entries_unsorted.clone()).unwrap();
        let mut entries_sorted = entries_unsorted;
        entries_sorted.sort_by(|a, b| a.id.cmp(&b.id));
        let m2 = sign_manifest(&key, "h", "1.0.0", entries_sorted).unwrap();
        assert_eq!(m1.signature, m2.signature,
            "signature must be invariant to input entry order");
    }

    #[test]
    fn tampering_with_an_entry_invalidates() {
        let key = test_key();
        let entries = vec![WitnessEntry {
            id: "a".into(), desc: "a".into(), marker: "a".into(), sha256: "0".repeat(64),
        }];
        let mut m = sign_manifest(&key, "h", "1.0.0", entries).unwrap();
        m.entries[0].desc = "tampered".into();
        assert!(!verify_manifest(&m).unwrap());
    }

    #[test]
    fn tampering_with_the_version_invalidates() {
        let key = test_key();
        let entries = vec![WitnessEntry {
            id: "a".into(), desc: "a".into(), marker: "a".into(), sha256: "0".repeat(64),
        }];
        let mut m = sign_manifest(&key, "h", "1.0.0", entries).unwrap();
        m.version = "1.0.1".into();
        assert!(!verify_manifest(&m).unwrap());
    }

    #[test]
    fn bad_public_key_hex_returns_err() {
        let m = WitnessManifest {
            schema: 1,
            harness: "h".into(),
            version: "1.0.0".into(),
            entries: vec![],
            public_key: "not-hex".into(),
            signature: "0".repeat(128),
        };
        assert!(verify_manifest(&m).is_err());
    }

    #[test]
    fn wrong_schema_returns_err() {
        let m = WitnessManifest {
            schema: 999,
            harness: "h".into(),
            version: "1.0.0".into(),
            entries: vec![],
            public_key: "0".repeat(64),
            signature: "0".repeat(128),
        };
        assert!(verify_manifest(&m).is_err());
    }

    #[test]
    fn sha256_hex_is_64_hex_chars() {
        let h = sha256_hex(b"hello");
        assert_eq!(h.len(), 64);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
