# The PostgreSQL backup bucket.
#
# Unlike the other modules in this tree, this one declares real resources
# rather than a commented design: the bucket has to exist before the first
# night the instance runs, and its access policy is the part worth reviewing
# carefully.
#
# The shape of the permissions is deliberate. The instance may WRITE backups
# and may do nothing else -- no read, no delete, no overwrite. Ransomware and
# a compromised deploy key have the same first move, which is to destroy the
# backups before the data, and an instance that cannot delete them survives
# that move. Expiry is the bucket's lifecycle rule; restoring is an operator
# action with operator credentials.

variable "project" { type = string }
variable "environment" { type = string }

variable "retention_days" {
  description = "Days a backup object stays current before expiring."
  type        = number
  default     = 7

  validation {
    # One day of retention is one bad night away from no backups at all.
    condition     = var.retention_days >= 7
    error_message = "retention_days must be at least 7."
  }
}

variable "noncurrent_retention_days" {
  description = <<-EOT
    Days a superseded version is kept. Versioning is what makes an
    overwrite recoverable, so this is a floor on how long you have to
    notice one. Independent of retention_days.
  EOT
  type        = number
  default     = 30
}

variable "kms_deletion_window_days" {
  description = "Grace period before the CMK is destroyed. Deleting it makes every backup unreadable."
  type        = number
  default     = 30
}

data "aws_caller_identity" "current" {}

locals {
  # Bucket names are globally unique across all AWS accounts, so the account
  # id is appended rather than hoping "receipts-backups" is free.
  bucket_name = "${var.project}-${var.environment}-backups-${data.aws_caller_identity.current.account_id}"
  prefix      = "postgres/"
}

# --- encryption key --------------------------------------------------------

# A customer-managed key rather than SSE-S3, for one reason that matters: its
# key policy is a second, independent place that has to grant access. An
# identity policy alone cannot read these objects.
resource "aws_kms_key" "backups" {
  description             = "Encrypts ${var.project} ${var.environment} PostgreSQL backups"
  enable_key_rotation     = true
  deletion_window_in_days = var.kms_deletion_window_days
}

resource "aws_kms_alias" "backups" {
  name          = "alias/${var.project}-${var.environment}-backups"
  target_key_id = aws_kms_key.backups.key_id
}

# --- bucket ----------------------------------------------------------------

resource "aws_s3_bucket" "backups" {
  bucket = local.bucket_name

  # The bucket holds the only off-instance copy of the database. Terraform
  # destroying it on a refactor is not an acceptable outcome.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket = aws_s3_bucket.backups.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ACLs disabled. Object ownership questions are the usual root cause of a
# bucket that is private but whose objects are not.
resource "aws_s3_bucket_ownership_controls" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.backups.arn
    }
    # Without this every PUT is a separate KMS call. On a nightly dump the
    # cost is trivial either way; it is on because there is no reason for it
    # to be off.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  # Versioning is enabled, so expiring a current object only adds a delete
  # marker. The noncurrent rule below is what actually reclaims storage.
  rule {
    id     = "expire-backups"
    status = "Enabled"

    filter {
      prefix = local.prefix
    }

    expiration {
      days = var.retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_retention_days
    }

    # Without this a failed multipart upload is billed forever and is
    # invisible in the console's object list.
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.backups]
}

# --- bucket policy ---------------------------------------------------------

data "aws_iam_policy_document" "bucket" {
  # S3 is reachable over plain HTTP. Nothing in this project needs that.
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.backups.arn,
      "${aws_s3_bucket.backups.arn}/*",
    ]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Default encryption already applies to objects uploaded without a header.
  # This rejects an upload that explicitly asks for something weaker, which
  # default encryption does not prevent.
  statement {
    sid       = "DenyWrongEncryption"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.backups.arn}/*"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }
}

resource "aws_s3_bucket_policy" "backups" {
  bucket = aws_s3_bucket.backups.id
  policy = data.aws_iam_policy_document.bucket.json

  # Attaching a policy before public access is blocked leaves a window where
  # a mistake in the policy is externally visible.
  depends_on = [aws_s3_bucket_public_access_block.backups]
}

# --- instance permissions --------------------------------------------------

# Write-only, scoped to one prefix of one bucket. Attach to the EC2 instance
# role in the compute module.
#
# s3:GetObject is NOT granted. The consequence is real and accepted: the
# backup script cannot read back what it uploaded, so an upload is verified
# by the PUT succeeding and by the local `pg_restore --list` that ran before
# it. Restores are performed with operator credentials.
locals {
  # Declared here, used to BUILD the policy below and exported for the module
  # tests to assert on. One definition: a test that checked a separate copy
  # of this list would pass while the real policy drifted.
  writer_s3_actions = ["s3:PutObject"]

  # `kms:Decrypt` is here because AWS requires it for MULTIPART uploads with
  # SSE-KMS -- S3 decrypts the data key to assemble the parts -- and the AWS
  # CLI switches to multipart automatically above 8MB. Without it, backups
  # succeed while the database is small and begin failing with AccessDenied
  # the night the dump first crosses that threshold. That is the worst
  # possible failure mode for a backup: silent, delayed, and size-triggered.
  #
  # It does NOT let the instance read its own backups. Reading an object
  # requires s3:GetObject, which is not granted; Decrypt alone cannot fetch
  # the ciphertext. The ViaService condition below narrows it further, so
  # these permissions exist only inside an S3 request and cannot be used
  # against the KMS API directly.
  writer_kms_actions = ["kms:GenerateDataKey", "kms:Encrypt", "kms:Decrypt"]
}

data "aws_region" "current" {}

data "aws_iam_policy_document" "writer" {
  statement {
    sid       = "PutBackups"
    effect    = "Allow"
    actions   = local.writer_s3_actions
    resources = ["${aws_s3_bucket.backups.arn}/${local.prefix}*"]
  }

  statement {
    sid       = "UseBackupKeyForWrites"
    effect    = "Allow"
    actions   = local.writer_kms_actions
    resources = [aws_kms_key.backups.arn]

    # The narrowing that makes Decrypt safe to grant: these actions are
    # usable only when S3 is the caller on this principal's behalf. A
    # compromised instance cannot call kms:Decrypt directly on anything.
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${data.aws_region.current.name}.amazonaws.com"]
    }
  }
}

resource "aws_iam_policy" "writer" {
  name        = "${var.project}-${var.environment}-backup-writer"
  description = "Write-only access to the ${var.project} backup bucket"
  policy      = data.aws_iam_policy_document.writer.json
}

# --- operator / recovery permissions ---------------------------------------
#
# The counterpart to the write-only instance policy: this is what a human
# assumes to perform a restore. Separate, because the whole point of the
# instance being unable to read backups is lost if the same principal holds
# both.
#
# Read and decrypt, not delete. Expiry is the lifecycle rule's job, and an
# operator who can delete backups is an operator whose compromised laptop can
# delete backups. Removing one on purpose is a console action with an
# audit trail, not a capability handed out in advance.
data "aws_iam_policy_document" "operator" {
  statement {
    sid    = "FindBackups"
    effect = "Allow"

    actions = [
      "s3:ListBucket",
      "s3:ListBucketVersions",
    ]

    resources = [aws_s3_bucket.backups.arn]

    # Scoped to the prefix even for listing, so this grants no visibility
    # into anything else that is ever put in this bucket.
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${local.prefix}*", local.prefix]
    }
  }

  statement {
    sid    = "ReadBackups"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      # Versioning is what makes an overwrite recoverable; without this the
      # superseded copy is visible but not retrievable.
      "s3:GetObjectVersion",
    ]

    resources = ["${aws_s3_bucket.backups.arn}/${local.prefix}*"]
  }

  statement {
    sid    = "DecryptBackups"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
    ]

    resources = [aws_kms_key.backups.arn]
  }
}

resource "aws_iam_policy" "operator" {
  name        = "${var.project}-${var.environment}-backup-operator"
  description = "Read and decrypt ${var.project} backups for recovery. No delete."
  policy      = data.aws_iam_policy_document.operator.json
}
