# Cache-Aware Pilot: Operator Instructions

## Why pilot is blocked

Pilot code is ready. Comparative run is not. Four inputs still need operator decisions:

1. **Task set:** no representative, non-sensitive tasks supplied or approved.
2. **Isolation:** current instruction says no Git worktrees; pilot plan requires identical, isolated snapshots.
3. **Parent model:** workflow `mode` does not switch or verify parent model. Parent route must be selected manually.
4. **Allowance data:** subscription allowance/cache savings are not observable from current telemetry. Do not infer them from API cost or token counts.

## Step 1 — Approve task source

Choose one:

- [ ] Supply 20–30 representative, non-sensitive tasks.
- [ ] Authorize a synthetic task set generated from this repository.

Cover routine edits, API changes, debugging, coupled changes, and ambiguous/high-risk work. Include expected outcome and acceptance check for each task. Do not include secrets, patient data, or sensitive records. Plan/advisor agent sessions may persist, so redact task inputs.

## Step 2 — Approve isolation method

Choose one:

- [ ] Use temporary directory copies of one identical repository snapshot, including approved uncommitted pilot changes. Leave current checkout untouched. This honors the no-worktree instruction.
- [ ] Explicitly lift no-worktree restriction and authorize isolated Git worktrees.

Do not run tasks in current dirty checkout. Do not reset, stash, commit, push, or install dependencies.

## Step 3 — Select parent routes manually

Before each comparison, start/select parent session manually:

- **Routine:** intended Luna / medium parent.
- **Complex:** intended Sol / high parent.

Workflow `mode` is metadata only; it cannot change parent model. `/subagent-model` controls subagent routes, not parent selection. Verify effective provider/model/thinking from runtime evidence. Luna authentication/effective route remains unverified; do not inspect credential files. If route cannot be verified, record it as **unverified** and do not claim a route comparison.

## Step 4 — Decide what to measure

- [ ] If operator can provide subscription allowance readings, record before/after values and source.
- [ ] Otherwise accept results limited to elapsed time and observed token/cache fields. Unknown or unpriced values stay `null`.

API-priced cost is not subscription spend. Cache-read/write counters do not prove cache savings. Make no savings claim without direct measurements.

## Step 5 — Run matched tasks

For each approved task:

1. Use same repository snapshot and acceptance check for both runs.
2. Create separate task IDs, e.g. `pilot-01-routine` and `pilot-01-complex`; reuse each ID only across its own workflow stages.
3. Run `plan`; explicitly approve returned `planVersion`.
4. Run `worker` with real gate command. If review finds an issue, pass concise review feedback, rerun gate, then review new revision.
5. Run `review` with redacted original request, approved plan, actual diff summary, validation results, unresolved issues, and non-sensitive `revisionId`.
6. Record pass/fail, elapsed time, observed input/output/cache tokens, priced cost or `null`, effective routes, and any unavailable values. Do not save prompts, secrets, patient data, or gate output in pilot artifacts.
7. Repeat runs where practical; report task-level results and limitations, not unsupported general savings.

## Step 6 — Report honestly

Report counts, acceptance outcomes, timing, observed telemetry, missing values, and route verification status. Keep subscription allowance and cache savings **unmeasured** unless direct observability was supplied. Do not claim cache preservation, permission isolation, or savings without evidence.

## Operator response needed

Reply with task source, isolation choice, parent-route selection plan, and whether allowance readings are available. Pilot stays paused until those choices are clear.