# Haiku 5.5 Context Budget

**Date:** 2026-10-26

## Status

Implemented; offline catalog metadata verified as a best-effort model-specific estimated-compaction target. Long-context compaction behavior was not tested. This is **not** a strict request-level token cap.

## Goal

Use Pi's existing model metadata and auto-compaction path to target an estimated 100,000-token context for these exact model pairs:

- `commandcode/claude-haiku-5-5`
- `github-copilot/claude-haiku-5.5`

This is not a cumulative session budget. It does not guarantee each provider request contains at most 100,000 actual input tokens.

## Implementation

The change adds `contextWindow: 100000` to the provider-specific `modelOverrides` entries in `~/.pi/agent/models.json`. Pi 1.4.0 supports these overrides for built-in and extension-provided models. The user-owned config lives outside Pi's package installation and persists across ordinary package updates. Pi 1.4.0's `pi update` defaults to updating Pi; `--all` adds installed packages, and neither replaces this file. `--models` refresh rereads `models.json`; catalog state is stored separately in `models-store.json`. Agent-directory resets or renamed model IDs can still invalidate the override.

Pi's auto-compaction uses estimated projected context and the model's `contextWindow`, triggering at `contextWindow - reserveTokens`. Keep auto-compaction enabled. The configured reserve means compaction begins below 100,000 estimated tokens; estimator drift can still allow requests over 100,000 actual input tokens.

The override applies to any Pi `AgentSession` selecting either exact pair, including main, pi-subagents, and any other extension-created sessions using those models. Other provider/model pairs are unchanged. This path is model-scoped, not role-scoped; no provider token-count endpoint, root-session hook, or specialist-role exception is added.

## Preserved behavior and limits

- Leave existing `openai-codex/gpt-6-luna` and `github-copilot/gpt-6-luna` `contextWindow=272000` metadata unchanged; do not alter other Luna provider/catalog entries.
- Leave Haiku `maxTokens` metadata, provider auth, routing defaults, and other model pairs unchanged. Pi's existing request builder may still reduce output allowance to fit remaining context.
- Do not inspect credentials or contact providers.
- Raw provider calls that bypass Pi `AgentSession` auto-compaction are not covered.
- If a hard ≤100,000 actual-input guarantee or role/extension-specific scope is needed later, this approach is insufficient; that requires a host admission hook plus certified provider-specific counting.

## Verification

Parse the updated JSON without printing sensitive fields. Run `pi --offline --list-models haiku` and confirm both target pairs report a 100K context while other listed Haiku models retain prior values. Compare all non-target parsed config entries, owner, and mode before/after. Restart or reload the active session/model registry before relying on the change.

No provider request is part of verification.

## Implementation record

- The two overrides were applied atomically to `~/.pi/agent/models.json`; a private pre-change backup is `~/.pi/agent/models.json.before-haiku-context-20261026`. Parsed comparison confirmed only the approved paths changed; file and backup retain mode `0600`.
- `pi --offline --list-models haiku` reports 100K for both targets and unchanged context values for other Haiku entries. All three launchers showed 100K. The `gpt-6-luna` listing retained 272K for Codex and GitHub Copilot.
- Update-path source checks confirm ordinary Pi/package updates do not replace this user config; catalog refresh rereads it and persists catalog data separately.
- Model-list output verifies metadata, not auto-compaction state or a long-context compaction cycle. This implementation assumes auto-compaction remains enabled, consistent with the user's report of the existing Luna path.
- Existing TUI sessions may need restart or model reload to read updated metadata.
