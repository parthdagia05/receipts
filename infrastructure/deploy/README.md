# Deployment

Two scripts, both run by `.github/workflows/deploy.yml` and both unit-tested
locally with stubs, so the failure paths are exercised without an outage.

| File | Runs on | Purpose |
|---|---|---|
| `ecr-push.sh` | the runner | build linux/arm64, push, idempotent against immutable tags |
| `deploy.sh` | the instance (via SSM) | deploy one tag, health-gate it, roll back if it fails |

## Why the logic is here and not in the workflow

It used to be a JSON array of shell strings inside `send-command`. That is
unreadable, unreviewable and untestable, and it is where the `sleep 15`
lived. As files, both are covered by the suites below.

`deploy.sh` is shipped to the instance by the workflow rather than baked
into user-data, because user-data is capped at 16KB and already 86% full.

## deploy.sh contract

```
exit 0   the candidate is running and healthy
exit 1   the candidate failed; the PREVIOUS image is running and healthy
exit 2   the candidate failed AND the rollback failed -- the service is down
```

Three codes, because "deploy failed" and "deploy failed and we could not get
back" are different incidents. The workflow reports them differently; a
workflow that paints both red teaches people to ignore red.

Health is polled to a budget (`HEALTH_TIMEOUT`, default 120s), not slept
through. The old fixed `sleep 15` was shorter than the API's own 20s
healthcheck start period *and* shorter than a cold start that verifies the
record-server signer on chain, so a slow RPC failed a good deploy.

## Tags

The ECR repository has `IMMUTABLE` tags, so a SHA tag means exactly one
image forever. Consequences, all enforced:

- `latest`, `local`, `main` and `master` are refused by Terraform variable
  validation, by user-data and by both scripts.
- Re-running a deploy on the same SHA is a **no-op push** and a converge,
  not a failure. Pushing over an existing immutable tag is an error, and it
  used to fail the workflow before it reached the deploy step.
- `docker-compose.prod.yml` requires `ECR_REGISTRY` and `IMAGE_TAG` with no
  defaults. A default tag is how a deployment silently serves the wrong
  build.

## Approval gate

The `backend` and `frontend` jobs set `environment:`, which makes them wait
for that GitHub environment's protection rules. It is also the AWS-side
boundary: the OIDC trust policy accepts only
`repo:<owner>/<repo>:environment:<name>`, so a job without that key cannot
assume the deploy role at all.

**The reviewers are a repository setting, not a file in this repo.** Until
they are configured in the GitHub UI, the gate exists but stops nobody.

## Tests

```bash
bash infrastructure/deploy/test-compose.sh     # image reference, build context, caddy dependency
bash infrastructure/deploy/test-ecr-push.sh    # same-SHA idempotency, arm64, moving tags
bash infrastructure/deploy/test-deploy.sh      # rollback, health timeout, same-SHA, permissions
bash infrastructure/deploy/test-bootstrap.sh   # user-data ordering, secret validation
```

`test-bootstrap.sh` renders the real `user-data.sh.tftpl` and executes it
with privileged commands stubbed and absolute paths redirected into a
sandbox — so it tests the script that will actually run, not a copy. Its
most important assertion is an ordering one: the backup timer and the
CloudWatch agent must be configured *before* the application starts, and an
application that fails to start must not take them with it.
