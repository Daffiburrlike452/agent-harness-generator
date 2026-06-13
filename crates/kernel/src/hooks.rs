// SPDX-License-Identifier: MIT
//
// Lifecycle hooks with real handler dispatch + permission-decision merging.
//
// Per ADR-004, Claude Code's hook surface is the richest: 5 handler types,
// 10 events, JSON-output-to-influence-the-model semantics, and a three-
// level shape (event -> matcher -> handler[]). The kernel owns the EVENT
// taxonomy, the HANDLER CONTRACT, and the DECISION-MERGE rules. Host
// adapters translate to host-specific files.
//
// The decision-merge rule is the load-bearing security primitive:
//   - Handlers run in order
//   - First handler returning Allow / Deny / Ask wins
//   - Defer cascades to the next handler
//   - If every handler defers, the kernel returns the default (Allow for
//     read-only events, Ask for tool-use events)

//! Lifecycle hook events, handler contract, dispatch + decision merge.

use serde::{Deserialize, Serialize};

/// Hook events shared across hosts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
pub enum HookEvent {
    SessionStart,
    UserPromptSubmit,
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
    Stop,
    SubagentStart,
    SubagentStop,
    FileChanged,
    /// Setup phase (per Claude Code docs).
    Setup,
}

impl HookEvent {
    /// Is this a destructive-action event (tool use)? Determines the
    /// default decision when every handler defers.
    pub fn is_destructive(self) -> bool {
        matches!(
            self,
            HookEvent::PreToolUse | HookEvent::SubagentStart
        )
    }
}

/// Decision a hook handler can return.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionDecision {
    /// Allow the action.
    Allow,
    /// Deny the action.
    Deny,
    /// Ask the user.
    Ask,
    /// Defer to the next handler in the chain.
    Defer,
}

/// A single handler in the hook chain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandlerSpec {
    /// Handler kind — drives how the host adapter dispatches it.
    pub kind: HandlerKind,
    /// Pattern-match-DSL (e.g. "Bash(rm *)") to gate this handler.
    /// `None` means "match everything".
    pub matcher: Option<String>,
    /// Handler-kind-specific payload.
    pub payload: String,
}

/// One of the 5 handler types Claude Code documents (ADR-004 §Claude Code).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HandlerKind {
    /// Shell command. Payload is the command line.
    Command,
    /// HTTP webhook. Payload is the URL.
    Http,
    /// An MCP tool call. Payload is `server/tool`.
    McpTool,
    /// Prompt the model with this text. Payload is the prompt.
    Prompt,
    /// Spawn a subagent. Payload is the agent type name.
    Agent,
}

/// The output a handler returns, as serialised by the host process.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HandlerOutput {
    pub decision: Option<PermissionDecision>,
    pub additional_context: Option<String>,
    pub updated_input: Option<serde_json::Value>,
}

/// Match a matcher pattern against an input string.
///
/// Patterns supported (small but useful subset):
///   - `*`           matches anything
///   - `Foo`         exact match
///   - `Bash(*)`     a name with any args
///   - `Bash(rm *)`  prefix match inside parens
pub fn matcher_matches(matcher: Option<&str>, input: &str) -> bool {
    let pat = match matcher {
        None => return true,
        Some(p) => p,
    };
    if pat == "*" || pat == input {
        return true;
    }
    // "Name(pattern)" form
    if let (Some(open), Some(close)) = (pat.find('('), pat.rfind(')')) {
        if close + 1 == pat.len() && open < close {
            let name = &pat[..open];
            let inner = &pat[open + 1..close];
            // Match "Name(..." prefix on the input
            if let (Some(in_open), Some(in_close)) = (input.find('('), input.rfind(')')) {
                if in_close + 1 == input.len() && in_open < in_close {
                    let input_name = &input[..in_open];
                    let input_inner = &input[in_open + 1..in_close];
                    if input_name != name {
                        return false;
                    }
                    return glob_match(inner, input_inner);
                }
            }
            return false;
        }
    }
    false
}

/// Minimal glob: '*' matches anything, everything else is literal.
fn glob_match(pat: &str, s: &str) -> bool {
    if pat == "*" {
        return true;
    }
    if let Some(star) = pat.find('*') {
        let prefix = &pat[..star];
        let suffix = &pat[star + 1..];
        return s.starts_with(prefix) && s.ends_with(suffix) && s.len() >= prefix.len() + suffix.len();
    }
    pat == s
}

/// Resolve a sequence of handler decisions into a final decision per the
/// defer-cascade rule. The default depends on the event (destructive -> Ask,
/// non-destructive -> Allow).
pub fn merge_decisions(decisions: &[PermissionDecision], event: HookEvent) -> PermissionDecision {
    for d in decisions {
        if *d != PermissionDecision::Defer {
            return *d;
        }
    }
    if event.is_destructive() {
        PermissionDecision::Ask
    } else {
        PermissionDecision::Allow
    }
}

/// Filter a list of handlers down to those whose matcher applies to the
/// given input.
pub fn applicable_handlers<'a>(handlers: &'a [HandlerSpec], input: &str) -> Vec<&'a HandlerSpec> {
    handlers.iter().filter(|h| matcher_matches(h.matcher.as_deref(), input)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_serializes() {
        let s = serde_json::to_string(&HookEvent::SessionStart).unwrap();
        assert_eq!(s, "\"SessionStart\"");
    }

    #[test]
    fn permission_serializes() {
        let s = serde_json::to_string(&PermissionDecision::Deny).unwrap();
        assert_eq!(s, "\"Deny\"");
    }

    #[test]
    fn destructive_event_default_is_ask() {
        assert_eq!(merge_decisions(&[], HookEvent::PreToolUse), PermissionDecision::Ask);
    }

    #[test]
    fn non_destructive_event_default_is_allow() {
        assert_eq!(merge_decisions(&[], HookEvent::SessionStart), PermissionDecision::Allow);
    }

    #[test]
    fn defer_cascades_to_next() {
        let r = merge_decisions(
            &[PermissionDecision::Defer, PermissionDecision::Deny],
            HookEvent::PreToolUse,
        );
        assert_eq!(r, PermissionDecision::Deny);
    }

    #[test]
    fn first_non_defer_wins() {
        let r = merge_decisions(
            &[PermissionDecision::Allow, PermissionDecision::Deny],
            HookEvent::PreToolUse,
        );
        assert_eq!(r, PermissionDecision::Allow);
    }

    #[test]
    fn star_matcher_matches_anything() {
        assert!(matcher_matches(Some("*"), "Anything"));
        assert!(matcher_matches(None, "Anything"));
    }

    #[test]
    fn exact_matcher() {
        assert!(matcher_matches(Some("Edit"), "Edit"));
        assert!(!matcher_matches(Some("Edit"), "Write"));
    }

    #[test]
    fn name_with_arg_matcher() {
        assert!(matcher_matches(Some("Bash(*)"), "Bash(ls)"));
        assert!(matcher_matches(Some("Bash(rm *)"), "Bash(rm -rf /tmp)"));
        assert!(!matcher_matches(Some("Bash(rm *)"), "Bash(ls)"));
        // Name mismatch.
        assert!(!matcher_matches(Some("Bash(*)"), "Edit(file)"));
    }

    #[test]
    fn applicable_filters_correctly() {
        let handlers = vec![
            HandlerSpec { kind: HandlerKind::Command, matcher: Some("Bash(*)".into()), payload: "log.sh".into() },
            HandlerSpec { kind: HandlerKind::Command, matcher: Some("Edit".into()), payload: "track.sh".into() },
            HandlerSpec { kind: HandlerKind::Command, matcher: None, payload: "always.sh".into() },
        ];
        let app = applicable_handlers(&handlers, "Bash(echo hi)");
        assert_eq!(app.len(), 2); // Bash(*) and the None-matcher
    }
}
