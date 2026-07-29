import fs from "node:fs";
import path from "node:path";

export function loadPromptTemplate(rootDir, name) {
  return fs.readFileSync(path.join(rootDir, "prompts", `${name}.md`), "utf8");
}

export function interpolateTemplate(template, variables) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key] ?? "") : "";
  });
}
