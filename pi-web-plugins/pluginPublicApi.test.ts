import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const pluginRoot = "pi-web-plugins";
/**
 * Exact one-file allowlist keyed by rule id (not by message text, so rewording
 * a diagnostic never silently disables an allowlist entry). Only
 * `node-child-process` has an entry: the persistent SysIDE Python worker spawn
 * adapter in `syside-worker-process.ts` is the only plugin module permitted to
 * import `node:child_process`, because the bounded `context.execFile()` helper
 * is for one-shot commands and cannot keep a bidirectional stdio worker alive.
 * Everything else must keep using the bounded server command helper.
 */
const patternAllowlist: Record<string, ReadonlySet<string>> = {
  "node-child-process": new Set(["pi-web-plugins/syside/syside-worker-process.ts"]),
};
const forbiddenPatterns = [
  { id: "fetch", pattern: /\bfetch\s*\(/u, message: "direct browser fetch" },
  { id: "api-url", pattern: /["'`](?:api\/|[^"'`]*\/api\/)/u, message: "direct PI WEB API URL" },
  { id: "plugin-url", pattern: /["'`](?:pi-web-plugins\/|[^"'`]*\/pi-web-plugins\/)/u, message: "direct PI WEB plugin URL" },
  { id: "pi-web-internal", pattern: /piWebInternal/u, message: "legacy internal plugin context" },
  { id: "src-imports", pattern: /(?:\.\.\/)+src\//u, message: "imports from PI WEB source internals" },
  { id: "fastify", pattern: /from\s+["']fastify["']/u, message: "imports Fastify instead of the server plugin API" },
  { id: "node-child-process", pattern: /from\s+["']node:child_process["']/u, message: "bypasses the bounded server command helper" },
  { id: "unpublished-internals", pattern: /@jmfederico\/pi-web\/(?:dist|src)\//u, message: "imports unpublished PI WEB internals" },
];

describe("bundled PI WEB plugins", () => {
  it("uses public browser and server plugin APIs instead of direct PI WEB internals", async () => {
    const violations: string[] = [];
    for (const file of await pluginSourceFiles(pluginRoot)) {
      const content = await readFile(file, "utf8");
      const relativePath = file.split(sep).join("/");
      for (const { id, pattern, message } of forbiddenPatterns) {
        const allowlisted = patternAllowlist[id]?.has(relativePath) ?? false;
        if (allowlisted) continue;
        if (pattern.test(content)) violations.push(`${file}: ${message}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps the bundled Git browser graph on the public API and package-local modules", async () => {
    const root = resolve("pi-web-plugins/git/browser");
    const entry = resolve(root, "pi-web-plugin.ts");
    const pending = [entry];
    const visited = new Set<string>();
    const violations: string[] = [];

    while (pending.length > 0) {
      const file = pending.pop();
      if (file === undefined || visited.has(file)) continue;
      visited.add(file);
      const source = await readFile(file, "utf8");
      for (const specifier of moduleSpecifiers(source)) {
        if (specifier === "@jmfederico/pi-web/plugin-api") continue;
        if (!specifier.startsWith("./")) {
          violations.push(`${relative(process.cwd(), file)}: browser import ${specifier}`);
          continue;
        }
        const dependency = resolve(dirname(file), specifier.replace(/\.js$/u, ".ts"));
        if (dependency !== root && !dependency.startsWith(`${root}${sep}`)) {
          violations.push(`${relative(process.cwd(), file)}: browser import escapes the Git package (${specifier})`);
          continue;
        }
        pending.push(dependency);
      }
    }

    expect(violations).toEqual([]);
    expect([...visited].map((file) => relative(root, file)).sort()).toContain("git-panel.ts");
  });

  it("keeps the bundled SysIDE browser graph on the public API and package-local modules", async () => {
    const root = resolve("pi-web-plugins/syside/browser");
    const entry = resolve(root, "pi-web-plugin.ts");
    const pending = [entry];
    const visited = new Set<string>();
    const violations: string[] = [];

    while (pending.length > 0) {
      const file = pending.pop();
      if (file === undefined || visited.has(file)) continue;
      visited.add(file);
      const source = await readFile(file, "utf8");
      for (const specifier of moduleSpecifiers(source)) {
        if (specifier === "@jmfederico/pi-web/plugin-api") continue;
        if (!specifier.startsWith("./")) {
          violations.push(`${relative(process.cwd(), file)}: browser import ${specifier}`);
          continue;
        }
        const dependency = resolve(dirname(file), specifier.replace(/\.js$/u, ".ts"));
        if (dependency !== root && !dependency.startsWith(`${root}${sep}`)) {
          violations.push(`${relative(process.cwd(), file)}: browser import escapes the SysIDE package (${specifier})`);
          continue;
        }
        pending.push(dependency);
      }
    }

    expect(violations).toEqual([]);
    expect([...visited].map((file) => relative(root, file)).sort()).toContain("syside-panel.ts");
  });
});

function moduleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

async function pluginSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await pluginSourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}
