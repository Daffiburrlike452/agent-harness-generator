// SPDX-License-Identifier: MIT
//
// Claims-based authorization with real scope matching + expiry.
//
// Per ADR-014 (Self-evolution + federation), federated harness calls pass
// signed claims describing what the holder may do. The kernel's job:
//   - Validate the claim hasn't expired
//   - Match the requested capability against the granted scope
//   - Defer signature verification to the witness subsystem (Ed25519)
//
// Claim format mirrors ruflo's existing claims authorizer (ADR-010 in
// ruflo) so federated harnesses can interop.

//! Claims-based authorization.

use serde::{Deserialize, Serialize};

/// A single capability claim.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Claim {
    /// Capability name (e.g. `memory.read`, `tool.invoke`, `*` for wildcard).
    pub capability: String,
    /// Optional resource scope (e.g. namespace, tool name, `agents/*`).
    pub resource: Option<String>,
    /// Unix-timestamp expiry (seconds).
    pub expires_at: i64,
}

/// Result of an authorization check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthDecision {
    /// Allowed by claim ID (returned for telemetry).
    Allowed,
    /// Denied — claim expired, missing, or scope mismatch.
    Denied { reason: String },
}

/// Check whether ANY claim in `claims` authorizes the requested
/// `capability` on the optional `resource` at the current `now_unix`.
///
/// Matching rules:
///   - `capability == "*"` matches anything.
///   - capability exact match.
///   - capability prefix-match with `.`: `memory.*` matches `memory.read`.
///   - resource None on the claim = unscoped, matches any resource.
///   - resource exact match.
///   - resource glob with `*`: `agents/*` matches `agents/coder`.
///   - expired claims (expires_at <= now_unix) are skipped.
pub fn check(claims: &[Claim], capability: &str, resource: Option<&str>, now_unix: i64) -> AuthDecision {
    if claims.is_empty() {
        return AuthDecision::Denied { reason: "no claims provided".into() };
    }
    for claim in claims {
        if claim.expires_at <= now_unix {
            continue;
        }
        if !capability_matches(&claim.capability, capability) {
            continue;
        }
        if !resource_matches(claim.resource.as_deref(), resource) {
            continue;
        }
        return AuthDecision::Allowed;
    }
    AuthDecision::Denied { reason: "no matching unexpired claim".into() }
}

fn capability_matches(granted: &str, requested: &str) -> bool {
    if granted == "*" || granted == requested {
        return true;
    }
    if let Some(prefix) = granted.strip_suffix(".*") {
        return requested.starts_with(prefix) && requested.len() > prefix.len() && requested.as_bytes()[prefix.len()] == b'.';
    }
    false
}

fn resource_matches(granted: Option<&str>, requested: Option<&str>) -> bool {
    match (granted, requested) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(g), Some(r)) => {
            if g == r || g == "*" {
                return true;
            }
            if let Some(prefix) = g.strip_suffix("/*") {
                return r.starts_with(prefix) && r.len() > prefix.len() && r.as_bytes()[prefix.len()] == b'/';
            }
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> i64 { 1_700_000_000 }

    fn claim(cap: &str, res: Option<&str>, ttl: i64) -> Claim {
        Claim { capability: cap.into(), resource: res.map(String::from), expires_at: now() + ttl }
    }

    #[test]
    fn empty_claims_denied() {
        assert!(matches!(check(&[], "x", None, now()), AuthDecision::Denied { .. }));
    }

    #[test]
    fn exact_match_allowed() {
        let c = vec![claim("memory.read", Some("ns/x"), 1000)];
        assert_eq!(check(&c, "memory.read", Some("ns/x"), now()), AuthDecision::Allowed);
    }

    #[test]
    fn wildcard_capability_matches_anything() {
        let c = vec![claim("*", None, 1000)];
        assert_eq!(check(&c, "memory.write", Some("ns/y"), now()), AuthDecision::Allowed);
    }

    #[test]
    fn prefix_capability_matches() {
        let c = vec![claim("memory.*", None, 1000)];
        assert_eq!(check(&c, "memory.read", None, now()), AuthDecision::Allowed);
        assert_eq!(check(&c, "memory.write", None, now()), AuthDecision::Allowed);
        assert!(matches!(check(&c, "tool.invoke", None, now()), AuthDecision::Denied { .. }));
    }

    #[test]
    fn prefix_capability_does_not_match_partial() {
        // "memory.*" must NOT match "memoryx" — the dot is significant.
        let c = vec![claim("memory.*", None, 1000)];
        assert!(matches!(check(&c, "memoryx", None, now()), AuthDecision::Denied { .. }));
    }

    #[test]
    fn unscoped_claim_matches_any_resource() {
        let c = vec![claim("memory.read", None, 1000)];
        assert_eq!(check(&c, "memory.read", Some("ns/x"), now()), AuthDecision::Allowed);
        assert_eq!(check(&c, "memory.read", None, now()), AuthDecision::Allowed);
    }

    #[test]
    fn scoped_claim_with_glob() {
        let c = vec![claim("memory.read", Some("agents/*"), 1000)];
        assert_eq!(check(&c, "memory.read", Some("agents/coder"), now()), AuthDecision::Allowed);
        assert!(matches!(check(&c, "memory.read", Some("skills/x"), now()), AuthDecision::Denied { .. }));
    }

    #[test]
    fn expired_claim_skipped() {
        let c = vec![claim("memory.read", None, -1)];
        assert!(matches!(check(&c, "memory.read", None, now()), AuthDecision::Denied { .. }));
    }

    #[test]
    fn first_matching_unexpired_wins() {
        let c = vec![
            claim("memory.read", None, -1), // expired
            claim("memory.read", None, 1000),
        ];
        assert_eq!(check(&c, "memory.read", None, now()), AuthDecision::Allowed);
    }

    #[test]
    fn claim_serializes() {
        let c = Claim {
            capability: "memory.read".into(),
            resource: Some("ns/x".into()),
            expires_at: 0,
        };
        let s = serde_json::to_string(&c).unwrap();
        assert!(s.contains("memory.read"));
    }
}
