variable "project" {
  type    = string
  default = "receipts"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "region" {
  description = "CloudFront certificates must still be in us-east-1."
  type        = string
  default     = "ap-southeast-2"
}

variable "az" {
  description = "One availability zone, because there is one instance."
  type        = string
  default     = "ap-southeast-2a"
}

variable "domain" {
  description = "Apex domain. App at receipts.<domain>, API at api.receipts.<domain>."
  type        = string
}

variable "acme_email" {
  description = "Where Let's Encrypt sends certificate expiry warnings."
  type        = string
}

variable "acm_certificate_arn_us_east_1" {
  description = <<-EOT
    CloudFront certificate for receipts.<domain>. MUST be issued in
    us-east-1; CloudFront silently accepts no other region.

    Empty disables the frontend module entirely, so the backend can be
    planned and applied before the certificate has finished DNS validation.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.acm_certificate_arn_us_east_1 == "" || can(regex("^arn:aws:acm:us-east-1:[0-9]{12}:certificate/", var.acm_certificate_arn_us_east_1))
    error_message = "acm_certificate_arn_us_east_1 must be empty (frontend disabled) or an ACM certificate ARN in us-east-1. A certificate from another region cannot be attached to a CloudFront distribution."
  }
}

# `ssh_ingress_cidr` was removed with the SSH rule. Shell access is Session
# Manager: an outbound connection from the instance, so nothing inbound is
# opened and there is no key pair to leak. A variable that no longer affects
# anything is worse than no variable, so it is gone rather than deprecated.

variable "github_repository" {
  description = "owner/repo. The OIDC trust policy is pinned to it."
  type        = string
}

# --- instance --------------------------------------------------------------

variable "instance_type" {
  description = "t4g.small (Graviton/ARM). The image is arm64-only."
  type        = string
  default     = "t4g.small"
}

variable "image_tag" {
  description = "Exact immutable image tag to boot, e.g. the 7-character commit SHA CI pushed. No default, and \"latest\" is rejected."
  type        = string

  # Deliberately the same rules as modules/compute. The module's copy is the
  # authoritative guard for any caller; this one exists so the error names
  # the variable the operator actually set, at the boundary they set it,
  # instead of surfacing from inside a module they did not edit.
  validation {
    condition     = trimspace(var.image_tag) != ""
    error_message = "image_tag must not be empty."
  }

  validation {
    condition     = !contains(["latest", "local", "main", "master"], lower(trimspace(var.image_tag)))
    error_message = "image_tag must name a specific build, not a moving tag such as \"latest\"."
  }

  validation {
    condition     = can(regex("^[0-9a-f]{7,40}$", trimspace(var.image_tag)))
    error_message = "image_tag must be a lowercase hex commit SHA of 7 to 40 characters, matching what the deploy workflow pushes."
  }
}

variable "root_volume_gb" {
  description = "OS, Docker images, the PostgreSQL volume and local backups share this disk."
  type        = number
  default     = 30
}

# --- application configuration ---------------------------------------------
#
# Non-secret by construction: every value here is public or appears in the
# frontend bundle. The four secrets live in Secrets Manager and are never
# Terraform inputs.

variable "app_config" {
  description = "Written to .env.prod at boot. Contains no secrets."

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

  validation {
    condition     = can(regex("^0x[0-9a-fA-F]{40}$", var.app_config.review_gateway_address))
    error_message = "review_gateway_address must be a 20-byte hex address."
  }

  validation {
    condition     = contains(["production", "staging", "sandbox"], var.app_config.world_environment)
    error_message = "world_environment must be production, staging or sandbox."
  }

  validation {
    # The signed feedbackURI is derived from this, so a localhost value would
    # put an unresolvable host into every attestation this deployment signs.
    condition     = !can(regex("localhost|127\\.0\\.0\\.1", var.app_config.review_content_base_url))
    error_message = "review_content_base_url must be the public origin, not localhost: it is baked into every signed attestation."
  }
}

# --- backups ---------------------------------------------------------------

variable "backup_retention_days" {
  description = "Days a PostgreSQL dump stays current in S3 before expiring."
  type        = number
  default     = 7
}

variable "backup_noncurrent_retention_days" {
  description = "Days a superseded dump version is kept. This is the window to notice an overwrite."
  type        = number
  default     = 30
}

variable "snapshot_retention_count" {
  description = "Daily EBS snapshots retained by Data Lifecycle Manager."
  type        = number
  default     = 7
}
