import type { OpenClawPluginApi } from "openclaw/plugin-sdk/acpx";
import { createOpenAgentAcpPluginConfigSchema } from "./src/config.js";
import { createOpenAgentAcpRuntimeService } from "./src/service.js";

const plugin = {
  id: "openagent-acp",
  name: "OpenAgent ACP Runtime",
  description: "ACP runtime backend powered by the openagent runtime adapter.",
  configSchema: createOpenAgentAcpPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerService(
      createOpenAgentAcpRuntimeService({
        pluginConfig: api.pluginConfig,
      }),
    );
  },
};

export default plugin;
