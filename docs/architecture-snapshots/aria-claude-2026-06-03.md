# Aria — Pre-Swap Architecture Snapshot (2026-06-03)

Captured before the multi-model swap. This is the rollback target for Phase 3 of the swap plan at `/Users/aria/.claude/plans/memoized-dreaming-duckling.md`.

## Model
- **Engine**: Claude Code SDK (`@anthropic-ai/claude-agent-sdk` v0.2.76, npm)
- **Model**: Sonnet 4.6 (with prior Opus history per `project_aria_token_reduction`)
- **Auth lane**: `CLAUDE_CODE_RESPONDER_OAUTH_TOKEN` (Pro account) with fallback to `CLAUDE_CODE_OAUTH_TOKEN` (Max), then `ANTHROPIC_API_KEY` on 429 (per `rate_guard.py`)

## Entry points
- Channel inbound: `src/channels/slack.ts` → `src/index.ts` `onMessage()` → container runner
- Container runner: `container/agent-runner/src/index.ts` (Claude Code SDK loop)
- MCP transport: `container/agent-runner/src/ipc-mcp-stdio.ts` (stdio JSON-RPC)
- Outbound: `channel.sendMessage(jid, text)`

## Per-group persona (auto-loaded by Claude Code SDK)
- `groups/main/CLAUDE.md` — main Aria persona (1059 L)
- `groups/slack_tce-develop/CLAUDE.md` — TCE persona (918 L)
- `groups/slack_main/CLAUDE.md` — Slack main (1114 L)
- `groups/slack_agent-approvals/CLAUDE.md`
- `groups/slack_agent-engineer/CLAUDE.md`
- `groups/global/CLAUDE.md` — global overrides
- Loaded via Claude Code SDK `settingSources: ['project']` (implicit)

## Memory files (auto-loaded by SDK memory feature)
- `/workspace/group/memory/infra_log.md`
- `/workspace/group/memory/flagged_patterns.md`
- `/workspace/group/memory/decision_rules.md`
- `/workspace/group/memory/active_watchdog.txt`

## Tools (registered via Claude Code SDK)
- Built-in: Read, Grep, Glob, Bash, Edit, Write
- IPC tools: `nanoclaw__send_message`, `nanoclaw__schedule_task` (custom)
- MCP servers (via stdio):
  - `mcp__claude_ai_Gmail__*` (Gmail OAuth proxy)
  - `mcp__claude_ai_Google_Calendar__*`
  - `mcp__claude_ai_Google_Drive__*`
  - `mcp__chrome-devtools__*`
  - `mcp__nanoclaw__*`

## State persistence
- Per-group session: SQLite (`src/db.ts`) — `sessions` map, `lastTimestamp`, `lastAgentTimestamp`, `sessionId`
- Transcripts: handled by Claude Code SDK internally (referenced via `sessionId`)
- Per-task watchdog: `/workspace/group/memory/active_watchdog.txt`

## Known issues (pre-swap)
- Pro/Max share quota — two-lane split doesn't isolate (`project_rate_throttling_strategy`)
- Heartbeat-supervisor zombies and 429-retry hysteresis (`feedback_aria_loop_pattern`)
- Container SDK upgrade pending for caching gains (`project_aria_token_reduction`)

## Expected behavior
- ≤2 s first-token latency on Sonnet
- Tool use via Claude Code SDK function-tool registration
- Multimodal: images + PDFs accepted natively via Claude Code SDK
- Streaming partial text to channel for long responses

## Rollback
- `git reset --hard pre-multimodel-swap-2026-06-03` in `/Users/aria/nanoclaw`
- Restore container files from `container/agent-runner/src/archive/index.claude.ts`, `container/agent-runner/archive/package.claude.json`
- Rebuild container image: tag `nanoclaw-runtime:pre-openrouter-2026-06-03` (created during Phase 3 cutover)
