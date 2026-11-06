# Offline assertions about the production plan.
#
#   cd infrastructure/terraform/envs/prod && terraform test
#
# `mock_provider` means this needs no AWS credentials and creates nothing --
# it runs a plan against a fake provider and asserts on the result. The point
# is that the properties below stop being prose in a comment and become
# something CI can fail on.
#
# Assertions reference root outputs only, which is the documented surface for
# `terraform test`.

# The provider computes `aws_iam_policy_document.json` server-side, so a
# mocked one returns a placeholder that the IAM resources then reject as
# invalid JSON. Supplying a valid empty document lets the plan complete.
# Policy CONTENT is therefore not assertable through these documents, which
# is why the backup module exports its granted actions as a plain list.
mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  domain            = "example.test"
  acme_email        = "ops@example.test"
  github_repository = "parthdagia05/receipt"
  image_tag         = "a1b2c3d"

  app_config = {
    postgres_db                 = "receipts"
    postgres_user               = "receipts"
    chain_id                    = "11155111"
    review_gateway_address      = "0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD"
    receipt_settler_address     = "0xC3AA7a2F43d83680f9E0B97e0Eb4fD01E421ceDe"
    identity_registry_address   = "0x8004A818BFB912233c491871b3d84c89A494BD9e"
    reputation_registry_address = "0x8004B663056A597Dffe9eCcC1965A193B7388713"
    gateway_deploy_block        = "12064002"
    world_app_id                = "app_7de77482d1055cc43c0c5a2a7ede66a5"
    world_rp_id                 = "rp_d3afb91156ea1942"
    world_environment           = "production"
    review_content_base_url     = "https://api.receipts.example.test"
    cors_allowed_origins        = "https://receipts.example.test"
  }
}

# The headline property carried over from Sprint 3C-1: a snapshot policy that
# matches no volume runs nightly, reports success, and protects nothing.
run "dlm_policy_matches_the_actual_volume" {
  command = plan

  assert {
    condition     = output.snapshot_tag_matches
    error_message = "The DLM target tag is not present on the root volume: snapshots would cover zero volumes."
  }

  assert {
    condition     = output.snapshot_required_tag_count > 0
    error_message = "The snapshots module declares no target tag."
  }

  assert {
    condition     = output.root_volume_backup_tag == "receipts-prod"
    error_message = "The root volume must carry Backup=receipts-prod exactly, as the brief requires."
  }
}

# The security group is the only thing between the internet and the box.
run "nothing_unexpected_is_exposed" {
  command = plan

  assert {
    condition     = !contains(output.open_ingress_ports, "tcp/22")
    error_message = "SSH is open. Shell access is Session Manager; there should be no inbound SSH rule."
  }

  assert {
    condition     = !contains(output.open_ingress_ports, "tcp/5432")
    error_message = "PostgreSQL is exposed. It publishes no host port and must never have an inbound rule."
  }

  assert {
    condition     = !contains(output.open_ingress_ports, "tcp/8080")
    error_message = "The API port is exposed. It binds 127.0.0.1 and is reached only through Caddy; opening it bypasses TLS and the rate limiter."
  }

  assert {
    condition     = contains(output.open_ingress_ports, "tcp/443")
    error_message = "443 is not open, so nothing can reach the API."
  }

  assert {
    condition     = contains(output.open_ingress_ports, "tcp/80")
    error_message = "80 is not open, so Caddy cannot complete the ACME HTTP-01 challenge and will never obtain a certificate."
  }
}

# Cost pressure is the usual reason encryption gets turned off. Asserting it
# makes that a failing test rather than a quiet diff.
run "storage_is_encrypted_and_metadata_is_locked_down" {
  command = plan

  assert {
    condition     = output.root_volume_encrypted
    error_message = "The root volume is not encrypted. The PostgreSQL data directory lives on it."
  }

  assert {
    condition     = output.imdsv2_required
    error_message = "IMDSv2 is not required. IMDSv1 lets an SSRF against this instance yield its role credentials."
  }
}

# The instance must be able to create backups and must not be able to
# destroy or read them.
run "instance_cannot_delete_or_read_backups" {
  command = plan

  assert {
    condition     = !contains(output.backup_writer_actions, "s3:DeleteObject")
    error_message = "The instance's backup policy grants DeleteObject. A compromised instance must not be able to destroy its own backups."
  }

  assert {
    condition     = !contains(output.backup_writer_actions, "s3:GetObject")
    error_message = "The instance's backup policy grants GetObject. It is write-only by design."
  }

  assert {
    condition     = contains(output.backup_writer_actions, "s3:PutObject")
    error_message = "The instance cannot write backups at all."
  }

  # A wildcard would satisfy every assertion above while granting everything.
  assert {
    condition = alltrue([
      for a in output.backup_writer_actions : !can(regex("\\*", a))
    ])
    error_message = "The instance's backup policy contains a wildcard action."
  }
}

# Regression: backups larger than the 8MB multipart threshold.
#
# `kms:Decrypt` was absent, which is correct-looking and wrong: AWS requires
# it for multipart uploads with SSE-KMS. Backups therefore worked while the
# database was small and would have begun failing with AccessDenied the
# first night the dump crossed 8MB -- silent, delayed and size-triggered.
#
# The property that actually matters is not "no Decrypt", it is "cannot read
# its own backups". That is preserved by the absence of s3:GetObject, and
# narrowed further by the ViaService condition.
run "large_backups_can_be_uploaded_without_granting_read_access" {
  command = plan

  assert {
    condition     = contains(output.backup_writer_actions, "kms:Decrypt")
    error_message = "kms:Decrypt is missing. Multipart SSE-KMS uploads require it, so any backup over 8MB will fail with AccessDenied."
  }

  assert {
    condition     = contains(output.backup_writer_actions, "kms:GenerateDataKey")
    error_message = "kms:GenerateDataKey is missing; no upload can be encrypted."
  }

  # The narrowing that makes Decrypt safe: usable only via S3.
  assert {
    condition     = can(regex("^s3\\.[a-z0-9-]+\\.amazonaws\\.com$", output.backup_writer_kms_via_service))
    error_message = "The KMS grant is not conditioned on kms:ViaService=s3.<region>.amazonaws.com, so the instance could call KMS directly."
  }

  # Decrypt is only safe because the ciphertext is unreachable.
  assert {
    condition     = !contains(output.backup_writer_actions, "s3:GetObject")
    error_message = "s3:GetObject is granted. With kms:Decrypt also present, the instance could now read its own backups."
  }

  assert {
    condition     = !contains(output.backup_writer_actions, "s3:DeleteObject")
    error_message = "s3:DeleteObject is granted."
  }
}

# Regression: the image the instance actually pulls.
run "image_reference_is_registry_qualified_and_pinned" {
  command = plan

  assert {
    condition     = can(regex("^[0-9a-z.-]+\\.amazonaws\\.com/receipts-api:[0-9a-f]{7,40}$", output.api_image_reference))
    error_message = "The API image reference is not <ecr-registry>/receipts-api:<sha>. An unqualified name resolves to Docker Hub."
  }

  assert {
    condition     = !can(regex(":(latest|local|main|master)$", output.api_image_reference))
    error_message = "The image reference ends in a moving tag. ECR tags are immutable, so it would never resolve."
  }
}

# The OIDC trust policy is the whole security boundary for CI.
run "ci_cannot_be_assumed_from_an_arbitrary_branch" {
  command = plan

  assert {
    condition = alltrue([
      for s in output.deploy_allowed_subjects :
      can(regex("^repo:parthdagia05/receipt:environment:", s))
    ])
    error_message = "An OIDC subject is not pinned to this repository and a named environment; a fork or any branch could assume the deploy role."
  }

  assert {
    condition     = length(output.deploy_allowed_subjects) > 0
    error_message = "No OIDC subject is permitted, so the deploy role can never be assumed."
  }
}

# Regression: a moving or empty tag must be refused at plan time.
#
# `image_tag` used to default to "latest". The ECR repository has immutable
# tags, so "latest" is never published and the first boot pulled a manifest
# that could not exist -- a failure that only surfaced on the instance.
#
# `expect_failures` asserts the variable validation itself rejects these.
run "rejects_the_latest_tag" {
  command = plan

  variables {
    image_tag = "latest"
  }

  expect_failures = [var.image_tag]
}

run "rejects_an_empty_tag" {
  command = plan

  variables {
    image_tag = ""
  }

  expect_failures = [var.image_tag]
}

run "rejects_a_branch_name_as_a_tag" {
  command = plan

  variables {
    image_tag = "main"
  }

  expect_failures = [var.image_tag]
}

run "rejects_a_non_sha_tag" {
  command = plan

  variables {
    image_tag = "v1.2.3"
  }

  expect_failures = [var.image_tag]
}

run "accepts_a_commit_sha" {
  command = plan

  variables {
    image_tag = "9f2c1ab"
  }

  assert {
    condition     = endswith(output.api_image_reference, ":9f2c1ab")
    error_message = "A valid commit SHA was not carried through to the image reference."
  }
}

# The frontend is disabled unless a us-east-1 certificate is supplied, so
# these runs provide one. CloudFront is the only thing serving the app, and
# every property below is one that is invisible until a user hits it.
run "frontend_is_private_and_https_only" {
  command = plan

  variables {
    acm_certificate_arn_us_east_1 = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555"
  }

  assert {
    condition     = output.frontend_bucket_is_public == false
    error_message = "The frontend bucket is publicly readable, which makes the CloudFront distribution bypassable and defeats its TLS policy and headers."
  }

  assert {
    condition     = output.frontend_viewer_protocol_policy == "redirect-to-https"
    error_message = "CloudFront serves the app over plain HTTP."
  }

  assert {
    condition     = output.frontend_minimum_tls_version == "TLSv1.2_2021"
    error_message = "The distribution accepts TLS below 1.2."
  }
}

# A BrowserRouter app behind S3: /agents/11265 is not a key, so without the
# rewrites every deep link and every refresh 404s. S3 answers 403 rather
# than 404 when the caller cannot list the bucket, so both must be mapped.
run "spa_deep_links_and_refreshes_resolve" {
  command = plan

  variables {
    acm_certificate_arn_us_east_1 = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555"
  }

  assert {
    condition     = contains(output.frontend_spa_fallback_codes, "403")
    error_message = "403 is not rewritten to /index.html; deep links will fail with access denied."
  }

  assert {
    condition     = contains(output.frontend_spa_fallback_codes, "404")
    error_message = "404 is not rewritten to /index.html; refreshing a route will 404."
  }
}

# The cache split is what makes a one-path invalidation correct. Get it
# wrong and a deploy either serves the old app indefinitely or costs a
# full invalidation every time.
run "cache_policy_makes_deploys_take_effect" {
  command = plan

  variables {
    acm_certificate_arn_us_east_1 = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555"
  }

  assert {
    condition     = output.frontend_html_max_ttl == 0
    error_message = "index.html is cached at the edge, so a deploy would keep serving the previous build's asset references."
  }

  assert {
    condition     = output.frontend_assets_min_ttl == 31536000
    error_message = "Content-hashed assets are not cached for a year, so every visitor re-fetches immutable files."
  }
}

# The certificate region catches people out: CloudFront silently accepts no
# other region, and the failure arrives at apply.
run "rejects_a_certificate_outside_us_east_1" {
  command = plan

  variables {
    acm_certificate_arn_us_east_1 = "arn:aws:acm:ap-southeast-2:123456789012:certificate/11111111-2222-3333-4444-555555555555"
  }

  expect_failures = [var.acm_certificate_arn_us_east_1]
}
