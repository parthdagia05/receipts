output "vpc_id" {
  value = aws_vpc.main.id
}

output "public_subnet_id" {
  value = aws_subnet.public.id
}

output "instance_security_group_id" {
  value = aws_security_group.instance.id
}

output "open_ingress_ports" {
  description = <<-EOT
    Everything reachable from the internet, derived from the same map that
    creates the rules. Adding an ingress rule necessarily changes this, which
    is what makes the assertions in tests/security.tftest.hcl meaningful.
  EOT
  value       = sort([for r in local.ingress_rules : "${r.protocol}/${r.port}"])
}
