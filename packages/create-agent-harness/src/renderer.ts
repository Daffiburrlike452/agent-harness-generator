// SPDX-License-Identifier: MIT
//
// Template renderer. Keeps the dependency surface tiny — Mustache-style
// {{var}} interpolation for text templates, no full Jinja/Handlebars
// dependency. AST-aware identifier rename for TypeScript files lands in
// the iter-4 follow-up; for now the text renderer handles all template
// files.
//
// Drift detection (ADR-008) will hash the *rendered* output and the
// *unrendered* template so `harness upgrade` can detect changes on either
// side.

export interface TemplateVars {
  [key: string]: string | number | boolean | undefined;
}

/**
 * Render a Mustache-style template by substituting {{var}} occurrences.
 *
 * Contract:
 *   - {{var}} is replaced with vars[var] if defined, else left in place
 *     (so partial renders are detectable downstream by the lint step)
 *   - {{var.path}} dotted keys are NOT supported in iter 3 — flat keys only
 *   - Escaping: no built-in HTML escape. Templates that need JSON-safe
 *     output should pre-escape their vars; this is template-engine-agnostic.
 *   - Whitespace inside {{ }} is tolerated: {{  name  }} renders the same
 *     as {{name}}.
 *
 * Returns the rendered string and a list of any unresolved variable names
 * (so the CLI can warn about missing vars).
 */
export function render(template: string, vars: TemplateVars): { output: string; unresolved: string[] } {
  const unresolved = new Set<string>();
  const output = template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (match, name: string) => {
    const v = vars[name];
    if (v === undefined) {
      unresolved.add(name);
      return match;
    }
    return String(v);
  });
  return { output, unresolved: Array.from(unresolved).sort() };
}

/**
 * Extract every {{var}} reference from a template so we can verify the
 * template's declared vars (in its manifest.json) match the ones it
 * actually uses. Run this as a pre-commit lint on the template directory.
 */
export function extractVarReferences(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)) {
    seen.add(m[1]!);
  }
  return Array.from(seen).sort();
}

/**
 * Validate that a harness name is npm-publishable. Mirrors npm's own
 * package-name validation (https://docs.npmjs.com/cli/v10/configuring-npm/package-json#name)
 * with the additional kebab-case + leading-letter rule generated harnesses
 * inherit.
 */
export function validateHarnessName(name: string): { valid: boolean; reason?: string } {
  if (typeof name !== 'string' || name.length === 0) {
    return { valid: false, reason: 'name must be a non-empty string' };
  }
  if (name.length > 214) {
    return { valid: false, reason: 'name must be <= 214 chars (npm limit)' };
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return { valid: false, reason: 'name must be kebab-case, leading lowercase letter, [a-z0-9-]' };
  }
  if (name.includes('--')) {
    return { valid: false, reason: 'name must not contain consecutive hyphens' };
  }
  if (name.endsWith('-')) {
    return { valid: false, reason: 'name must not end with a hyphen' };
  }
  return { valid: true };
}
