output "bucket_name" {
  description = "Set as S3_BUCKET in /opt/receipts/backup.env."
  # local.bucket_name, not aws_s3_bucket.backups.id. They are the same
  # string, but the resource attribute is unknown until apply, and this value
  # feeds the instance's user_data -- which would make the 16KB size
  # precondition in the compute module unevaluatable at plan time and defer
  # it to apply. Module ordering is unaffected: compute still consumes
  # writer_policy_arn, which is resource-derived.
  value = local.bucket_name
}

output "bucket_arn" {
  value = aws_s3_bucket.backups.arn
}

output "prefix" {
  description = "Set as S3_PREFIX. The writer policy is scoped to this prefix."
  value       = trimsuffix(local.prefix, "/")
}

output "kms_key_arn" {
  description = "Destroying this key makes every stored backup permanently unreadable."
  value       = aws_kms_key.backups.arn
}

output "writer_policy_arn" {
  description = "Attach to the EC2 instance role in the compute module."
  value       = aws_iam_policy.writer.arn
}

output "operator_policy_arn" {
  description = "Attach to the human/role that performs restores. Read and decrypt only."
  value       = aws_iam_policy.operator.arn
}

output "writer_actions" {
  description = <<-EOT
    Every action the instance role is granted against the backup bucket and
    its key. Exported from the same local that builds the policy, so a test
    asserting on it is asserting on the real grant rather than a copy.
  EOT
  value       = concat(local.writer_s3_actions, local.writer_kms_actions)
}

output "writer_kms_via_service" {
  description = <<-EOT
    The kms:ViaService value the writer policy is conditioned on. Non-empty
    means the instance's KMS grants -- including Decrypt, which multipart
    SSE-KMS uploads require -- are usable only inside an S3 request.
  EOT
  value       = "s3.${data.aws_region.current.name}.amazonaws.com"
}
