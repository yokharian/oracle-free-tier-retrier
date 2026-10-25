# oci-free-vm

Deploy an Oracle Cloud (OCI) VM from your terminal — and keep retrying until one is actually available.

OCI free-tier capacity is scarce — launch requests frequently fail with *"Out of capacity"*. This tool deploys your VM and, when an Availability Domain is full, automatically moves on to the next one, waiting and retrying until the instance is created or you cancel. Your OCI credentials stay on your machine: no backend, no database, no account.

Works on **Windows** (10+, PowerShell / Windows Terminal), **macOS** (Apple Silicon and Intel), and **Linux** (x64 and ARM64) — natively or through Docker.

## Run using Docker (recommended)

Nothing to install on your machine besides Docker: no Node, no Bun, no npm.

**Prerequisites**

1. [Docker](https://docs.docker.com/get-docker/) (Docker Desktop, or `docker` + `docker compose` v2)
2. OCI credentials in `~/.oci/config` — see [Obtain OCI credentials](#2-obtain-oci-credentials); the Console option needs no other tools

**Interactive deploy** — mount your OCI credentials (read-only), your SSH keys, and a working directory for state:

```bash
docker run --rm -it \
  -v ~/.oci:/home/node/.oci:ro \
  -v ~/.ssh:/home/node/.ssh \
  -v "$PWD:/home/node/work" \
  docker.io/<dockerhub-user>/oci-free-vm:latest
```

> Windows PowerShell: write `~` as `${HOME}`, e.g. `-v ${HOME}/.oci:/home/node/.oci:ro`.

The CLI writes `oci-free-vm.yaml` (state) and `oci-free-vm-logs/` (attempt logs) into the mounted working directory, so they persist between runs. Don't have an SSH key yet? At the SSH prompt pick **Generate a new ed25519 key pair** — it is created in your mounted `~/.ssh`, and the CLI prints the private key path. Keep that file: it is what you will use to SSH into the instance.

**Non-interactive deploy** — every required value comes from CLI flags or the YAML file:

```bash
docker run --rm \
  -v ~/.oci:/home/node/.oci:ro \
  -v ~/.ssh:/home/node/.ssh \
  -v "$PWD:/home/node/work" \
  docker.io/<dockerhub-user>/oci-free-vm:latest \
  --json --yes \
  --compartment-id ocid1.compartment.oc1..xxx \
  --vcn-id ocid1.vcn.oc1..xxx \
  --subnet-id ocid1.subnet.oc1..xxx \
  --name devbox --disk 250 --ssh-key ~/.ssh/id_ed25519.pub
```

**With Docker Compose** — see [`docker-compose.yml`](docker-compose.yml); replace its `${...}` values (export them or put them in a `.env` file next to it):

```bash
DOCKERHUB_USERNAME=<dockerhub-user> docker compose run --rm oci-free-vm
```

Replace `<dockerhub-user>` with the Docker Hub namespace the CI publishes to (the `DOCKERHUB_USERNAME` repository secret). Release images are also tagged with their version, e.g. `oci-free-vm:0.5.0`. Prefer building locally? `docker build -t oci-free-vm .` — a multi-stage build on `node:24-alpine` whose runtime layer adds only the bundled CLI (~7 MB).

The image is published automatically by [`.github/workflows/docker.yml`](.github/workflows/docker.yml): every push to `master` and every `v*.*.*` tag build a multi-arch image (`linux/amd64`, `linux/arm64`) and push it to Docker Hub.

## Run with bunx or npx (alternative)

### 1. Install the prerequisites

**Node.js ≥ 20** (required for `npx`; `bunx` uses Bun instead):

- Any OS: official installers — <https://nodejs.org/en/download>
- macOS: `brew install node`
- Windows: `winget install OpenJS.NodeJS.LTS`
- Linux (nvm):

  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
  nvm install --lts
  ```

**Bun** (optional — `npx oci-free-vm` works with Node alone):

- macOS / Linux: `curl -fsSL https://bun.sh/install | bash`
- Windows PowerShell: `powershell -c "irm bun.sh/install.ps1 | iex"`
- Anywhere with npm: `npm install -g bun`

### 2. Obtain OCI credentials

oci-free-vm signs OCI API calls with an **API signing key** described in `~/.oci/config`. Pick one of these ways to set that up:

**Option A — `oci setup config` (recommended).** Install the Oracle Cloud CLI — <https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm> — then run:

```bash
oci setup config
```

It generates the key pair, registers the public key with your OCI user, and writes `~/.oci/config` for you.

**Option B — Register an API key in the OCI Console (frontend, no CLI needed).**

1. Sign in to <https://cloud.oracle.com>.
2. Open the profile menu (top right) → **My profile** → **API keys** → **Add API key**.
3. Choose **Generate a key pair** and download the private key, e.g. to `~/.oci/oci_api_key.pem`.
4. Copy the configuration snippet the Console shows into `~/.oci/config` (create the file if it does not exist), pointing `key_file` at the downloaded key:

   ```ini
   [DEFAULT]
   user=ocid1.user.oc1..xxx
   fingerprint=xx:xx:...
   tenancy=ocid1.tenancy.oc1..xxx
   region=us-ashburn-1
   key_file=~/.oci/oci_api_key.pem
   ```

   Reference: <https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm>

**Option C — `oci session authenticate`.** This creates a short-lived, token-based profile in `~/.oci/config`. ⚠ oci-free-vm signs requests with API keys only, so token-based profiles are **not supported** here — use Option A or B. (Session auth is still convenient for the `oci` CLI itself.)

### 3. Deploy

```bash
bunx oci-free-vm   # or: npx oci-free-vm
```

The CLI checks for the OCI CLI and `~/.oci/config` before doing anything else and tells you exactly what is missing.

## What happens when you run it

1. Reads your existing OCI configuration — you never paste credentials into the tool.
2. Guides you through: compartment, networking (use an existing VCN, or have one created with an internet gateway and SSH access), architecture (ARM64 / x86_64), shape, OCPUs, memory, disk size, instance name, SSH public key (use an existing one or let the CLI generate a new ed25519 pair), and public IP.
3. Warns when projected storage exceeds 200 GB, shows a complete deployment summary, and asks before creating anything.
4. Creates the instance, cycling through Availability Domains on capacity errors and retrying until success.

## Configuration

Values resolve in this order: **CLI arguments > YAML defaults > interactive prompts > application defaults.** Prompts only ask for what is still unresolved.

| Option | Description |
| --- | --- |
| `--config <path>` | configuration file (default: `./oci-free-vm.yaml`) |
| `--profile <name>` | OCI config profile (default: `DEFAULT`) |
| `--json` | machine-readable JSON output, non-interactive |
| `--yes` | skip confirmation prompts |
| `--name <name>` | instance name |
| `--region <region>` | OCI region |
| `--compartment-id <ocid>` | compartment OCID |
| `--arch arm64\|x86_64` | CPU architecture |
| `--shape <shape>` | instance shape (e.g. `VM.Standard.A1.Flex`) |
| `--ocpus <n>`, `--memory <gb>` | OCPUs / memory for flexible shapes |
| `--disk <gb>` | boot volume size in GB (no arbitrary 200 GB cap) |
| `--ssh-key <path>` | SSH public key file (default: `~/.ssh/id_ed25519.pub`; the interactive prompt also offers to generate one) |
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

- **Docker: `oci-free-vm needs an interactive terminal`** — add `-it` to `docker run` (or use `docker compose run`, which allocates it), or pass `--json` for non-interactive use.
- **`OCI configuration not found`** — the CLI also checks for the Oracle Cloud CLI; if it is missing, install it from <https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm>, then run `oci setup config`, then `bunx oci-free-vm`. You can also create the API key from the OCI Console (see [Obtain OCI credentials](#2-obtain-oci-credentials), Option B).
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

Publishing is fully automated in two lanes: pushing a `v*.*.*` tag runs the full npm test matrix (Windows/macOS/Linux × Node 22/24, plus a Node 20 dist smoke) and publishes to npm via trusted publishing (OIDC) — no npm tokens in the repo, provenance attestations attached automatically. The same tags — plus every `master` push — build the multi-arch Docker image (`linux/amd64`, `linux/arm64`) and publish it to Docker Hub via [`.github/workflows/docker.yml`](.github/workflows/docker.yml), authenticating with the `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` repository secrets.

</details>
