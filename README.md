# oci-free-vm

Deploy an Oracle Cloud (OCI) VM from your terminal — and keep retrying until one is actually available.

```bash
bunx oci-free-vm
```

Works on **Windows** (10+, PowerShell / Windows Terminal), **macOS** (Apple Silicon and Intel), and **Linux** (x64 and ARM64).

OCI free-tier capacity is scarce — launch requests frequently fail with *"Out of capacity"*. This tool deploys your VM and, when an Availability Domain is full, automatically moves on to the next one, waiting and retrying until the instance is created or you cancel. Your OCI credentials stay on your machine: no backend, no database, no account.

## Quick start

1. Install the Oracle Cloud CLI — <https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm>
2. Create your OCI configuration:

   ```bash
   oci setup config
   ```

3. Deploy:

   ```bash
   bunx oci-free-vm
   ```

The CLI checks for the OCI CLI and `~/.oci/config` before doing anything else and tells you exactly what is missing.

## What happens when you run it

1. Reads your existing OCI configuration — you never paste credentials into the tool.
2. Guides you through: compartment, networking (use an existing VCN, or have one created with an internet gateway and SSH access), architecture (ARM64 / x86_64), shape, OCPUs, memory, disk size, instance name, SSH public key, and public IP.
3. Warns when projected storage exceeds 200 GB, shows a complete deployment summary, and asks before creating anything.
4. Creates the instance, cycling through Availability Domains on capacity errors and retrying until success.

## Configuration

Values resolve in this order: **CLI arguments > YAML defaults > interactive prompts > application defaults.** Prompts only ask for what is still unresolved.

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

## The `oci-free-vm.yaml` file

The YAML file next to wherever you run the CLI is **not a database**. It persists three things:

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

Copy `oci-free-vm.yaml.example` as a starting point, or just run the CLI — the file is created after your first run. It stays human-readable and manually editable, and secrets are never written to it. Use `--config <path>` for a different file.

## Retry behavior

- All Availability Domains are tried in order on every cycle.
- Capacity errors (`Out of capacity` / `Out of host capacity`), rate limits (429), transient 5xx responses, and network failures are retried automatically; authorization failures, invalid parameters, and other non-retryable errors stop immediately with guidance.
- An instance-existence check runs before every cycle, so an interrupted or timed-out run never creates a duplicate instance.
- Cancel at any time with Ctrl+C — no resources are ever deleted, and your last state is preserved in `oci-free-vm.yaml`.

<details>
<summary><strong>Exit codes</strong></summary>

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Deployment failure |
| 2 | Invalid configuration |
| 3 | Authentication/authorization failure |
| 4 | User cancelled |
| 5 | Unexpected error |

</details>

<details>
<summary><strong>Attempt logs</strong></summary>

Every infrastructure attempt writes its own log under `oci-free-vm-logs/` in the directory where you launched the CLI:

```text
oci-free-vm-logs/
├── 2026-10-05T18-30-00-000Z-attempt-001-AD-1.log
└── 2026-10-05T18-30-05-000Z-attempt-002-AD-2.log
```

Filenames are filesystem-safe on macOS, Linux, and Windows. Each log records the attempt's Availability Domain, instance parameters, and result — never private keys, signatures, or other secrets.

</details>

<details>
<summary><strong>Troubleshooting</strong></summary>

- **`OCI configuration not found`** — the CLI also checks for the Oracle Cloud CLI; if it is missing, install it from <https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm>, then run `oci setup config`, then `bunx oci-free-vm`.
- **`Authorization failed or requested resource not found` (ListVcns / ListSubnets)** — your OCI login is valid, but the user in `~/.oci/config` is not allowed to list VCNs in the selected compartment, or the compartment OCID is wrong. Cross-check with the official CLI (`oci network vcn list --compartment-id <ocid>`), pick a different compartment (the tool re-offers the selection), or fix the IAM policy.
- **`not retryable` errors** — check the reported reason and the latest file in `oci-free-vm-logs/`.
- **Instance already exists** — the CLI detects existing instances by name and does nothing.
- **Non-interactive environments** — use `--json`; every required value must come from CLI flags or the YAML file.
- **An old version runs despite updates** — `bunx`/`npx` cache packages; run `bun pm cache rm` (or `npm cache clean --force`) to fetch the latest release.

</details>

<details>
<summary><strong>Development</strong></summary>

### Alternative install methods

```bash
npx oci-free-vm            # run with npm
npm install -g oci-free-vm  # install globally
```

### Repository

```bash
npm install
npm run typecheck
npm run build
npm test   # node --test (the same suite also runs under `bun test`)
```

Publishing is fully automated: push a `v*.*.*` tag and GitHub Actions runs the full test matrix (Windows/macOS/Linux × Node 22/24, plus a Node 20 dist smoke) and publishes to npm via trusted publishing (OIDC) — no npm tokens in the repo, provenance attestations attached automatically.

</details>
