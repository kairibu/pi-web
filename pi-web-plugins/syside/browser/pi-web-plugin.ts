import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { createSysideBrowserContributions } from "./syside-panel.js";

const plugin: PiWebPlugin = {
  apiVersion: 2,
  name: "SysIDE",
  activate: ({ pluginId, runtimePluginId, html, svg }) => ({
    contributions: createSysideBrowserContributions(pluginId, runtimePluginId, html, svg),
  }),
};

export default plugin;
