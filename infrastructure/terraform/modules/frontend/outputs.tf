output "bucket_name" {
  description = "GitHub environment variable FRONTEND_BUCKET; the workflow's upload target."
  value       = aws_s3_bucket.frontend.id
}

output "bucket_arn" {
  value = aws_s3_bucket.frontend.arn
}

output "archive_bucket_name" {
  description = "Per-SHA build archive, so a rollback needs no rebuild."
  value       = aws_s3_bucket.archive.id
}

output "archive_bucket_arn" {
  value = aws_s3_bucket.archive.arn
}

output "distribution_id" {
  description = "GitHub environment variable CLOUDFRONT_DISTRIBUTION_ID; needed for invalidation."
  value       = aws_cloudfront_distribution.frontend.id
}

output "distribution_arn" {
  value = aws_cloudfront_distribution.frontend.arn
}

output "distribution_domain_name" {
  description = "Cloudflare CNAME target for receipts.<domain>."
  value       = aws_cloudfront_distribution.frontend.domain_name
}

# --- asserted by the module tests ------------------------------------------

output "bucket_is_public" {
  description = "Must be false. The distribution is bypassable if the bucket is readable directly."
  value = !(
    aws_s3_bucket_public_access_block.frontend.block_public_acls &&
    aws_s3_bucket_public_access_block.frontend.block_public_policy &&
    aws_s3_bucket_public_access_block.frontend.ignore_public_acls &&
    aws_s3_bucket_public_access_block.frontend.restrict_public_buckets
  )
}

output "viewer_protocol_policy" {
  value = aws_cloudfront_distribution.frontend.default_cache_behavior[0].viewer_protocol_policy
}

output "minimum_tls_version" {
  value = aws_cloudfront_distribution.frontend.viewer_certificate[0].minimum_protocol_version
}

output "spa_fallback_codes" {
  description = "Error codes rewritten to /index.html with a 200. Both 403 and 404 are required."
  value = sort([
    for r in aws_cloudfront_distribution.frontend.custom_error_response :
    tostring(r.error_code) if r.response_code == 200 && r.response_page_path == "/index.html"
  ])
}

output "html_max_ttl" {
  description = "Must be 0, or a deploy serves the previous build until the edge expires it."
  value       = aws_cloudfront_cache_policy.html.max_ttl
}

output "assets_min_ttl" {
  description = "Content-hashed assets are immutable and cached for a year."
  value       = aws_cloudfront_cache_policy.assets.min_ttl
}
