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

resource "oci_core_vcn" "main" {
  cidr_block     = var.vcn_cidr
  compartment_id = var.compartment_id
  display_name   = "vcn-${var.dns_label}"
  dns_label      = "vcn${var.dns_label}"
}

resource "oci_core_subnet" "main" {
  cidr_block     = var.subnet_cidr
  compartment_id = var.compartment_id
  display_name   = "subnet-${var.dns_label}"
  dns_label      = "subnet${var.dns_label}"
  route_table_id = oci_core_vcn.main.default_route_table_id
  vcn_id         = oci_core_vcn.main.id
}

resource "oci_core_internet_gateway" "main" {
  compartment_id = var.compartment_id
  display_name   = "igw-${var.dns_label}"
  enabled        = true
  vcn_id         = oci_core_vcn.main.id
}

resource "oci_core_default_route_table" "main" {
  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.main.id
  }
  manage_default_resource_id = oci_core_vcn.main.default_route_table_id
}

output "subnet_display_name" {
  description = "Display name of the created subnet"
  value       = oci_core_subnet.main.display_name
}

output "subnet_id" {
  description = "OCID of the created subnet"
  value       = oci_core_subnet.main.id
}
