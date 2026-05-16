variable "region" {
  description = "OCI region where resources will be created"
  type        = string
}

variable "compartment_id" {
  description = "The OCID of the compartment where resources will be created"
  type        = string
  sensitive   = true
}

variable "vcn_cidr" {
  description = "CIDR block for the VCN"
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR block for the subnet"
  type        = string
  default     = "10.0.0.0/24"
}

variable "dns_label" {
  description = "DNS label for VCN and subnet"
  type        = string
  default     = "05120944"
}
