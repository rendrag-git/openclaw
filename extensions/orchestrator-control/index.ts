import type { GatewayRequestHandlerOptions, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createOrchestratorControlRuntime, type StartJobRequest } from "./src/runtime.js";

const plugin = {
  id: "orchestrator-control",
  name: "Orchestrator Control",
  description: "Minimal control-plane gateway surface for orchestrator job creation and status.",
  register(api: OpenClawPluginApi) {
    const runtime = createOrchestratorControlRuntime();

    api.registerGatewayMethod("orchestrator-control.start_job", async ({ params, respond }) => {
      try {
        const result = await runtime.startJob(params as StartJobRequest);
        respond(result.ok, result);
      } catch (error) {
        api.logger.warn(
          `orchestrator-control.start_job failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        respond(false, {
          ok: false,
          error: {
            code: "RUNTIME_UNAVAILABLE",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });

    api.registerGatewayMethod(
      "orchestrator-control.get_job_status",
      async ({ params, respond }) => {
        try {
          const result = await runtime.getJobStatus(extractJobId(params));
          respond(result.ok, result);
        } catch (error) {
          api.logger.warn(
            `orchestrator-control.get_job_status failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          respond(false, {
            ok: false,
            error: {
              code: "RUNTIME_UNAVAILABLE",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      },
    );
  },
};

export default plugin;

function extractJobId(params: GatewayRequestHandlerOptions["params"]): string {
  return typeof params?.jobId === "string" ? params.jobId.trim() : "";
}
