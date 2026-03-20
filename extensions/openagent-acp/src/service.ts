import type {
  AcpRuntime,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "openclaw/plugin-sdk/acpx";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "openclaw/plugin-sdk/acpx";
import {
  resolveOpenAgentAcpPluginConfig,
  type ResolvedOpenAgentAcpPluginConfig,
} from "./config.js";
import { OPENAGENT_ACP_BACKEND_ID, OpenAgentAcpRuntime } from "./runtime.js";

type OpenAgentRuntimeLike = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
};

type OpenAgentRuntimeFactoryParams = {
  pluginConfig: ResolvedOpenAgentAcpPluginConfig;
  logger?: PluginLogger;
};

type CreateOpenAgentAcpRuntimeServiceParams = {
  pluginConfig?: unknown;
  runtimeFactory?: (params: OpenAgentRuntimeFactoryParams) => OpenAgentRuntimeLike;
};

function createDefaultRuntime(params: OpenAgentRuntimeFactoryParams): OpenAgentRuntimeLike {
  return new OpenAgentAcpRuntime(params.pluginConfig, {}, params.logger);
}

export function createOpenAgentAcpRuntimeService(
  params: CreateOpenAgentAcpRuntimeServiceParams = {},
): OpenClawPluginService {
  let runtime: OpenAgentRuntimeLike | null = null;
  let lifecycleRevision = 0;

  return {
    id: "openagent-acp-runtime",
    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      const pluginConfig = resolveOpenAgentAcpPluginConfig({
        rawConfig: params.pluginConfig,
        workspaceDir: ctx.workspaceDir,
        stateDir: ctx.stateDir,
      });
      const runtimeFactory = params.runtimeFactory ?? createDefaultRuntime;
      runtime = runtimeFactory({
        pluginConfig,
        logger: ctx.logger,
      });

      registerAcpRuntimeBackend({
        id: OPENAGENT_ACP_BACKEND_ID,
        runtime,
        healthy: () => runtime?.isHealthy() ?? false,
      });
      ctx.logger.info(
        `openagent ACP runtime backend registered (modulePath: ${pluginConfig.modulePath})`,
      );

      lifecycleRevision += 1;
      const currentRevision = lifecycleRevision;
      void (async () => {
        await runtime?.probeAvailability();
        if (currentRevision !== lifecycleRevision) {
          return;
        }
        if (runtime?.isHealthy()) {
          ctx.logger.info("openagent ACP runtime backend ready");
        } else {
          ctx.logger.warn("openagent ACP runtime backend probe failed");
        }
      })();
    },
    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      lifecycleRevision += 1;
      unregisterAcpRuntimeBackend(OPENAGENT_ACP_BACKEND_ID);
      runtime = null;
    },
  };
}
