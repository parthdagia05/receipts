# Daily EBS snapshots via Data Lifecycle Manager.
#
# This and the pg_dump to S3 cover different failures and neither replaces
# the other:
#
#   snapshot  -- the instance or its volume is gone. Restores the whole disk,
#                including Docker images and the compose state, in minutes.
#                But it is a crash-consistent copy of a running filesystem:
#                PostgreSQL recovers from its WAL on first start, which
#                normally works and is not a guarantee.
#
#   pg_dump   -- a bad migration, a dropped table, logical corruption. The
#                archive is verified at creation, so it is known-good in a
#                way a snapshot is not. But it restores a database, not a
#                machine, and loses everything since the last run.
#
# DLM targets volumes by TAG, not by id, so the volume created in the compute
# module must carry the tag below or this policy will silently protect
# nothing. That is the failure mode to watch for: a policy that runs nightly,
# reports success, and has zero volumes in scope.

variable "project" { type = string }
variable "environment" { type = string }

variable "volume_tag_key" {
  description = "Tag key DLM matches on. The EBS volume must carry it."
  type        = string
  default     = "Backup"
}

variable "volume_tag_value" {
  description = "Tag value DLM matches on."
  type        = string
  default     = "receipts-prod"
}

variable "snapshot_time_utc" {
  description = <<-EOT
    Daily start time, UTC, HH:MM. DLM starts within an hour of this.
    Set after the pg_dump window so a night's logical backup is already
    uploaded when the snapshot is taken.
  EOT
  type        = string
  default     = "03:30"

  validation {
    condition     = can(regex("^([01][0-9]|2[0-3]):[0-5][0-9]$", var.snapshot_time_utc))
    error_message = "snapshot_time_utc must be HH:MM in 24-hour UTC."
  }
}

variable "retention_count" {
  description = "Snapshots kept. DLM deletes the oldest beyond this."
  type        = number
  default     = 7

  validation {
    condition     = var.retention_count >= 2 && var.retention_count <= 1000
    error_message = "retention_count must be between 2 and 1000."
  }
}

# --- IAM -------------------------------------------------------------------

data "aws_iam_policy_document" "assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["dlm.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dlm" {
  name               = "${var.project}-${var.environment}-dlm-snapshots"
  description        = "Assumed by Data Lifecycle Manager to snapshot the ${var.project} volume"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

# AWS's own service-role policy. Written by hand this would be a list of
# ec2:CreateSnapshot / DeleteSnapshot / CreateTags permissions that AWS
# changes as DLM gains features; the managed policy is already scoped to
# DLM's operations and is the documented attachment.
resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

# --- policy ----------------------------------------------------------------

resource "aws_dlm_lifecycle_policy" "snapshots" {
  description        = "${var.project} ${var.environment} daily EBS snapshots"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]

    # The one tag that decides what is protected.
    target_tags = {
      (var.volume_tag_key) = var.volume_tag_value
    }

    schedule {
      name = "daily-${var.retention_count}d"

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = [var.snapshot_time_utc]
      }

      retain_rule {
        count = var.retention_count
      }

      # Carries the volume's tags onto the snapshot, so a snapshot found
      # later can be traced back to what it came from.
      copy_tags = true

      tags_to_add = {
        Name        = "${var.project}-${var.environment}-auto"
        Project     = var.project
        Environment = var.environment
        CreatedBy   = "dlm"
      }
    }
  }
}

# --- encryption ------------------------------------------------------------
#
# There is no encryption setting here, and that is correct rather than an
# omission: a snapshot of an encrypted volume is encrypted with the same CMK,
# automatically and unconditionally, and a snapshot of an unencrypted volume
# cannot be encrypted by DLM.
#
# So snapshot encryption is decided entirely by the volume. The compute
# module's root_block_device must set `encrypted = true`, and the account
# should have EBS encryption-by-default on so a volume created by hand later
# is not the exception. Verify with:
#
#   aws ec2 get-ebs-encryption-by-default
#   aws ec2 describe-volumes --volume-ids <id> --query 'Volumes[].Encrypted'
#
# Cross-region or cross-account copies are not configured. They are the
# answer to "the whole region is gone" and to "our account was compromised",
# neither of which this deployment currently defends against; the S3 bucket
# has the same limitation.
