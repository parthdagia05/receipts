# Production environment. Composes the modules.

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }

  # Created by hand before the first init -- a backend cannot bootstrap
  # itself. See docs/deployment/runbook.md.
  #
  # backend "s3" {
  #   bucket         = "receipts-tfstate-<ACCOUNT_ID>"
  #   key            = "prod/terraform.tfstate"
  #   region         = "ap-southeast-2"
  #   dynamodb_table = "receipts-tflock"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# CloudFront accepts certificates from us-east-1 only, whatever region
# everything else is in. This alias exists for that one certificate and is a
# standing source of confusion, so it is called out rather than left implicit.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

data "aws_caller_identity" "current" {}

# --- container registry ----------------------------------------------------

resource "aws_ecr_repository" "api" {
  name                 = "${var.project}-api"
  image_tag_mutability = "IMMUTABLE" # a SHA tag must always mean one image

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

# Rollback needs old images, so tagged ones are kept generously. Untagged
# layers are build residue and are not.
resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the last 30 tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = 30
        }
        action = { type = "expire" }
      },
    ]
  })
}

# --- runtime secret --------------------------------------------------------
#
# Created EMPTY. There is no aws_secretsmanager_secret_version here,
# deliberately: a value in a .tf file is a value in state and in git history.
# Populated out of band -- runbook.md -- with a JSON object holding
# RECORD_SERVER_PRIVATE_KEY, WORLD_SIGNING_KEY, RPC_URL and POSTGRES_PASSWORD.
resource "aws_secretsmanager_secret" "runtime" {
  name        = "${var.project}/${var.environment}/runtime"
  description = "Runtime secrets read by the instance at boot. Never populated by Terraform."

  # Long enough to recover from an accidental delete, which otherwise makes
  # the instance unbootable.
  recovery_window_in_days = 30
}

# --- modules ---------------------------------------------------------------

module "network" {
  source = "../../modules/network"

  project     = var.project
  environment = var.environment
  az          = var.az
}

module "backup" {
  source = "../../modules/backup"

  project     = var.project
  environment = var.environment

  retention_days            = var.backup_retention_days
  noncurrent_retention_days = var.backup_noncurrent_retention_days
}

module "snapshots" {
  source = "../../modules/snapshots"

  project     = var.project
  environment = var.environment

  retention_count = var.snapshot_retention_count
}

module "compute" {
  source = "../../modules/compute"

  project     = var.project
  environment = var.environment
  aws_region  = var.region

  subnet_id         = module.network.public_subnet_id
  security_group_id = module.network.instance_security_group_id

  instance_type  = var.instance_type
  root_volume_gb = var.root_volume_gb

  # THE tag relationship. Passing the snapshots module's own output means the
  # volume cannot be tagged with anything other than what DLM matches on --
  # the two cannot drift, because there is only one definition. The compute
  # module additionally asserts it in a plan-time precondition.
  backup_volume_tag = module.snapshots.required_volume_tag

  secret_id  = aws_secretsmanager_secret.runtime.name
  secret_arn = aws_secretsmanager_secret.runtime.arn

  ecr_repository_arn = aws_ecr_repository.api.arn

  # Derived from the account and region rather than read off the repository
  # resource. Both forms produce the same string, but the resource attribute
  # is unknown until apply, and that would make user_data unknown at plan --
  # which in turn silently defers the 16KB size precondition below to apply,
  # where it fails after the instance has started being created.
  ecr_registry = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com"

  backup_bucket            = module.backup.bucket_name
  backup_prefix            = module.backup.prefix
  backup_writer_policy_arn = module.backup.writer_policy_arn
  backup_retention_days    = var.backup_retention_days

  image_tag = var.image_tag

  site_address = "api.receipts.${var.domain}"
  acme_email   = var.acme_email

  app_config = var.app_config
}

module "cicd" {
  source = "../../modules/cicd"

  project     = var.project
  environment = var.environment

  github_repository  = var.github_repository
  instance_id        = module.compute.instance_id
  ecr_repository_arn = aws_ecr_repository.api.arn

  # Empty while the frontend module is disabled; the policy omits those
  # statements entirely rather than granting a placeholder.
  frontend_bucket_arns = length(module.frontend) == 0 ? [] : [
    module.frontend[0].bucket_arn,
    module.frontend[0].archive_bucket_arn,
  ]
  cloudfront_distribution_arn = length(module.frontend) == 0 ? "" : module.frontend[0].distribution_arn
}

# Conditional on the certificate existing. CloudFront requires an ACM
# certificate in us-east-1, and that certificate must be issued and
# validated before the distribution can be created -- so the backend can be
# planned and applied first, with the frontend enabled afterwards by setting
# `acm_certificate_arn_us_east_1`. Without this the whole plan would be
# blocked on a DNS validation that has not happened yet.
module "frontend" {
  count  = var.acm_certificate_arn_us_east_1 == "" ? 0 : 1
  source = "../../modules/frontend"

  project     = var.project
  environment = var.environment

  domain_name         = "receipts.${var.domain}"
  acm_certificate_arn = var.acm_certificate_arn_us_east_1
}

# --- Observability ---------------------------------------------------------
#
# aws_cloudwatch_metric_alarm.instance_status_check
# aws_cloudwatch_metric_alarm.cpu_high
# aws_cloudwatch_metric_alarm.disk_low   (the CloudWatch agent installed by
#                                         user-data publishes disk and memory)
#
# Alarms need an SNS topic to deliver to, and that topic is also what
# SNS_TOPIC_ARN in backup.env wants. Both are deferred together rather than
# creating a topic with no subscribers.
