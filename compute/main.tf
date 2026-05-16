terraform {
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "8.5.0"
    }
  }
}

provider "oci" {
  region = var.region
}

data "oci_core_subnet" "target" {
  compartment_id = var.compartment_id
  display_name   = var.subnet_display_name
  state          = "AVAILABLE"
}

resource "oci_core_instance" "main" {
  agent_config {
    is_management_disabled = false
    is_monitoring_disabled = false

    plugins_config {
      desired_state = "DISABLED"
      name          = "Vulnerability Scanning"
    }
    plugins_config {
      desired_state = "DISABLED"
      name          = "OS Management Hub Agent"
    }
    plugins_config {
      desired_state = "DISABLED"
      name          = "Management Agent"
    }
    plugins_config {
      desired_state = "ENABLED"
      name          = "Custom Logs Monitoring"
    }
    plugins_config {
      desired_state = "DISABLED"
      name          = "Compute RDMA GPU Monitoring"
    }
    plugins_config {
      desired_state = "ENABLED"
      name          = "Compute Instance Monitoring"
    }
    plugins_config {
      desired_state = "DISABLED"
      name          = "Compute HPC RDMA Auto-Configuration"
    }
    plugins_config {
      desired_state = "DISABLED"
      name          = "Compute HPC RDMA Authentication"
    }
    plugins_config {
      desired_state = "ENABLED"
      name          = "Cloud Guard Workload Protection"
    }
    plugins_config {
      desired_state = "DISABLED"
      name          = "Block Volume Management"
    }
    plugins_config {
      desired_state = "DISABLED"
      name          = "Bastion"
    }
  }

  availability_config {
    recovery_action = "RESTORE_INSTANCE"
  }

  availability_domain               = var.availability_domain
  compartment_id                    = var.compartment_id
  display_name                      = var.instance_name
  is_pv_encryption_in_transit_enabled = true
  shape                             = var.instance_shape

  create_vnic_details {
    assign_ipv6ip             = false
    assign_private_dns_record = true
    assign_public_ip          = var.assign_public_ip
    display_name              = "${var.instance_name}-vnic"
    subnet_id                 = data.oci_core_subnet.target.id
  }

  instance_options {
    are_legacy_imds_endpoints_disabled = true
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
  }

  shape_config {
    memory_in_gbs = var.instance_memory_gbs
    ocpus         = var.instance_ocpus
  }

  source_details {
    source_id   = var.instance_image_id
    source_type = "image"
  }
}

output "instance_id" {
  description = "OCID of the created compute instance"
  value       = oci_core_instance.main.id
}

output "availability_domain" {
  description = "Availability Domain where the instance was created"
  value       = var.availability_domain
}
