# CLI options

Every value resolves in this order: **CLI arguments > YAML defaults > interactive prompts > application defaults.** A prompt appears only when a value is still unresolved. In `--json` mode there are no prompts, so every required value must come from a flag or the YAML file.

| Option | What it does |
| --- | --- |
| `--config <path>` | Configuration file (default: `~/.oci/oci-free-vm.yaml`) |
| `--profile <name>` | OCI config profile (default: `DEFAULT`) |
| `--json` | Machine-readable output, non-interactive |
| `--yes` | Skip confirmation prompts |
| `--name <name>` | Instance name |
| `--region <region>` | Region shown in the plan; API calls use the region from your OCI profile |
| `--compartment-id <ocid>` | Compartment OCID |
| `--arch arm64\|x86_64` | CPU architecture |
| `--shape <shape>` | Instance shape, e.g. `VM.Standard.A1.Flex` |
| `--ocpus <n>`, `--memory <gb>` | OCPUs and memory for flexible shapes |
| `--disk <gb>` | Boot volume size |
| `--ssh-key <path>` | SSH public key file (default: `~/.ssh/id_ed25519.pub`) |
| `--public-ip true\|false` | Assign a public IP |
| `--delay <n>` | Seconds between full AD cycles (default: 900; max: 2,147,483; `--interval-seconds` is an alias) |
| `--network-mode existing\|create` | Use the existing VCN values, or create a VCN |
| `--vcn-id <ocid>`, `--subnet-id <ocid>` | Existing network IDs |

The configuration file is documented in [the configuration file](configuration.md).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Deployment failure |
| 2 | Invalid configuration |
| 3 | Authentication or authorization failure |
| 4 | Cancelled |
| 5 | Unexpected error |
