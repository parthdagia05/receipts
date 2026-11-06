# VPC and the one subnet the instance lives in.
#
# A single PUBLIC subnet, deliberately. The alternative -- private subnet plus
# NAT Gateway -- is ~$34/month to avoid giving one instance a public IP, on a
# deployment whose entire budget is student credits. The exposure is managed
# by the security group instead: only 80 and 443 are open, and neither the
# API nor the database is reachable from outside the instance.
#
# This is a cost/security trade made with open eyes. If the budget changes,
# the upgrade is a private subnet + NAT and nothing else in this design moves.

variable "project" { type = string }
variable "environment" { type = string }

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "subnet_cidr" {
  type    = string
  default = "10.0.0.0/24"
}

variable "az" {
  description = "Availability zone. One, because there is one instance."
  type        = string
  default     = "ap-southeast-2a"
}

variable "enable_http3" {
  description = <<-EOT
    Open 443/udp for HTTP/3. docker-compose.prod.yml publishes 443/udp, so
    without this Caddy advertises a protocol the security group drops and
    some clients pay a stalled handshake before falling back.
  EOT
  type        = bool
  default     = true
}

# --- VPC -------------------------------------------------------------------

resource "aws_vpc" "main" {
  cidr_block = var.vpc_cidr

  # Both needed for Session Manager and for the instance to resolve the
  # regional SSM, ECR and S3 endpoints by name.
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.project}-${var.environment}" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.project}-${var.environment}" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.subnet_cidr
  availability_zone       = var.az
  map_public_ip_on_launch = true

  tags = { Name = "${var.project}-${var.environment}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${var.project}-${var.environment}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# The VPC's default security group allows all traffic between anything that
# lands in it. Leaving it permissive is a standing audit finding, and a
# resource created later without an explicit group gets it by default.
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id
  # No ingress, no egress blocks: this empties the group.
  tags = { Name = "${var.project}-${var.environment}-default-DO-NOT-USE" }
}

# --- security group --------------------------------------------------------
#
# Discrete rule resources rather than inline ingress blocks. Inline blocks are
# authoritative for the whole group, so a rule added out of band is silently
# reverted on the next apply and the diff does not show what was removed.

resource "aws_security_group" "instance" {
  name        = "${var.project}-${var.environment}-instance"
  description = "Public HTTP/HTTPS to Caddy. Nothing else inbound."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.project}-${var.environment}-instance" }

  lifecycle {
    create_before_destroy = true
  }
}

# ONE definition of what is open, used to create the rules and to produce the
# `open_ingress_ports` output the tests assert on. Enumerating the rules in
# the output separately would mean a rule added here is not reflected there,
# and the test would pass while the port was open -- exactly the failure the
# test exists to prevent.
#
# 80 is not redundant with 443: Let's Encrypt's HTTP-01 challenge is served
# there, and Caddy cannot obtain or renew a certificate without it.
locals {
  ingress_rules = merge(
    {
      http = {
        protocol    = "tcp"
        port        = 80
        description = "ACME HTTP-01 challenge and the redirect to HTTPS"
      }
      https = {
        protocol    = "tcp"
        port        = 443
        description = "The API, through Caddy"
      }
    },
    var.enable_http3 ? {
      https_h3 = {
        protocol    = "udp"
        port        = 443
        description = "HTTP/3 (QUIC)"
      }
    } : {},
  )
}

resource "aws_vpc_security_group_ingress_rule" "this" {
  for_each = local.ingress_rules

  security_group_id = aws_security_group.instance.id
  description       = each.value.description

  ip_protocol = each.value.protocol
  from_port   = each.value.port
  to_port     = each.value.port
  cidr_ipv4   = "0.0.0.0/0"
}

# Egress to anywhere: the instance calls an Ethereum RPC endpoint, the World
# ID portal, ECR, SSM, S3 and the distro's package mirrors. Enumerating those
# by CIDR would be a list that rots, and the instance is not the asset an
# egress filter would be protecting.
resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.instance.id
  description       = "All outbound"

  ip_protocol = "-1"
  cidr_ipv4   = "0.0.0.0/0"
}

# --- what is deliberately absent -------------------------------------------
#
# 22/tcp   -- there is no SSH rule and no key pair. Shell access is Session
#             Manager, which is an outbound connection from the instance, so
#             nothing inbound has to be opened and there is no key to leak.
#             This replaces the earlier `ssh_ingress_cidr` design.
#
# 8080/tcp -- the API binds 127.0.0.1:8080 INSIDE the instance and is reached
#             only through Caddy. Opening it here would expose the API without
#             TLS, and would also hand anyone a rate-limit bypass: TRUST_PROXY
#             is true, so a direct caller can forge X-Forwarded-For and get a
#             bucket of their choosing. Verified in Sprint 3B.
#
# 5432/tcp -- PostgreSQL publishes no host port at all. There is no database
#             security group because there is nothing to attach one to.
