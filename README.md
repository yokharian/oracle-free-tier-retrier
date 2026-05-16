# OCI VM Instance Generator

Deploy VM instances on Oracle Cloud Infrastructure (OCI) Free Tier across all Availability Domains. Two deployment methods available: Terraform via Resource Manager or OCI SDK directly.

## OCI Free Tier

Oracle Cloud offers **Always Free** compute resources:

| Shape | Type | Limits |
|-------|------|--------|
| `VM.Standard.A1.Flex` | ARM (Ampere) | Up to 4 OCPUs + 24 GB RAM total |
| `VM.Standard.E2.1.Micro` | AMD (Intel) | 1/8 OCPU + 1 GB RAM |

Available in select regions: `us-ashburn-1` (US East), `eu-frankfurt-1` (EU Central), `ap-osaka-1` (Japan), and others. See [OCI Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

## Prerequisites

- [OCI CLI](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/cliconcepts.htm) installed and configured (`oci setup config`)
- Python 3.8+

## Quick Start

1. Install dependencies:
   ```bash
   pip install oci click
   ```

2. Configure your values:
   ```bash
   cp terraform.tfvars.example terraform.tfvars
   # Edit terraform.tfvars with your compartment OCID, image ID, SSH key, etc.
   ```

3. Run the CLI:
   ```bash
   python main.py --help
   ```

## CLI Commands

| Command | Description |
|---------|-------------|
| `python main.py terraform` | Deploy using Terraform via Resource Manager with automatic AD retry |
| `python main.py direct` | Deploy VMs directly via OCI SDK with interactive prompts |
| `python main.py destroy` | Tear down Resource Manager stacks |

Each command accepts `--help` for available options.

### Terraform Command
```bash
python main.py terraform [--net-stack-id OCID] [--comp-stack-id OCID]
```

**Workflow:**
1. Deploys networking (VCN, subnet, IGW, route table) via Resource Manager
2. Deploys compute stack with SSH key and subnet reference
3. Retries across all Availability Domains if capacity is unavailable
4. Saves stack OCIDs to `.env` for subsequent runs

### Direct Command
```bash
python main.py direct [--compartment-id OCID] [--subnet-id OCID] [--image-id OCID] \
    [--shape SHAPE] [--ocpus N] [--memory N] [--ssh-key PATH] [--name PREFIX]
```

**Workflow:**
1. Interactively selects compartment, subnet, image, and shape (or use CLI flags)
2. If no subnet exists, offers to deploy VCN + subnet via OCI SDK
3. Creates one VM per Availability Domain, retrying on failure
4. No state tracking

### Destroy Command
```bash
python main.py destroy [--net-stack-id OCID] [--comp-stack-id OCID]
```

Reads stack OCIDs from `.env` or accepts them via flags.

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

## Development

```bash
# Install with dev dependencies
pip install -e ".[dev]"

# Run tests
pytest tests/ -v
```

## Project Structure

```
├── main.py                    # Main CLI (Click + OCI SDK)
├── pyproject.toml             # Project metadata, dependencies, pytest config
├── terraform.tfvars           # Your values (gitignored)
├── terraform.tfvars.example   # Template with placeholders
├── .env.example               # Optional stack OCIDs template
├── tests/                     # Pytest test suite
│   ├── conftest.py
│   ├── test_config.py
│   ├── test_utils.py
│   ├── test_compute.py
│   ├── test_resource_manager.py
│   └── test_cli.py
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
| `list_subnets got unknown kwargs` | Ensure `oci` SDK is up to date (`pip install --upgrade oci`) |
| `No subnets found` | Direct command will offer to deploy VCN + subnet automatically |
| `Out of capacity` | Both commands retry across all ADs automatically (900s interval) |
