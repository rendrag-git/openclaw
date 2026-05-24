# Dev gateway image for picker-rewrite integration testing.
#
# Boots the wildcards-branch openclaw gateway against an isolated state dir
# with a minimal wildcard config pointing at the existing local vllm
# endpoint. Separate from oc-stack so live channels and live agents are not
# touched. Spec lives in scripts/dev-gateway/README.md.
FROM node:22-bookworm-slim

# Tools the gateway looks for at startup; bubblewrap silences a Codex warning
# even though no Codex harness runs here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl tini bubblewrap \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The worktree is mounted at /app at runtime so the gateway exercises the
# built dist from this branch directly — no global install, no version drift.
ENV PATH="/app/node_modules/.bin:${PATH}" \
    OPENCLAW_STATE_DIR=/var/openclaw \
    OPENCLAW_GATEWAY_PORT=19250 \
    NODE_ENV=development

RUN mkdir -p /var/openclaw && chmod 700 /var/openclaw

EXPOSE 19250

ENTRYPOINT ["tini", "--"]
CMD ["node", "/app/dist/index.js", "gateway", "--port", "19250"]
