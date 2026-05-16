variable "region" {
  description = "OCI region where resources will be created"
  type        = string
}

variable "compartment_id" {
  description = "The OCID of the compartment where resources will be created"
  type        = string
  sensitive   = true
}

variable "availability_domain" {
  description = "The Availability Domain where the instance will be launched"
  type        = string

  validation {
    condition     = contains(["fNXZ:US-ASHBURN-AD-1", "fNXZ:US-ASHBURN-AD-2", "fNXZ:US-ASHBURN-AD-3"], var.availability_domain)
    error_message = "Availability domain must be one of: fNXZ:US-ASHBURN-AD-1, fNXZ:US-ASHBURN-AD-2, fNXZ:US-ASHBURN-AD-3."
  }
}

variable "instance_name" {
  description = "Display name for the compute instance"
  type        = string
  default     = "freeOracleVM"
}

variable "instance_shape" {
  description = "The shape of the compute instance"
  type        = string
  default     = "VM.Standard.A1.Flex"
}

variable "instance_ocpus" {
  description = "Number of OCPUs for the compute instance"
  type        = number
  default     = 1
}

variable "instance_memory_gbs" {
  description = "Amount of memory in GBs for the compute instance"
  type        = number
  default     = 6
}

variable "instance_image_id" {
  description = "The OCID of the OS image for the compute instance"
  type        = string
  sensitive   = true
}

variable "ssh_public_key" {
  description = "SSH public key for instance access"
  type        = string
  sensitive   = true
}

variable "assign_public_ip" {
  description = "Whether to assign a public IP to the instance"
  type        = bool
  default     = true
}

variable "subnet_id" {
  description = "OCID of the subnet to attach the instance to"
  type        = string
}
