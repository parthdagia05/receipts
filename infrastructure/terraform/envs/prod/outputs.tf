# --- DNS -------------------------------------------------------------------

output "instance_public_ip" {
  description = "Cloudflare A record: api.receipts.<domain>. Create it BEFORE first boot, or Caddy's ACME challenge fails."
  value       = module.compute.public_ip
}

# --- deployment ------------------------------------------------------------

output "instance_id" {
  description = "GitHub environment variable INSTANCE_ID."
  value       = module.compute.instance_id
}

output "deploy_role_arn" {
  description = "GitHub environment variable AWS_DEPLOY_ROLE_ARN."
  value       = module.cicd.deploy_role_arn
}

output "deploy_allowed_subjects" {
  description = "The only OIDC subjects that may assume the deploy role."
  value       = module.cicd.allowed_subjects
}

output "ecr_repository_url" {
  value = aws_ecr_repository.api.repository_url
}

output "runtime_secret_name" {
  description = "Populate out of band with a JSON object of the four runtime secrets. Terraform never writes a value here."
  value       = aws_secretsmanager_secret.runtime.name
}

# --- backups ---------------------------------------------------------------

output "backup_bucket_name" {
  description = "Set as S3_BUCKET in /opt/receipts/backup.env. user-data already does this."
  value       = module.backup.bucket_name
}

output "backup_prefix" {
  value = module.backup.prefix
}

output "backup_writer_policy_arn" {
  description = "Attached to the instance role. Write-only: no read, no delete."
  value       = module.backup.writer_policy_arn
}

output "backup_operator_policy_arn" {
  description = "Attach to the human who performs restores. Read and decrypt, no delete."
  value       = module.backup.operator_policy_arn
}

output "backup_kms_key_arn" {
  description = "Destroying this key makes every stored backup permanently unreadable."
  value       = module.backup.kms_key_arn
}

# --- the snapshot tag relationship -----------------------------------------
#
# These three are the deliverable for "do not assume the snapshot policy
# protects a volume". After apply, `terraform output snapshot_tag_matches`
# must be true; it compares what DLM looks for against what is actually on
# the volume, rather than asserting it in prose.

output "snapshot_required_volume_tag" {
  description = "What the DLM policy matches on."
  value       = module.snapshots.required_volume_tag
}

output "root_volume_id" {
  description = "The volume that must carry it."
  value       = module.compute.root_volume_id
}

output "root_volume_tags" {
  description = "What is actually on the volume."
  value       = module.compute.root_volume_tags
}

output "snapshot_tag_matches" {
  description = "True when every tag DLM requires is present on the root volume. Must be true, or no snapshots are taken."
  value = alltrue([
    for k, v in module.snapshots.required_volume_tag :
    lookup(module.compute.root_volume_tags, k, null) == v
  ])
}

# --- network ---------------------------------------------------------------

output "open_ingress_ports" {
  description = "Everything reachable from the internet. Should be tcp/80, tcp/443 and udp/443 only."
  value       = module.network.open_ingress_ports
}

# --- frontend (not implemented) --------------------------------------------
#
# output "cloudfront_domain_name"     {}  # Cloudflare CNAME receipts.<domain>
# output "cloudfront_distribution_id" {}  # CI invalidation
# output "frontend_bucket"            {}  # CI upload target

# --- asserted by tests/security.tftest.hcl ---------------------------------

output "root_volume_encrypted" {
  value = module.compute.root_volume_encrypted
}

output "imdsv2_required" {
  value = module.compute.imdsv2_required
}

output "backup_writer_actions" {
  description = "Everything the instance may do to backups. Asserted in tests/security.tftest.hcl."
  value       = module.backup.writer_actions
}

output "snapshot_required_tag_count" {
  value = length(module.snapshots.required_volume_tag)
}

output "root_volume_backup_tag" {
  value = lookup(module.compute.root_volume_tags, "Backup", null)
}

output "backup_writer_kms_via_service" {
  description = "Asserted in tests: the instance's KMS permissions are confined to S3 requests."
  value       = module.backup.writer_kms_via_service
}

output "api_image_reference" {
  description = "Exactly what the instance will pull. Asserted in tests to be registry-qualified and not a moving tag."
  value       = "${module.compute.ecr_registry}/receipts-api:${var.image_tag}"
}

# --- frontend --------------------------------------------------------------
#
# Null while `acm_certificate_arn_us_east_1` is unset and the module is
# disabled, rather than failing the plan.

output "frontend_bucket" {
  description = "GitHub environment variable FRONTEND_BUCKET."
  value       = one(module.frontend[*].bucket_name)
}

output "frontend_archive_bucket" {
  value = one(module.frontend[*].archive_bucket_name)
}

output "cloudfront_distribution_id" {
  description = "GitHub environment variable CLOUDFRONT_DISTRIBUTION_ID."
  value       = one(module.frontend[*].distribution_id)
}

output "cloudfront_domain_name" {
  description = "Cloudflare CNAME target for receipts.<domain>."
  value       = one(module.frontend[*].distribution_domain_name)
}

output "frontend_bucket_is_public" {
  value = one(module.frontend[*].bucket_is_public)
}

output "frontend_viewer_protocol_policy" {
  value = one(module.frontend[*].viewer_protocol_policy)
}

output "frontend_minimum_tls_version" {
  value = one(module.frontend[*].minimum_tls_version)
}

output "frontend_spa_fallback_codes" {
  value = one(module.frontend[*].spa_fallback_codes)
}

output "frontend_html_max_ttl" {
  value = one(module.frontend[*].html_max_ttl)
}

output "frontend_assets_min_ttl" {
  value = one(module.frontend[*].assets_min_ttl)
}
