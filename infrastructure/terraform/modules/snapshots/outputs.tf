output "policy_id" {
  value = aws_dlm_lifecycle_policy.snapshots.id
}

output "execution_role_arn" {
  value = aws_iam_role.dlm.arn
}

output "required_volume_tag" {
  description = "The EBS volume must carry this tag or the policy protects nothing."
  value       = { (var.volume_tag_key) = var.volume_tag_value }
}
