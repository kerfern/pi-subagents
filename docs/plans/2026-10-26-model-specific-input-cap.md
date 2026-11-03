# Haiku 5.5 Context Budget — Implementation Record

> Archived: the approved local-config change was applied and verified through Pi 1.4.0's offline model listings. No Pi source or repository runtime code changed. The verification below records the observed state at implementation time; recheck after agent-directory resets or model-ID changes. Existing TUI sessions may still need a reload; that user action was not observed.

## Objective

Set Pi's effective context window to 100,000 for the exact CommandCode and GitHub Copilot Haiku 5.5 models, using existing estimated auto-compaction. This is best-effort, not a strict input-token cap.

## Invariants

- Change only these `~/.pi/agent/models.json` values:
  - `providers.commandcode.modelOverrides["claude-haiku-5-5"].contextWindow = 100000`
  - `providers.github-copilot.modelOverrides["claude-haiku-5.5"].contextWindow = 100000`
- Preserve all other parsed config, existing overrides, file owner/mode, and credentials.
- Leave existing `openai-codex/gpt-6-luna` and `github-copilot/gpt-6-luna` `contextWindow=272000` metadata unchanged; do not change Haiku `maxTokens` metadata, provider auth, or other model pairs. Pi may limit effective output to remaining context.
- Model overrides apply to every Pi AgentSession using either exact pair. No role-specific or extension-specific exception is promised.
- Make no provider calls; do not inspect or print credentials.

## Status

The config override and offline metadata checks are complete. Restart/reload already-running TUI sessions before relying on updated metadata.

## Implementation and verification record

1. Completed by the parent: created private backup `~/.pi/agent/models.json.before-haiku-context-20261026` and atomically added only the two approved `contextWindow` overrides. File owner/mode were preserved; no credentials were printed.
2. Completed: JSON parsing and comparison against the backup confirmed only the two approved parsed paths changed. Config and backup both retain mode `0600`.
3. Completed: offline Haiku listings showed both targets at 100K and other Haiku entries unchanged across the active launcher and both alternate launchers. The `gpt-6-luna` listing retained 272K on Codex and GitHub Copilot.
4. Independent reviewer found no concrete blockers in the supplied evidence. The reviewer and parent noted that a long-context compaction cycle was not exercised; no source build or test suite was needed for this config-only change.
5. Reload/restart existing TUI sessions before relying on updated metadata; this remains a user action. Pi 1.4.0 update-path inspection confirmed ordinary package updates do not replace `models.json`; catalog refresh rereads it and stores catalog state separately. Recheck after updates because agent-directory resets or renamed model IDs can invalidate overrides.

## Files

- `~/.pi/agent/models.json` — runtime configuration.
- `~/.pi/agent/models.json.before-haiku-context-20261026` — private pre-change backup.
- `docs/superpowers/specs/2026-10-26-model-specific-input-cap-design.md` — approved behavior and limitations.
- This plan.

## Verification evidence captured during implementation

```bash
pi --offline --list-models haiku
~/.local/bin/pi --offline --list-models haiku
/opt/homebrew/bin/pi --offline --list-models haiku
pi --offline --list-models gpt-6-luna
```

The first listing was captured in full; alternate launchers were filtered to the target rows. A credential-safe comparison against the private backup confirmed only the target paths changed. No `npm` checks, provider probes, installed-package edits, or Pi source edits were needed; the runtime config and backup remain outside the source repositories.

## Limitations

Auto-compaction uses estimated context and the configured reserve; actual requests may exceed 100,000 input tokens. Auto-compaction state and long-context behavior were not independently exercised; the implementation assumes it remains enabled as reported for Luna. Raw provider calls that bypass Pi AgentSession are unaffected. A strict cap or per-role/extension scope would require a separate host-level design.
