import type { ToolSpec } from "../ai/providers.ts";
import type { Device } from "../devices.ts";
import { arkiaTools } from "./arkia.ts";
import { deviceInfoTools, deviceTools } from "./devices.ts";
import { memoryTools } from "./memory.ts";
import { selfBuildTools } from "./selfbuild.ts";
import type { Tool } from "./types.ts";
import { webTools } from "./web.ts";
import { youtubeTools } from "./youtube.ts";

export type Toolbox = { specs: ToolSpec[]; byName: Map<string, Tool> };

export function toolbox(devices: Device[], opts: { arkia: boolean }): Toolbox {
  const tools = [
    ...webTools,
    ...youtubeTools,
    ...memoryTools,
    ...(opts.arkia ? arkiaTools : []),
    ...deviceInfoTools,
    ...deviceTools(devices),
    ...(devices.some((d) => d.manifest.some((t) => t.name === "enable_plugin")) ? selfBuildTools : []),
  ];
  return {
    byName: new Map(tools.map((t) => [t.name, t])),
    specs: tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
  };
}
