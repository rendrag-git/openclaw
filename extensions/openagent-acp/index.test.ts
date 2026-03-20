import type { OpenClawPluginApi } from "openclaw/plugin-sdk/acpx";
import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../test-utils/plugin-api.js";
import plugin from "./index.js";

describe("openagent-acp plugin", () => {
  it("registers the runtime service", () => {
    const registerService = vi.fn();

    plugin.register?.(
      createTestPluginApi({
        id: "openagent-acp",
        name: "OpenAgent ACP",
        description: "OpenAgent ACP runtime backend",
        source: "test",
        config: {},
        runtime: {} as never,
        registerService,
      }) as unknown as OpenClawPluginApi,
    );

    expect(registerService).toHaveBeenCalledOnce();
  });
});
