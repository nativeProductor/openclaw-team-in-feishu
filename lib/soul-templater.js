// Render SOUL.md content from a template by substituting {{placeholders}}.
// We deliberately keep this tiny — no logic, no conditionals — so that what
// the developer sees in the .tpl file is what ships into the agent's workspace
// minus simple variable replacement.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const TEMPLATES_DIR = path.join(path.dirname(__filename), "..", "templates");

export function templatePathFor(name) {
  return path.join(TEMPLATES_DIR, name);
}

export function render(templateName, vars) {
  const tpl = fs.readFileSync(templatePathFor(templateName), "utf8");
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = lookup(vars, key);
    if (v == null) throw new Error(`SOUL template ${templateName}: missing variable {{${key}}}`);
    return String(v);
  });
}

function lookup(vars, dotted) {
  const parts = dotted.split(".");
  let cur = vars;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// Build the markdown roster table that hosts inject into their SOUL.md.
export function rosterTable(roster) {
  const rows = roster.map((m) => `| ${m.role} | \`<at user_id="${m.openId}">${m.role}</at>\` |`);
  return [
    "| 角色 | 触发写法 |",
    "|---|---|",
    ...rows,
  ].join("\n");
}

// Bullet list of member roles, e.g. for the host's "team members" section.
export function roleBullets(members) {
  return members.map((m, i) => `${i + 1}. ${m.role}${m.brief ? ` —— ${m.brief}` : ""}`).join("\n");
}
