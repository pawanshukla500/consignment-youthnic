# Required GitHub branch protection (manual)

Configure these checks in GitHub so merges to `main` cannot skip quality gates.

## Repository settings

GitHub → Settings → Branches → Branch protection rules → `main`

Enable:

1. **Require a pull request before merging**
2. **Require status checks to pass before merging**
3. **Require branches to be up to date before merging** (recommended)
4. **Do not allow bypassing the above settings** (recommended for admins)

## Required status checks

Add this check name exactly (from `.github/workflows/deploy.yml` job `quality-gates`):

- `Lint · Build · Test · Audit`

Notes:

- The workflow runs quality gates on `pull_request` targeting `main` **and** on `push` to `main`.
- The `Build & Deploy` job runs only on `push` / `workflow_dispatch` — **never** on pull requests.
- After the first PR with this workflow appears, the check name becomes selectable in the branch-protection UI.

## Verification

Open a test PR and confirm:

1. `Lint · Build · Test · Audit` runs
2. No Cloud Run deploy / secret sync steps run on the PR event
3. Merging is blocked while the check is failing
