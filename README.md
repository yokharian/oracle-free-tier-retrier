# OCI VM Deployer

Deploy an OCI VM and automatically retry when capacity is unavailable.

Local-first: OCI credentials stay on your machine — no backend, no database, no account.

## Installation

```bash
npx oci-free-vm
```

or:

```bash
bunx oci-free-vm
```

Optional global installation also works:

```bash
npm install -g oci-free-vm
```

## Requirements

- Node.js >= 20 or Bun
- The Oracle Cloud CLI, installed from <https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm> (Windows, macOS, and Linux instructions there)
- OCI configuration (`~/.oci/config`), created with `oci setup config`
- Permissions to create OCI instances

Works on **Windows** (10+, PowerShell / Windows Terminal), **macOS** (Apple Silicon and Intel), and **Linux** (x64 and ARM64). All filesystem operations use the Node/Bun APIs — no bash, sed, awk, or grep required.

## Basic setup

1. Install the Oracle Cloud CLI from <https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm>.
2. Create your OCI configuration:

   ```bash
   oci setup config
   ```

3. Run the deployer:

   ```bash
   bunx oci-free-vm
   ```

The CLI checks for the OCI CLI and `~/.oci/config` before doing anything else and tells you exactly what is missing. It reads your existing OCI configuration; you never copy credentials into the tool.

## Usage

Running `bunx oci-free-vm` starts an interactive flow:

1. selects a compartment,
2. selects an existing VCN — or creates a new one with an internet gateway, an SSH ingress rule, and a subnet,
3. picks the CPU architecture (ARM64 or x86_64) and a compatible shape,
4. configures OCPUs, memory, disk size, instance name, SSH public key, and public IP,
5. warns when the projected storage exceeds 200 GB,
6. shows a full deployment summary and asks for confirmation.

After confirmation it prepares the network, then attempts to launch the instance in every Availability Domain. Out-of-capacity failures automatically move on to the next AD; when no AD has capacity, the CLI waits (default 15 minutes) and retries — until it succeeds or you press Ctrl+C.

### Command-line options

| Option | Description |
| --- | --- |
| `--config <path>` | configuration file (default `./oci-free-vm.yaml`) |
| `--profile <name>` | OCI config profile (default `DEFAULT`) |
| `--json` | machine-readable JSON output, non-interactive |
| `--yes` | skip confirmation prompts |
| `--name <name>` | instance name |
| `--region <region>` | OCI region |
| `--compartment-id <ocid>` | compartment OCID |
| `--arch arm64\|x86_64` | CPU architecture |
| `--shape <shape>` | instance shape (e.g. `VM.Standard.A1.Flex`) |
| `--ocpus <n>`, `--memory <gb>` | OCPUs / memory for flexible shapes |
| `--disk <gb>` | boot volume size in GB (no arbitrary 200 GB cap) |
| `--ssh-key <path>` | SSH public key file (default `~/.ssh/id_ed25519.pub`) |
| `--public-ip true\|false` | assign a public IP address |
| `--interval-seconds <n>` | wait between retry cycles (default 900) |
| `--network-mode existing\|create` | network mode |
| `--vcn-id <ocid>`, `--subnet-id <ocid>` | existing network ids |

Configuration precedence: **CLI arguments > YAML defaults > interactive prompts > application defaults.** Prompts only ask for values that remain unresolved.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Deployment failure |
| 2 | Invalid configuration |
| 3 | Authentication/authorization failure |
| 4 | User cancelled |
| 5 | Unexpected error |

## YAML configuration (`oci-free-vm.yaml`)

The YAML file is **not a database**. It persists three things:

- `defaults` — your most recently used configuration,
- `state.last_deployment` — the last successful deployment,
- `last_error` — the most recent deployment error.

```yaml
defaults:
  region: us-ashburn-1
  architecture: arm64
  compartment_id: ocid1.compartment...
  network:
    mode: existing
    vcn_id: ocid1.vcn...
    subnet_id: ocid1.subnet...
  instance:
    name: devbox
    shape: VM.Standard.A1.Flex
    ocpus: 1
    memory_gbs: 6
    disk_gbs: 250
    assign_public_ip: true
  ssh:
    public_key_file: ~/.ssh/id_ed25519.pub
  retry:
    interval_seconds: 900

state:
  last_deployment:
    status: succeeded
    instance_id: ocid1.instance...
    instance_name: devbox
    availability_domain: AD-1
    architecture: arm64
    shape: VM.Standard.A1.Flex
    disk_gbs: 250

last_error:
  timestamp: "2026-10-05T18:10:00Z"
  code: OUT_OF_CAPACITY
  message: "Out of capacity"
```

Copy `oci-free-vm.yaml.example` as a starting point, or just run the CLI — it writes the file after your first run. The file stays human-readable and manually editable, and the CLI never writes secrets to it. Run `oci-free-vm --config ./my-config.yaml` to use a different file.

## Retry behavior

- All Availability Domains are tried in order on every cycle.
- Capacity errors (`Out of capacity` / `Out of host capacity`), rate limits (429), transient 5xx responses, and network failures are retried automatically; authorization failures, invalid parameters, and other non-retryable errors abort immediately with guidance.
- An instance-existence check runs before every cycle, so an interrupted or timed-out run never creates a duplicate instance.
- Cancel at any time with Ctrl+C — no resources are ever deleted, and your last state is preserved in `oci-free-vm.yaml`.

## Logs

Every infrastructure attempt writes its own log file under `oci-free-vm-logs/`:

```
oci-free-vm-logs/
├── 2026-10-05T18-30-00-000Z-attempt-001-AD-1.log
└── 2026-10-05T18-30-05-000Z-attempt-002-AD-2.log
```

Filenames are filesystem-safe on macOS, Linux, and Windows. Each log records the attempt's Availability Domain, instance parameters, and result. Logs never contain private keys, signatures, or other secrets.

## Troubleshooting

- **`OCI configuration not found`** — the CLI also checks for the Oracle Cloud CLI; if it is missing, install it from <https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm>, then run `oci setup config`, then `bunx oci-free-vm`.
- **`Authorization failed or requested resource not found` (ListVcns / ListSubnets)** — your OCI login is valid, but the user in `~/.oci/config` is not allowed to list VCNs in the selected compartment, or the compartment OCID is wrong. Cross-check with the official CLI (`oci network vcn list --compartment-id <ocid>`), pick a different compartment, or fix the IAM policy.
- **`not retryable` errors** — check the reported reason and the latest file in `oci-free-vm-logs/`.
- **Instance already exists** — the CLI detects existing instances by name and does nothing.
- **Non-interactive environments** — use `--json`; every required value must come from CLI flags or the YAML file.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test   # node --test (the same suite also runs under `bun test`)
```

Releases are published to npm from the `main` branch by pushing a `v*.*.*` tag — see `.github/workflows/publish.yml` (trusted publishing via npm OIDC, no long-lived token).
