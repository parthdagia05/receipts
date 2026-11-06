# Private S3 bucket behind CloudFront.
#
# The bucket is private with NO website hosting. CloudFront reaches it through
# an Origin Access Control and the bucket policy admits only that
# distribution. A public bucket would make the distribution bypassable, which
# defeats the TLS policy, the logging and any future WAF attached to it.

variable "project" { type = string }
variable "environment" { type = string }

variable "domain_name" {
  description = "receipts.<domain>"
  type        = string
}

variable "acm_certificate_arn" {
  description = "MUST be issued in us-east-1. CloudFront accepts no other region."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:acm:us-east-1:", var.acm_certificate_arn))
    error_message = "The CloudFront certificate must be an ACM ARN in us-east-1. A certificate from any other region is silently unusable here."
  }
}

variable "price_class" {
  description = <<-EOT
    Edge locations CloudFront may use. PriceClass_100 is North America and
    Europe ONLY -- it does NOT include the Sydney or Mumbai edges, so with
    the origin bucket in ap-southeast-2 every Australian request would be
    served from a US or EU edge. PriceClass_All (or _200) includes Asia
    Pacific; _All is the default here for that reason.
  EOT
  type        = string
  default     = "PriceClass_All"
}

data "aws_caller_identity" "current" {}

locals {
  bucket_name = "${var.project}-${var.environment}-frontend-${data.aws_caller_identity.current.account_id}"
  # Build output archived per commit, so a rollback does not need a rebuild.
  archive_bucket_name = "${local.bucket_name}-backup"
}

# --- S3 --------------------------------------------------------------------

resource "aws_s3_bucket" "frontend" {
  bucket = local.bucket_name
}

# Deliberately absent: aws_s3_bucket_website_configuration. OAC requires the
# REST endpoint, and website hosting would require a public bucket.

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# This is the frontend rollback mechanism: a bad deploy is recovered by
# restoring the previous object versions, not by rebuilding.
resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    apply_server_side_encryption_by_default {
      # SSE-S3, not KMS. These are public assets served to every visitor;
      # a CMK would add cost and a decrypt call per object for no secrecy.
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    id     = "expire-superseded-assets"
    status = "Enabled"
    filter {}

    # Long enough to roll back through several deploys, short enough that
    # every build ever made is not kept forever.
    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.frontend]
}

# The per-SHA archive the deploy workflow syncs to. Separate bucket so the
# archive cannot be served by CloudFront even by accident.
resource "aws_s3_bucket" "archive" {
  bucket = local.archive_bucket_name
}

resource "aws_s3_bucket_public_access_block" "archive" {
  bucket = aws_s3_bucket.archive.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    id     = "expire-old-builds"
    status = "Enabled"
    filter {}

    expiration {
      days = 90
    }
  }
}

# --- CloudFront ------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${var.project}-${var.environment}-frontend"
  description                       = "OAC for the ${var.project} frontend bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Hashed asset filenames are immutable, so they are cached for a year.
resource "aws_cloudfront_cache_policy" "assets" {
  name        = "${var.project}-${var.environment}-assets"
  comment     = "Immutable, content-hashed assets"
  default_ttl = 31536000
  max_ttl     = 31536000
  min_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true

    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
  }
}

# index.html must re-resolve on every deploy, or a visitor keeps loading the
# previous build's asset references. This is what makes a one-path
# invalidation sufficient.
resource "aws_cloudfront_cache_policy" "html" {
  name        = "${var.project}-${var.environment}-html"
  comment     = "index.html -- never cached at the edge"
  default_ttl = 0
  max_ttl     = 0
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true

    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
  }
}

# The app is a static bundle that calls the API cross-origin. These headers
# are the ones S3 cannot set for itself.
resource "aws_cloudfront_response_headers_policy" "security" {
  name    = "${var.project}-${var.environment}-security"
  comment = "Security headers for the static frontend"

  security_headers_config {
    content_type_options { override = true }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }
  }
}

resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${var.project} ${var.environment} frontend"
  default_root_object = "index.html"
  aliases             = [var.domain_name]
  price_class         = var.price_class

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "s3-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = aws_cloudfront_cache_policy.html.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # Vite content-hashes everything under /assets/, so these names change
  # whenever their contents do and can be cached indefinitely.
  ordered_cache_behavior {
    path_pattern           = "/assets/*"
    target_origin_id       = "s3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = aws_cloudfront_cache_policy.assets.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # SPA fallback. The app uses BrowserRouter, so /agents/11265 is not an S3
  # key; without these, every deep link and every refresh 404s. S3 returns
  # 403 rather than 404 for a missing key when the caller cannot list the
  # bucket, which is why both are mapped.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}

# --- bucket policy ---------------------------------------------------------

data "aws_iam_policy_document" "frontend" {
  statement {
    sid     = "AllowCloudFrontRead"
    effect  = "Allow"
    actions = ["s3:GetObject"]

    resources = ["${aws_s3_bucket.frontend.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    # Scoped to THIS distribution. Without the condition any CloudFront
    # distribution in any account could serve this bucket.
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.frontend.arn]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.frontend.arn,
      "${aws_s3_bucket.frontend.arn}/*",
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
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = data.aws_iam_policy_document.frontend.json

  depends_on = [aws_s3_bucket_public_access_block.frontend]
}
