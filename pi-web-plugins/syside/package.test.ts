import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiWebPluginCatalog } from "../../src/server/piWebPluginCatalog.js";
import { createServerPluginRuntime } from "../../src/server/plugins/serverPluginRuntime.js";
import { WorkspaceCapabilityRegistry } from "../../src/server/workspaces/workspaceCapabilityRegistry.js";
import { WorkspaceProviderRegistry } from "../../src/server/workspaces/workspaceProviderRegistry.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("bundled SysIDE package metadata", () => {
  it("declares its generated browser and server JavaScript as ES modules", async () => {
    const metadata: unknown = JSON.parse(await readFile("pi-web-plugins/syside/package.json", "utf8"));

    expect(metadata).toMatchObject({
      private: true,
      type: "module",
      piWeb: { plugins: [{ id: "syside", browserRoot: "browser", module: "browser/pi-web-plugin.js", serverModule: "server-plugin.js" }] },
    });
  });

  it("is discovered as one bundled, machine-specific dual-entry plugin", async () => {
    const { catalog } = await sysideCatalogFixture(true);

    await expect(catalog.snapshot()).resolves.toMatchObject({
      plugins: [{
        id: "syside",
        source: "bundled",
        scope: "bundled",
        machineSpecific: true,
        enabled: true,
        browserRoot: { path: "browser" },
        browserModule: { path: "browser/pi-web-plugin.js" },
        serverModule: { path: "server-plugin.js" },
      }],
      diagnostics: [],
    });
  });

  it("leaves the kernel folder workspace when SysIDE is disabled before import", async () => {
    const { catalog, root } = await sysideCatalogFixture(false);
    const importer = vi.fn(() => Promise.reject(new Error("disabled SysIDE module was imported")));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runtime = await createServerPluginRuntime({ catalog, importer, logger });
    const registry = new WorkspaceProviderRegistry({
      contributions: runtime.providerContributions(),
      capabilities: new WorkspaceCapabilityRegistry({ contributions: [], logger }),
      logger,
    });

    const resolution = await registry.resolve({
      id: "project-1",
      name: "Project",
      path: root,
      createdAt: "2026-07-27T00:00:00.000Z",
    });

    expect(importer).not.toHaveBeenCalled();
    expect(runtime.healthRecords()).toEqual([expect.objectContaining({
      pluginId: "syside",
      state: "disabled",
      message: "disabled in PI WEB config",
    })]);
    expect(resolution).toMatchObject({
      status: "folder",
      workspaces: [{ path: root, isMain: true }],
    });
    expect(resolution.workspaces[0]).not.toHaveProperty("provider");
    await runtime.stop();
  });
});

async function sysideCatalogFixture(enabled: boolean): Promise<{ catalog: PiWebPluginCatalog; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-syside-package-"));
  tempRoots.push(root);
  const pluginsRoot = join(root, "plugins");
  const pluginRoot = join(pluginsRoot, "syside");
  await mkdir(join(pluginRoot, "browser"), { recursive: true });
  await Promise.all([
    writeFile(join(pluginRoot, "package.json"), await readFile("pi-web-plugins/syside/package.json", "utf8"), "utf8"),
    writeFile(join(pluginRoot, "browser", "pi-web-plugin.js"), "export default {};\n", "utf8"),
    writeFile(join(pluginRoot, "server-plugin.js"), "export default {};\n", "utf8"),
  ]);
  return {
    root,
    catalog: new PiWebPluginCatalog({
      roots: [{ path: pluginsRoot, source: "bundled", scope: "bundled" }],
      packageProvider: false,
      configProvider: () => ({ plugins: { syside: { enabled } } }),
    }),
  };
}
