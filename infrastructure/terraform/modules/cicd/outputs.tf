output "deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN variable in the GitHub environment."
  value       = aws_iam_role.deploy.arn
}

output "allowed_subjects" {
  description = "Exactly which GitHub OIDC subjects may assume the role. Anything not listed is refused."
  value       = local.allowed_subjects
}

output "oidc_provider_arn" {
  value = local.oidc_arn
}
