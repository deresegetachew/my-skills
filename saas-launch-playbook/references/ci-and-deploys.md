# CI and deploys

## GitHub Actions

- **Paid hosted arm64 runners can be refused** by a spending limit. Make the runner list a variable
  (`DEPLOY_RUNS_ON`) so the deploy can move to self-hosted runners without a code change.
- **Artifact storage quota:** test reports uploaded on every run fill the account's quota, and uploads then fail
  every job. Keep artifacts one day (`retention-days: 1`), turn off build-record uploads, and delete old artifacts.
  The quota can keep refusing for a while after deleting. Until it clears, merge by hand only when every test step
  passed and only the upload step failed, and say so on the PR.
- A token without the `workflow` scope can't update a branch whose PR touches workflow files; merge main into the
  branch locally and push, or have the owner do it.
- Deploy tools (AWS CLI, a browser for Lighthouse) aren't on self-hosted runners by default: install a pinned
  version in the job, and point tools at it (`CHROME_PATH`).

## Self-hosted runners

- Ephemeral runners (one job per container) show "offline" between jobs; that is normal. All of them offline for a
  label means nothing can run it.
- If only one machine has the deploy runner's labels (for example arm64), **CI jobs can starve the deploy**: deploys
  sit "queued" for hours. Give deploys a label no CI job uses, or a second runner, and keep that machine awake.
- Cancel superseded queued deploys; the newest includes everything.

## The pipeline that worked

Build and push images (arm64) → migrate (one-shot task) → roll services → smoke test the deployed app (create,
publish, open) → performance budget (Lighthouse) → production, gated by a variable and skipped until it is set.

- Production approval needs GitHub environments with required reviewers, which some plans don't have; use a manual
  gate variable meanwhile and write it down.
- After merging a PR that needs infrastructure, the order is: deploy the code that reads new settings, apply, then
  redeploy so tasks read them.
- Remove a builder's worktree as soon as its PR merges, and clear Docker build caches regularly: disk fills fast.
