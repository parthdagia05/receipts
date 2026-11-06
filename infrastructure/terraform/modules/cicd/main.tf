# GitHub Actions deployment identity.
#
# OIDC role assumption, not an access key. There is no long-lived AWS
# credential in this repository or in GitHub secrets, which is the single
# most valuable property of the deployment setup: a leaked workflow log or a
# compromised fork cannot yield a usable credential, and nothing has to be
# rotated.
#
# The trust policy is where the security actually lives. `token.actions
# .githubusercontent.com:sub` is pinned to this repository AND to named
# environments, so a pull request from a fork -- which can run workflows --
# cannot assume this role.

variable "project" { type = string }
variable "environment" { type = string }

variable "github_repository" {
  description = "owner/repo. The trust policy is pinned to it."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must be in owner/repo form."
  }
}

variable "github_environments" {
  description = <<-EOT
    GitHub environment names allowed to assume the role. Environments can
    carry required reviewers, which is what makes "do not deploy
    automatically" enforceable on the AWS side rather than only by the
    workflow trigger.
  EOT
  type        = list(string)
  default     = ["prod", "staging"]
}

variable "create_oidc_provider" {
  description = "False if the account already has the GitHub OIDC provider; there can only be one per account."
  type        = bool
  default     = true
}

variable "instance_id" {
  description = "The one instance the workflow may run deploy commands on."
  type        = string
}

variable "ecr_repository_arn" { type = string }

variable "frontend_bucket_arns" {
  description = "Frontend buckets the workflow may sync. Empty until the frontend module is implemented."
  type        = list(string)
  default     = []
}

variable "cloudfront_distribution_arn" {
  description = "Empty until the frontend module is implemented."
  type        = string
  default     = ""
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  oidc_host = "token.actions.githubusercontent.com"

  oidc_arn = var.create_oidc_provider ? (
    aws_iam_openid_connect_provider.github[0].arn
  ) : "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/${local.oidc_host}"

  # `repo:owner/repo:environment:prod`, not `repo:owner/repo:*`. The wildcard
  # form is the common mistake: it lets any branch in the repository assume
  # the role, including one pushed by anyone with write access.
  allowed_subjects = [
    for env in var.github_environments :
    "repo:${var.github_repository}:environment:${env}"
  ]
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url            = "https://${local.oidc_host}"
  client_id_list = ["sts.amazonaws.com"]

  # AWS stopped validating this thumbprint for the GitHub provider in 2023 --
  # it verifies the certificate chain itself -- but the API still requires a
  # value, so this is the documented placeholder rather than something to
  # keep up to date.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

data "aws_iam_policy_document" "assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    # StringEquals on an explicit list, never StringLike with a wildcard.
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = local.allowed_subjects
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "${var.project}-${var.environment}-github-deploy"
  description          = "Assumed by GitHub Actions from ${var.github_repository}"
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  # Takes no resource by API design; the push itself is scoped below.
  statement {
    sid       = "EcrAuth"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "EcrPush"
    effect = "Allow"

    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]

    resources = [var.ecr_repository_arn]
  }

  # The deploy step runs a shell command on the instance over SSM. Scoped to
  # one instance and one document: AWS-RunShellScript on "*" is equivalent to
  # root on every instance in the account.
  statement {
    sid     = "SsmDeploy"
    effect  = "Allow"
    actions = ["ssm:SendCommand"]

    resources = [
      "arn:aws:ec2:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:instance/${var.instance_id}",
      "arn:aws:ssm:${data.aws_region.current.name}::document/AWS-RunShellScript",
    ]
  }

  # Reading back the result takes a command id, not an instance, so it cannot
  # be scoped further.
  statement {
    sid    = "SsmReadResult"
    effect = "Allow"

    actions = [
      "ssm:GetCommandInvocation",
      "ssm:ListCommandInvocations",
    ]

    resources = ["*"]
  }

  dynamic "statement" {
    for_each = length(var.frontend_bucket_arns) == 0 ? [] : [1]

    content {
      sid       = "FrontendList"
      effect    = "Allow"
      actions   = ["s3:ListBucket"]
      resources = var.frontend_bucket_arns
    }
  }

  dynamic "statement" {
    for_each = length(var.frontend_bucket_arns) == 0 ? [] : [1]

    content {
      sid    = "FrontendSync"
      effect = "Allow"

      # DeleteObject is required by `aws s3 sync --delete`. It is scoped to
      # the frontend buckets, which hold build output that is reproducible
      # from a commit -- unlike the backup bucket, where the deploy role has
      # no permissions at all.
      actions = [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
      ]

      resources = [for arn in var.frontend_bucket_arns : "${arn}/*"]
    }
  }

  dynamic "statement" {
    for_each = var.cloudfront_distribution_arn == "" ? [] : [1]

    content {
      sid       = "Invalidate"
      effect    = "Allow"
      actions   = ["cloudfront:CreateInvalidation"]
      resources = [var.cloudfront_distribution_arn]
    }
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "${var.project}-${var.environment}-github-deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

# --- what this role deliberately cannot do ---------------------------------
#
# No access to the backup bucket or its KMS key. CI builds and ships images;
# it has no reason to read a database dump, and a workflow is a soft target.
#
# No secretsmanager:*. The runtime secrets are fetched by the instance, not
# injected by CI, so a compromised workflow cannot read them.
#
# No ec2:*, iam:*, or terraform state access. Infrastructure changes are an
# operator action with an audit trail, not something a merge can trigger.
