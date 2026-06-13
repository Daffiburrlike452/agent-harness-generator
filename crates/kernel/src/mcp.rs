// SPDX-License-Identifier: MIT
//
// MCP subsystem: server-registration intent + tool registry.
//
// Host adapters translate `McpServerSpec` into the host-specific config
// (TOML for Codex, JSON for Claude Code, YAML for Hermes). The kernel also
// owns a TOOL REGISTRY: harnesses declare tools, the kernel stores them
// keyed by name+server, and the registry is the source of truth host
// adapters consult when emitting their per-host tool descriptors.

//! MCP server registration intent + tool registry.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Declarative MCP-server intent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpServerSpec {
    pub name: String,
    pub command: Option<Vec<String>>,
    pub url: Option<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
}

/// A declared MCP tool.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolSpec {
    /// Tool name (unique within its server).
    pub name: String,
    /// Server this tool belongs to.
    pub server: String,
    /// Human description shown to the model.
    pub description: String,
    /// JSON-schema for the tool's input (kept as serde_json::Value).
    pub input_schema: serde_json::Value,
}

/// Sanity-check a server spec.
pub fn validate(spec: &McpServerSpec) -> crate::Result<()> {
    if spec.name.is_empty() {
        return Err(crate::Error::Mcp("server name is empty".into()));
    }
    match (&spec.command, &spec.url) {
        (Some(c), None) if !c.is_empty() => Ok(()),
        (None, Some(u)) if !u.is_empty() => Ok(()),
        (Some(_), Some(_)) => Err(crate::Error::Mcp(
            "command and url are mutually exclusive".into(),
        )),
        _ => Err(crate::Error::Mcp(
            "either command or url must be set".into(),
        )),
    }
}

/// Sanity-check a tool spec.
pub fn validate_tool(t: &ToolSpec) -> crate::Result<()> {
    if t.name.is_empty() {
        return Err(crate::Error::Mcp("tool name is empty".into()));
    }
    if t.server.is_empty() {
        return Err(crate::Error::Mcp("tool server is empty".into()));
    }
    // Validate that input_schema parses as an object (top-level JSON schema
    // is always an object).
    if !t.input_schema.is_object() {
        return Err(crate::Error::Mcp("tool input_schema must be a JSON object".into()));
    }
    Ok(())
}

/// In-memory tool registry. Host adapters query this to emit their
/// per-host tool descriptors.
#[derive(Debug, Default, Clone)]
pub struct ToolRegistry {
    tools: BTreeMap<(String, String), ToolSpec>, // key: (server, name)
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a tool. Replaces any prior tool with the same
    /// (server, name) key.
    pub fn register(&mut self, tool: ToolSpec) -> crate::Result<()> {
        validate_tool(&tool)?;
        self.tools.insert((tool.server.clone(), tool.name.clone()), tool);
        Ok(())
    }

    /// Look up a tool by server + name.
    pub fn get(&self, server: &str, name: &str) -> Option<&ToolSpec> {
        self.tools.get(&(server.to_string(), name.to_string()))
    }

    /// List all tools, sorted by (server, name) ascending for stable output.
    pub fn list(&self) -> Vec<&ToolSpec> {
        self.tools.values().collect()
    }

    /// List tools for a specific server.
    pub fn for_server(&self, server: &str) -> Vec<&ToolSpec> {
        self.tools
            .iter()
            .filter(|((s, _), _)| s == server)
            .map(|(_, v)| v)
            .collect()
    }

    /// Count of registered tools.
    pub fn len(&self) -> usize {
        self.tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(server: &str, name: &str) -> ToolSpec {
        ToolSpec {
            name: name.into(),
            server: server.into(),
            description: format!("test tool {name}"),
            input_schema: serde_json::json!({ "type": "object", "properties": {} }),
        }
    }

    #[test]
    fn validate_accepts_stdio() {
        let s = McpServerSpec {
            name: "x".into(),
            command: Some(vec!["npx".into(), "-y".into(), "demo".into()]),
            url: None,
            env: vec![],
        };
        assert!(validate(&s).is_ok());
    }

    #[test]
    fn validate_rejects_empty_name() {
        let s = McpServerSpec {
            name: "".into(),
            command: Some(vec!["x".into()]),
            url: None,
            env: vec![],
        };
        assert!(validate(&s).is_err());
    }

    #[test]
    fn validate_rejects_both() {
        let s = McpServerSpec {
            name: "x".into(),
            command: Some(vec!["x".into()]),
            url: Some("https://x".into()),
            env: vec![],
        };
        assert!(validate(&s).is_err());
    }

    #[test]
    fn validate_rejects_neither() {
        let s = McpServerSpec {
            name: "x".into(),
            command: None,
            url: None,
            env: vec![],
        };
        assert!(validate(&s).is_err());
    }

    #[test]
    fn validate_tool_accepts_object_schema() {
        assert!(validate_tool(&tool("s", "t")).is_ok());
    }

    #[test]
    fn validate_tool_rejects_non_object_schema() {
        let mut t = tool("s", "x");
        t.input_schema = serde_json::json!("not-an-object");
        assert!(validate_tool(&t).is_err());
    }

    #[test]
    fn validate_tool_rejects_empty_name() {
        let mut t = tool("s", "");
        t.name = "".into();
        assert!(validate_tool(&t).is_err());
    }

    #[test]
    fn registry_register_and_get() {
        let mut r = ToolRegistry::new();
        r.register(tool("memory", "store")).unwrap();
        let g = r.get("memory", "store").unwrap();
        assert_eq!(g.name, "store");
    }

    #[test]
    fn registry_replace_on_same_key() {
        let mut r = ToolRegistry::new();
        let mut t1 = tool("memory", "store");
        t1.description = "v1".into();
        let mut t2 = tool("memory", "store");
        t2.description = "v2".into();
        r.register(t1).unwrap();
        r.register(t2).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r.get("memory", "store").unwrap().description, "v2");
    }

    #[test]
    fn registry_for_server_filters() {
        let mut r = ToolRegistry::new();
        r.register(tool("memory", "store")).unwrap();
        r.register(tool("memory", "search")).unwrap();
        r.register(tool("alerts", "fire")).unwrap();
        assert_eq!(r.for_server("memory").len(), 2);
        assert_eq!(r.for_server("alerts").len(), 1);
        assert_eq!(r.for_server("unknown").len(), 0);
    }
}
