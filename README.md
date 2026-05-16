# OCI VM Instance Generator

Deploy VM instances on Oracle Cloud Infrastructure (OCI) Free Tier across all Availability Domains. Two deployment methods available: Terraform via Resource Manager or OCI CLI directly.

## OCI Free Tier

Oracle Cloud offers **Always Free** compute resources:

| Shape | Type | Limits |
|-------|------|--------|
| `VM.Standard.A1.Flex` | ARM (Ampere) | Up to 4 OCPUs + 24 GB RAM total |
| `VM.Standard.E2.1.Micro` | AMD (Intel) | 1/8 OCPU + 1 GB RAM |

Available in select regions: `us-ashburn-1` (US East), `eu-frankfurt-1` (EU Central), `ap-osaka-1` (Japan), and others. See [OCI Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

## Prerequisites

- [OCI CLI](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/cliconcepts.htm) installed and configured (`oci setup config`)
- `jq` installed
- `zip` installed

## Quick Start

1. Configure your values:
   ```bash
   cp terraform.tfvars.example terraform.tfvars
   # Edit terraform.tfvars with your compartment OCID, image ID, SSH key, etc.
   ```

2. Run the script:
   ```bash
   ./main.sh
   ```

3. Choose a deployment method from the menu.

## Deployment Options

| Option | Description |
|--------|-------------|
| **1 — Terraform (Resource Manager)** | Creates managed stacks with automatic retry across Availability Domains on capacity errors. Best for production. |
| **2 — OCI CLI Direct** | Creates VMs in each AD directly. Retries across all ADs if capacity is unavailable. No state management. |
| **3 — Destroy Stacks** | Finds and deletes Resource Manager stacks by name. |

### Option 1 Workflow
1. Deploys networking (VCN, subnet, IGW, route table) via Resource Manager
2. Deploys compute stack with SSH key and subnet reference
3. Retries across all Availability Domains if capacity is unavailable
4. Prints stack OCIDs — save them to `.env` for subsequent runs

### Option 2 Workflow
1. Selects compartment, subnet, image, and shape interactively
2. If no subnet exists, offers to deploy one via Terraform
3. Creates one VM per Availability Domain, retrying on failure
4. No state tracking

## Configuration

### `terraform.tfvars`
All static values. Required fields:

| Variable | Description |
|----------|-------------|
| `compartment_id` | Tenancy or compartment OCID |
| `region` | OCI region (e.g., `us-ashburn-1`) |
| `instance_image_id` | OS image OCID |
| `ssh_public_key` | SSH public key for VM access |

### `.env` (optional)
Store pre-existing stack OCIDs to skip prompts on subsequent runs:
```bash
OCI_NETWORKING_STACK_ID=ocid1.ormstack.oc1...
OCI_COMPUTE_STACK_ID=ocid1.ormstack.oc1...
```

## Project Structure

```
├── main.sh                    # Main deployment script
├── terraform.tfvars           # Your values (gitignored)
├── terraform.tfvars.example   # Template with placeholders
├── .env.example               # Optional stack OCIDs template
├── networking/                # Terraform: VCN, subnet, IGW, route table
│   ├── main.tf
│   └── variables.tf
└── compute/                   # Terraform: VM instance with AD retry
    ├── main.tf
    └── variables.tf
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `NotAuthorizedOrNotFound` | Verify `compartment_id` is correct in `terraform.tfvars` |
| `Config source must be a .zip file` | Ensure `zip` is installed (`apt install zip` / `brew install zip`) |
| `No subnets found` | Option 2 will offer to deploy networking automatically |
| `Out of capacity` | Both options retry across all ADs automatically |
