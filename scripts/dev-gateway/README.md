# Picker-rewrite dev gateway

A throwaway openclaw gateway in Docker, separate from `oc-stack`, used to
exercise the picker-rewrite modules end-to-end without touching live
channels or live agents.

## Why

The picker rewrite (REN-679 onward) ships new modules under `src/picker/`.
Unit and integration tests in the worktree cover module behavior with
faked plugins. This container lets us drive the *real* built gateway from
this branch — real plugin lookup, real per-agent `models.json` I/O, real
`vllm` discovery against `http://10.68.198.1:31080/v1` — without
modifying `pmg`'s live state.

## Layout

- `Dockerfile` — Node 22 base, bind-mount the worktree at `/app`, run
  `node /app/dist/index.js gateway`.
- `openclaw.json` — minimal config with `vllm/*` wildcard, channels
  disabled, gateway bound to a non-conflicting port (19250).
- This README.

## Boot

```
docker build -t openclaw-picker-dev scripts/dev-gateway
docker run --rm -d \
  --name openclaw-picker-dev \
  -p 19250:19250 \
  -v "$PWD:/app:ro" \
  -v "$PWD/scripts/dev-gateway/openclaw.json:/var/openclaw/openclaw.json:ro" \
  openclaw-picker-dev
docker logs -f openclaw-picker-dev
```

## Useful probes

```
# Hit the gateway's models.list HTTP-RPC equivalent via the CLI from inside.
docker exec openclaw-picker-dev openclaw models list --all --provider vllm --json

# Inspect persisted models.json after a refresh.
docker exec openclaw-picker-dev cat /var/openclaw/agents/main/agent/models.json
```

## Notes

- Channels are explicitly disabled so the container can boot without
  needing any channel credentials.
- The `vllm-local` apiKey is a non-secret marker that matches the vllm
  endpoint's auth-anything policy. Do not reuse for any real secret.
- Container state lives in `/var/openclaw` and is wiped each run.
