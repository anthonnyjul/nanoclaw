# Aria — Post-Swap Architecture (2026-06-03)

Current state after Phase 3 of the multi-model swap. Companion doc to the pre-swap baseline at `aria-claude-2026-06-03.md` (the rollback target).

## Model
- **Engine**: Claude Code SDK (`@anthropic-ai/claude-agent-sdk` v0.2.76, npm) — unchanged
- **Model**: `claude-haiku-4-5` resolved by OpenRouter to `anthropic/claude-4.5-haiku-20251001`
- **Auth lane**: OpenRouter API key. Pro/Max OAuth tokens are no longer used for Aria. They remain configured for the credential proxy's API-key spillover path on the Anthropic side (still relevant if someone reverts `NANOCLAW_USE_OPENROUTER=0`).

## What changed
- `src/credential-proxy.ts`: new `openrouter` auth mode. When `NANOCLAW_USE_OPENROUTER=1` and `OPENROUTER_API_KEY` is present in `.env`:
  - Upstream URL flips from `https://api.anthropic.com` to `https://openrouter.ai`.
  - Forward path adds `/api` prefix to `/v1/*` so `/v1/messages` → `/api/v1/messages`.
  - Authorization headers stripped from the container request; `Authorization: Bearer <OPENROUTER_API_KEY>` injected.
  - Model field in the JSON body is rewritten to `OPENROUTER_MODEL_OVERRIDE` (default `claude-haiku-4-5`). OpenRouter auto-resolves both dotted (`anthropic/claude-haiku-4.5`) and Anthropic dash-form slugs (`claude-haiku-4-5`, `claude-haiku-4-5-20251001`).
  - Pro-lane / 429-spillover bypassed; OpenRouter has its own rate envelope.
- `src/container-runner.ts`: `openrouter` mode is treated as API-key style for the SDK's container env — the container is told `ANTHROPIC_API_KEY=placeholder` so the SDK sends x-api-key, which the proxy strips and replaces.
- `.env`: `NANOCLAW_USE_OPENROUTER=1`, `OPENROUTER_API_KEY=…`, `OPENROUTER_MODEL_OVERRIDE=claude-haiku-4-5` (gitignored).
- Container image: **not rebuilt**. The runtime change is host-side (proxy + env wiring); the container's Claude Code SDK is unchanged and continues to speak Anthropic Messages API to what it believes is `api.anthropic.com`.

## What did NOT change
- `container/agent-runner/src/index.ts` — the SDK loop, MessageStream, IPC polling, PreCompact hook, MCP wiring, session resume — all untouched.
- `container/agent-runner/src/ipc-mcp-stdio.ts` — MCP stdio server unchanged.
- All per-group `groups/*/CLAUDE.md` personas — unchanged.
- All channels (`src/channels/slack.ts`, etc.) — unchanged.
- `src/db.ts` session persistence — unchanged.
- `apply_spawn_credentials()` + `rate_guard.py` in agent-team — unchanged; still relevant for Engineer + sub-agents on Max.

## Verified
- Credential proxy smoke test (Anthropic Messages format → OpenRouter Anthropic-compat endpoint → assistant reply, model echo `anthropic/claude-4.5-haiku-20251001`). Body rewrite and Bearer injection both proven.
- Typecheck + 7 existing credential-proxy unit tests pass.

## Rollback
Pick the safest level for the moment:

1. **Per-request feature flag** (no downtime):
   - `sed -i '' 's/^NANOCLAW_USE_OPENROUTER=1$/NANOCLAW_USE_OPENROUTER=0/' /Users/aria/nanoclaw/.env`
   - Restart NanoClaw service (next request hits Anthropic again).

2. **Hard revert of code** (also removes the openrouter mode):
   - `git reset --hard pre-multimodel-swap-2026-06-03` in `/Users/aria/nanoclaw`
   - Restore from `container/agent-runner/src/archive/index.claude.ts` if you've also touched the container (we did not in this phase).

3. **Restore container image** (if a container rebuild was triggered later and broke things):
   - `docker tag nanoclaw-runtime:pre-openrouter-2026-06-03 nanoclaw-runtime:current` (or Apple Container equivalent).

## Operational notes
- OpenRouter cost on Haiku 4.5: $1.00/M input, $5.00/M output (per the OpenRouter catalog at swap time). Roughly 3× cheaper than Sonnet, and Aria is now fully off the Anthropic Pro/Max quota pool.
- The `add-image-vision` and `add-pdf-reader` skills continue to work because Haiku 4.5 is multimodal (vision + the OpenRouter file content-part both confirmed in pre-flight).
- Prompt caching: OpenRouter passes through Anthropic prompt caching for Anthropic-served models. Verify via the `usage.cache_read_input_tokens` field in OpenRouter responses after a few sessions.
