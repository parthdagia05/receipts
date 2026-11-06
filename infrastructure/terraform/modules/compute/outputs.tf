output "instance_id" {
  description = "Set as INSTANCE_ID in the GitHub environment; the deploy workflow targets it over SSM."
  value       = aws_instance.app.id
}

output "public_ip" {
  description = "Cloudflare A record target for api.receipts.<domain>."
  value       = aws_eip.app.public_ip
}

output "instance_role_name" {
  value = aws_iam_role.app.name
}

output "instance_role_arn" {
  value = aws_iam_role.app.arn
}

output "root_volume_id" {
  description = "The volume DLM must match. Verify with the tag output below."
  value       = aws_instance.app.root_block_device[0].volume_id
}

output "root_volume_tags" {
  description = "Actual tags on the root volume. Must be a superset of the snapshots module's required_volume_tag."
  value       = local.root_volume_tags
}

output "ami_id" {
  value = data.aws_ami.al2023_arm.id
}

output "root_volume_encrypted" {
  description = "Asserted in the module tests: the PostgreSQL data directory lives on this volume."
  value       = aws_instance.app.root_block_device[0].encrypted
}

output "imdsv2_required" {
  description = "Asserted in the module tests. IMDSv1 turns an SSRF into role-credential theft."
  value       = aws_instance.app.metadata_options[0].http_tokens == "required"
}

output "ecr_registry" {
  value = var.ecr_registry
}

output "image_tag" {
  description = "The exact tag user-data writes to .env.prod."
  value       = trimspace(var.image_tag)
}
