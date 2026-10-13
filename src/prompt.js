import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Concatenates every .md file in prompts/ in filename order.
 * Numbered prefixes (00-, 10-, 20-) make that order deterministic.
 *
 * Reloaded on every call, so editing a prompt file takes effect on the next
 * run with no restart and no redeploy.
 */
export function loadSystemPrompt() {
  const dir = join(root, "prompts");
  if (!existsSync(dir)) {
    throw new Error("prompts/ directory is missing");
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  if (files.length === 0) {
    throw new Error("No .md files found in prompts/");
  }
  return files
    .map((f) => readFileSync(join(dir, f), "utf8").trim())
    .filter(Boolean)
    .join("\n\n---\n\n");
}
