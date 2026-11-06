# The instance that runs docker-compose.prod.yml.

variable "project" { type = string }
variable "environment" { type = string }
variable "aws_region" { type = string }
variable "subnet_id" { type = string }
variable "security_group_id" { type = string }

variable "instance_type" {
  description = "t4g.small (ARM) is ~half the price of t3.small for this workload."
  type        = string
  default     = "t4g.small"
}

variable "root_volume_gb" {
  description = "Holds the OS, images, the PostgreSQL volume and local backups."
  type        = number
  default     = 30
}

variable "compose_version" {
  description = "Pinned. `latest` would make rebuilding this instance non-reproducible."
  type        = string
  default     = "v2.29.7"
}

# --- the tag that decides whether snapshots exist --------------------------

variable "backup_volume_tag" {
  description = <<-EOT
    The tag DLM matches volumes on, passed in from the snapshots module so
    there is exactly one definition of it. Hard-coding "Backup=receipts-prod"
    in two modules is the failure that produces a snapshot policy running
    nightly over zero volumes while reporting success.
  EOT
  type        = map(string)

  validation {
    condition     = length(var.backup_volume_tag) >= 1
    error_message = "backup_volume_tag must contain at least one tag, or the root volume will not be snapshotted."
  }
}

# --- secrets and runtime configuration -------------------------------------

variable "secret_id" {
  description = "Secrets Manager secret (name or ARN) holding a JSON object of the runtime secrets. Created and populated out of band; see runbook.md."
  type        = string
}

variable "secret_arn" {
  description = "ARN of the same secret, for the IAM policy. Scoped exactly; never a wildcard."
  type        = string
}

variable "ecr_repository_arn" {
  description = "The one repository the instance may pull from. Empty disables the ECR grant."
  type        = string
  default     = ""
}

variable "ecr_registry" {
  description = "<account>.dkr.ecr.<region>.amazonaws.com. Empty skips the docker login at boot."
  type        = string
  default     = ""
}

variable "backup_bucket" { type = string }
variable "backup_prefix" { type = string }

variable "backup_writer_policy_arn" {
  description = "Write-only S3 + KMS policy from the backup module."
  type        = string
}

variable "backup_retention_days" {
  type    = number
  default = 7
}

variable "image_tag" {
  description = <<-EOT
    The exact immutable image tag to boot. REQUIRED -- no default.

    CI pushes `$${GITHUB_SHA::7}` and the ECR repository is IMMUTABLE, so
    `latest` is never published. A default of "latest" meant the first boot
    pulled a tag that could not exist, and the failure surfaced on the
    instance rather than at plan time.
  EOT
  type        = string

  validation {
    condition     = trimspace(var.image_tag) != ""
    error_message = "image_tag must not be empty."
  }

  validation {
    condition     = !contains(["latest", "local", "main", "master"], lower(trimspace(var.image_tag)))
    error_message = "image_tag must name a specific build, not a moving tag such as \"latest\". ECR tags are immutable and a rollback must be able to name an exact image."
  }

  validation {
    # The 7-to-40 character hex form CI produces. Rejecting anything else
    # here is what keeps Terraform, user-data and the workflow agreeing on
    # one tag rather than three conventions.
    condition     = can(regex("^[0-9a-f]{7,40}$", trimspace(var.image_tag)))
    error_message = "image_tag must be a lowercase hex commit SHA of 7 to 40 characters, matching what the deploy workflow pushes."
  }
}

variable "site_address" {
  description = "api.receipts.<domain>. A bare hostname makes Caddy request a certificate, so DNS must resolve here first."
  type        = string
}

variable "acme_email" { type = string }

variable "app_config" {
  description = "Non-secret application configuration written to .env.prod at boot."
  type = object({
    postgres_db                 = string
    postgres_user               = string
    chain_id                    = string
    review_gateway_address      = string
    receipt_settler_address     = string
    identity_registry_address   = string
    reputation_registry_address = string
    gateway_deploy_block        = string
    world_app_id                = string
    world_rp_id                 = string
    world_environment           = string
    review_content_base_url     = string
    cors_allowed_origins        = string
  })
}

# --- AMI -------------------------------------------------------------------

# Amazon Linux 2023, arm64. The architecture filter is not cosmetic: an x86_64
# AMI on a t4g simply fails to boot, and the image we run is arm64-only.
data "aws_ami" "al2023_arm" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-kernel-6.1-arm64"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# --- IAM -------------------------------------------------------------------

data "aws_iam_policy_document" "assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "${var.project}-${var.environment}-instance"
  description        = "Role for the ${var.project} application instance"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

# Session Manager. This is what replaces inbound SSH: the agent opens an
# outbound connection, so no port is opened and there is no key to lose.
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Lets the CloudWatch agent publish the memory and disk metrics the default
# EC2 metrics omit.
resource "aws_iam_role_policy_attachment" "cloudwatch" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

# The write-only backup policy, attached here rather than defined here. The
# instance can create backups and cannot read, overwrite or delete them.
resource "aws_iam_role_policy_attachment" "backup_writer" {
  role       = aws_iam_role.app.name
  policy_arn = var.backup_writer_policy_arn
}

data "aws_iam_policy_document" "app" {
  # One secret, by ARN. `secretsmanager:GetSecretValue` on "*" would let a
  # compromised instance read every secret in the account.
  statement {
    sid       = "ReadRuntimeSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.secret_arn]
  }

  # GetAuthorizationToken is account-wide by API design -- it takes no
  # resource. The pull itself is scoped to the one repository below.
  dynamic "statement" {
    for_each = var.ecr_repository_arn == "" ? [] : [1]

    content {
      sid       = "EcrAuth"
      effect    = "Allow"
      actions   = ["ecr:GetAuthorizationToken"]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = var.ecr_repository_arn == "" ? [] : [1]

    content {
      sid    = "EcrPull"
      effect = "Allow"

      actions = [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
      ]

      resources = [var.ecr_repository_arn]
    }
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "${var.project}-${var.environment}-instance"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

resource "aws_iam_instance_profile" "app" {
  name = "${var.project}-${var.environment}-instance"
  role = aws_iam_role.app.name
}

# --- instance --------------------------------------------------------------

locals {
  repo_root = "${path.module}/../../../.."

  # Tags that land on the ROOT VOLUME. The backup tag is merged in from the
  # snapshots module; see the precondition below.
  root_volume_tags = merge(
    var.backup_volume_tag,
    {
      Name = "${var.project}-${var.environment}-root"
    },
  )

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    aws_region      = var.aws_region
    secret_id       = var.secret_id
    image_tag       = trimspace(var.image_tag)
    ecr_registry    = var.ecr_registry
    site_address    = var.site_address
    acme_email      = var.acme_email
    compose_version = var.compose_version

    backup_bucket         = var.backup_bucket
    backup_prefix         = var.backup_prefix
    backup_retention_days = var.backup_retention_days

    postgres_db                 = var.app_config.postgres_db
    postgres_user               = var.app_config.postgres_user
    chain_id                    = var.app_config.chain_id
    review_gateway_address      = var.app_config.review_gateway_address
    receipt_settler_address     = var.app_config.receipt_settler_address
    identity_registry_address   = var.app_config.identity_registry_address
    reputation_registry_address = var.app_config.reputation_registry_address
    gateway_deploy_block        = var.app_config.gateway_deploy_block
    world_app_id                = var.app_config.world_app_id
    world_rp_id                 = var.app_config.world_rp_id
    world_environment           = var.app_config.world_environment
    review_content_base_url     = var.app_config.review_content_base_url
    cors_allowed_origins        = var.app_config.cors_allowed_origins

    # Embedded gzip+base64 so the instance needs no git credentials and no
    # artifact bucket. base64gzip() keeps the whole user_data inside the
    # 16KB limit; cloud-init decompresses it.
    compose_b64        = base64gzip(file("${local.repo_root}/docker-compose.prod.yml"))
    caddyfile_b64      = base64gzip(file("${local.repo_root}/infrastructure/caddy/Caddyfile"))
    backup_sh_b64      = base64gzip(file("${local.repo_root}/infrastructure/backup/backup.sh"))
    alert_sh_b64       = base64gzip(file("${local.repo_root}/infrastructure/backup/alert.sh"))
    backup_service_b64 = base64gzip(file("${local.repo_root}/infrastructure/backup/receipts-backup.service"))
    backup_timer_b64   = base64gzip(file("${local.repo_root}/infrastructure/backup/receipts-backup.timer"))
    backup_alert_b64   = base64gzip(file("${local.repo_root}/infrastructure/backup/receipts-backup-alert.service"))
  })
}

resource "aws_instance" "app" {
  ami                    = data.aws_ami.al2023_arm.id
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [var.security_group_id]
  iam_instance_profile   = aws_iam_instance_profile.app.name

  # No key_name, deliberately. Shell access is Session Manager; a key pair
  # would be an unused credential that still works if it leaks.

  user_data_base64 = base64gzip(local.user_data)

  # IMDSv2 only. IMDSv1 is the mechanism behind a well-known SSRF-to-
  # credential-theft class, and this instance makes outbound HTTP requests to
  # third-party APIs with a role that can read a Secrets Manager secret.
  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  root_block_device {
    volume_size = var.root_volume_gb
    volume_type = "gp3"
    encrypted   = true

    # The PostgreSQL volume lives on this disk, so deleting it on termination
    # is deleting the database. Snapshots are the backstop, not this flag.
    delete_on_termination = true

    tags = local.root_volume_tags
  }

  tags = {
    Name = "${var.project}-${var.environment}"
  }

  lifecycle {
    # Checked at PLAN time, so a tag mismatch fails before anything is
    # created rather than being discovered when a restore is needed.
    precondition {
      condition = alltrue([
        for k, v in var.backup_volume_tag : lookup(local.root_volume_tags, k, null) == v
      ])
      error_message = "The root volume tags do not carry every tag in backup_volume_tag, so the DLM policy would not match this volume and no snapshots would be taken."
    }

    # EC2 caps user data at 16,384 bytes in its raw (pre-base64) form, which
    # here is the gzipped blob. The embedded application files make this a
    # real constraint rather than a theoretical one, and growing past it
    # otherwise fails at apply with a message that does not mention user
    # data at all. base64 length 21,844 corresponds to 16,383 raw bytes.
    precondition {
      condition     = length(base64gzip(local.user_data)) <= 21844
      error_message = "Rendered user_data exceeds the EC2 16KB limit once gzipped. Stop embedding files and move the application bundle to S3."
    }

    # A new AMI release must not silently replace the instance -- and with it
    # the database volume -- on an unrelated apply.
    ignore_changes = [ami]
  }
}

# Static address, so the DNS record survives a stop/start.
resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"

  tags = { Name = "${var.project}-${var.environment}" }
}
