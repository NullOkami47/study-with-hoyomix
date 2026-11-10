# Public CI

`Public CI` runs on pull requests into `main`, pushes to `main`, and `workflow_dispatch`. Manual dispatch becomes available after the workflow reaches the default branch. There are no path or draft filters. Newer runs cancel older runs for the same PR or branch.

One standard `ubuntu-24.04` runner uses Node `>=22.18.0 <23` and runs these checks sequentially within 45 minutes:

1. Record the exact checkout commit/tree, actual Node/npm versions, and ten input SHA-256 hashes in the job summary, before dependency installation or build generation.
2. Run `node --test scripts/public-ci.test.mjs`.
3. Install with `npm ci --no-audit --no-fund` and run `npm run typecheck`.
4. Run `npm test -- --maxWorkers=2` and `npm run test:workers -- --maxWorkers=2`.
5. Run `npm run build` and `npm run d1:migrate:local` against an ephemeral local D1 database.
6. Run `npm audit --omit=dev --audit-level=high`. High/critical production findings or registry errors fail validation; lower severities remain visible. Advisory results can change without a source change.

`All public checks` uses `always()` and accepts only a successful validation job. Failure, cancellation, skipping, missing results and unexpected jobs do not pass. Its small gate uses the standard runner's installed Node without checkout or installation. Adding validation jobs requires updating `needs` and the gate contract. Requiring this check in branch protection is a separate maintainer action.

PR runs check the event merge commit; pushes/manual runs check their event commit. The summary verifies checkout against `GITHUB_SHA` and hashes the workflow, contract test, package/lockfile and build/test/Worker configurations. Fixed input names and validated values avoid executing PR titles, bodies or branch names. Node 22 minor/patch versions may vary within the declared range; the actual version is recorded.

This workflow validates **current public source**, its empty catalogue defaults and public synthetic fixtures. It does not establish private release-candidate equivalence or fulfil required checks in another repository. Private history, live providers, remote D1, deployment and physical-device acceptance are outside its coverage. GPL/MPL notices and synthetic fixtures are unchanged.

Only `contents: read` is requested; checkout does not persist credentials. No repository secrets, private refs, self-hosted runners, privileged PR triggers, dependency cache or uploaded artifacts are used. Automatic package-manager caching is explicitly disabled. Standard hosted execution remains subject to GitHub availability and eligibility; an actual run is needed to prove capacity. Fork PRs retain GitHub's normal approval requirements. No paid larger runner or storage is selected.

Upstream GitHub tag references and action inputs were checked on 10 November 2026:

| Action | Release | Commit |
| --- | --- | --- |
| `actions/checkout` | `v7.0.1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node` | `v7.1.0` | `949feb2413d6458794dcd2491c4babbbce0c15c1` |

For lightweight local validation, run `node --test scripts/public-ci.test.mjs` and use an available YAML validator. The contract executes the actual gate against success and non-success fixtures; it is a narrow policy check, not a general YAML parser or protection against a PR editing its own workflow. Review workflow changes and update the contract when changing pins or jobs. Full installation, app tests, build and migration validation run on the hosted runner.
