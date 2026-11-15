terraform {
  required_version = ">= 1.6, < 2.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}
provider "aws" {
  profile = "ahau-2026"
  region  = "us-east-1"
  default_tags { tags = { Project = "gs-remote-design-smoke" } }
}
variable "public_key" { type = string }
variable "name" { type = string }
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}
resource "aws_vpc" "test" {
  cidr_block = "10.83.0.0/24"
}
resource "aws_internet_gateway" "test" { vpc_id = aws_vpc.test.id }
resource "aws_subnet" "test" {
  vpc_id                  = aws_vpc.test.id
  cidr_block              = "10.83.0.0/26"
  map_public_ip_on_launch = true
}
resource "aws_route_table" "test" {
  vpc_id = aws_vpc.test.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.test.id
  }
}
resource "aws_route_table_association" "test" {
  subnet_id      = aws_subnet.test.id
  route_table_id = aws_route_table.test.id
}
resource "aws_security_group" "test" {
  name_prefix = "${var.name}-"
  vpc_id      = aws_vpc.test.id
  dynamic "ingress" {
    for_each = [22, 30000]
    content {
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = ["189.215.51.112/32"]
    }
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_key_pair" "test" {
  key_name_prefix = "${var.name}-"
  public_key      = var.public_key
}
resource "aws_instance" "test" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = "t3.small"
  subnet_id              = aws_subnet.test.id
  vpc_security_group_ids = [aws_security_group.test.id]
  key_name               = aws_key_pair.test.key_name
  metadata_options { http_tokens = "required" }
  root_block_device {
    volume_size           = 16
    encrypted             = true
    delete_on_termination = true
  }
  tags       = { Name = var.name }
  depends_on = [aws_route_table_association.test]
}
output "public_ip" { value = aws_instance.test.public_ip }
output "instance_id" { value = aws_instance.test.id }
