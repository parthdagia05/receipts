# Terraform — EC2 architecture

Single-instance backend, private S3 + CloudFront frontend, Cloudflare DNS.
Supersedes an earlier ECS Fargate design; see
[`cost-estimate.md`](../../docs/deployment/cost-estimate.md) for why EC2 was
chosen over Fargate for a credit-funded deployment.

```
modules/
  network/    VPC, public subnet, IGW, routing, security group
  compute/    EC2 instance, encrypted EBS, EIP, IAM instance profile, bootstrap
  backup/     S3 bucket, KMS CMK, write-only + operator IAM policies
  snapshots/  DLM daily EBS snapshot policy
  cicd/       GitHub OIDC provider, deployment role
  frontend/   S3 (private) + CloudFront + OAC   <- still a design
envs/
  prod/       composes the modules; ECR, Secrets Manager, backend config
  prod/tests/ offline assertions, run with `terraform test`
```

## Status

**Nothing has been applied and no AWS resource exists.** Everything except
`modules/frontend` is now real HCL rather than a commented inventory, and
`terraform validate` and `terraform test` both pass offline.

`modules/frontend` is still a commented design. The CI module is wired to
accept its outputs (`frontend_bucket_arns`, `cloudfront_distribution_arn`)
and omits those permissions entirely while they are empty, rather than
granting a placeholder.

## Checks

```bash
terraform fmt -check -recursive
cd envs/prod && terraform init -backend=false && terraform validate
cd envs/prod && terraform test       # mocked provider, no credentials, creates nothing
```

`terraform test` asserts the properties that are expensive to discover later:

| Assertion | Why it is a test rather than a comment |
| --- | --- |
| the DLM tag is on the root volume | a policy matching no volume runs nightly, reports success, and protects nothing |
| only tcp/80, tcp/443, udp/443 are open | 22, 5432 and 8080 must never appear |
| the root volume is encrypted | the PostgreSQL data directory lives on it |
| IMDSv2 is required | IMDSv1 turns an SSRF into role-credential theft |
| the instance cannot delete or read backups | ransomware's first move is destroying backups |
| OIDC subjects are pinned to repo + environment | a wildcard lets any branch assume the deploy role |

All eight corresponding mutations were verified to fail the suite.

## Deliberate omissions

- **No ALB.** One instance, Caddy terminating TLS on it. An ALB is ~$18/month
  to load-balance across one target.
- **No NAT Gateway.** The instance sits in a public subnet with an Elastic IP.
  That is a real trade-off and it is argued in the cost estimate, not hidden.
- **No RDS.** PostgreSQL runs in Docker on the same instance with a named
  volume. Backups come from the nightly dump and EBS snapshots.
- **No autoscaling.** One instance.
- **No SSH.** No inbound 22, no key pair. Shell access is Session Manager,
  which is an outbound connection from the instance. This replaces the
  earlier `ssh_ingress_cidr` design, and that variable has been removed.

Each of these is the cheap option and each costs something. They are listed
here so nobody mistakes them for oversights.
