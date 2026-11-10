# PRD — oci-free-vm

## 1. Objective

Build a cross-platform CLI for developers that deploys virtual machines on Oracle Cloud Infrastructure (OCI) and automatically retries provisioning when an Availability Domain has insufficient capacity.

The product must be:

- Local-first.
- Backend-free.
- Database-free.
- Account-free: no product account, though OCI credentials are still required.
- Cross-platform: macOS, Linux, and Windows.
- Distributed through npm.
- Executable through `npx`.
- Configurable through a single YAML file.
- Implemented as a small set of focused TypeScript modules.
- Published automatically through GitHub Actions.
- Designed around excellent CLI UX rather than exposing raw OCI SDK operations.

The CLI must keep OCI credentials entirely on the user's machine.

---

## 2. Target User

Developers who:

- use Oracle Cloud Infrastructure;
- already have OCI credentials/configuration locally;
- work on macOS, Linux, or Windows;
- need to provision OCI VMs;
- encounter OCI capacity constraints;
- want automatic retries across Availability Domains;
- prefer a local developer tool over a web application;
- do not want to upload OCI credentials to a third-party service.

The product is not intended to be a general-purpose OCI administration tool.

---

## 3. Product Value Proposition

> **Deploy an OCI VM and automatically keep trying until capacity is available.**

The basic experience should be:

```bash
npx oci-free-vm
```

The CLI:

1. Reads the user's local OCI configuration.
2. Discovers the available infrastructure.
3. Guides the user through deployment configuration.
4. Shows a final deployment summary.
5. Creates the requested infrastructure.
6. Automatically retries when capacity is unavailable, starting at the highest-numbered Availability Domain.
7. Persists the result locally.
8. Produces a log for every infrastructure deployment attempt.

---

## 4. MVP Scope

### Included

The MVP supports direct OCI provisioning.

It must support:

- OCI local authentication.
- Compartments.
- Existing VCN selection.
- New VCN creation.
- Existing subnet selection where applicable.
- New networking creation where applicable.
- Ubuntu images.
- x86 instances.
- ARM instances.
- Instance shapes appropriate for the selected architecture.
- Configurable OCPUs.
- Configurable memory.
- Configurable boot volume/storage size.
- SSH public key.
- Instance name.
- Public IP.
- Availability Domain discovery and persistence.
- Highest-numbered-first Availability Domain retries.
- Automatic retry.
- Configurable retry interval (`--delay` / `retry.interval_seconds`).
- Existing-instance detection.
- Local execution state.
- Per-attempt infrastructure logs.
- JSON output mode.

---

## 5. Networking / VCN UX

Networking must be an explicit step in the deployment flow.

The user must be able to choose:

```text
? Network configuration

❯ Use an existing VCN
  Create a new VCN
```

### Existing VCN

When selected, query OCI and display available VCNs.

Example:

```text
Available VCNs

❯ production-vcn
  development-vcn
  default-vcn
```

After selecting a VCN, display/select its available subnets.

```text
? Subnet

❯ public-subnet
  private-subnet
```

### Create new VCN

The CLI should ask only for the minimum required configuration.

Example:

```text
? VCN name
› oci-free-vm-vcn

? VCN CIDR
› 10.0.0.0/16

? Subnet CIDR
› 10.0.0.0/24
```

The CLI should create the required networking resources for the VM.

The final summary must clearly indicate whether the VCN was:

```text
Existing VCN
```

or:

```text
New VCN
```

The CLI must never silently create a new VCN when an existing VCN was available and selected.

---

## 6. CPU Architecture

The user must explicitly be able to select the desired CPU architecture.

Example:

```text
? CPU architecture

❯ ARM64
  x86_64
```

The CLI must only present compatible OCI shapes/images for the selected architecture.

The deployment summary must include:

```text
Architecture     ARM64
Shape             VM.Standard.A1.Flex
```

or:

```text
Architecture     x86_64
Shape             VM.Standard.E2.1.Micro
```

The architecture is a deployment parameter and must be persisted in the YAML state/defaults.

---

## 7. Compute Configuration

The user must be able to configure:

- CPU architecture.
- Shape.
- OCPUs.
- Memory.
- Instance name.
- Boot volume size.
- SSH public key.
- Public IP.

Example:

```text
? CPU architecture
❯ ARM64
  x86_64

? Shape
❯ VM.Standard.A1.Flex

? OCPUs
› 1

? Memory (GB)
› 6

? Disk size (GB)
› 250

? Instance name
› devbox
```

---

## 8. Disk Storage

The user must be able to specify the disk/boot-volume size per instance.

The CLI must support sizes greater than 200 GB.

Example:

```text
? Disk size (GB)
› 250
```

The deployment summary must display:

```text
Disk               250 GB
```

The CLI must validate the configured value against the limits supported by OCI.

The product should not arbitrarily cap the user at 200 GB.

---

## 9. Existing Instance Storage Warning

Before deployment, the CLI must inspect existing instances relevant to the selected compartment/configuration and calculate the existing storage allocation when possible.

The purpose is to warn users when creating the requested instance will cause the total configured storage to exceed 200 GB.

Example:

```text
Storage warning

Existing instances:
  api-01       100 GB
  worker-01     80 GB

Current total:  180 GB
New instance:    50 GB
Projected total: 230 GB

⚠ The projected total exceeds 200 GB.

This may exceed your intended storage limit.

? Continue?
❯ Yes
  No
```

The warning must be informational and must not silently block deployment.

If the projected total does not exceed 200 GB:

```text
Storage

Existing instances: 180 GB
New instance:        20 GB
Projected total:    200 GB

✓ Within 200 GB.
```

The calculation should be based on the storage information available from OCI.

The CLI must clearly distinguish:

- current storage;
- requested storage;
- projected storage.

---

## 10. OCI Authentication

The CLI must use the user's existing OCI configuration.

It must not require users to copy OCI credentials into the application.

Expected flow:

```text
~/.oci/config
      ↓
OCI authentication
      ↓
OCI APIs
```

If `~/.oci/config` is absent on an interactive run, the CLI can collect the API key details and write the file, or the user can create it with `oci setup config` / the OCI Console.

If OCI configuration is unavailable:

```text
✗ OCI configuration not found.

Configure OCI first:

  oci setup config

Then run:

  npx oci-free-vm
```

The CLI must never persist:

- OCI private keys;
- API secrets;
- passwords;
- authentication tokens.

---

## 11. YAML Configuration File

The YAML file is **not a database**.

Its purpose is:

1. Persist the configuration from the user's most recent CLI execution.
2. Store successful deployment state.
3. Store the most recent deployment error.
4. Store the discovered Availability Domains.
5. Allow users to manually provide default values.

Default location:

```text
~/.oci/oci-free-vm.yaml
```

Optional:

```bash
oci-free-vm --config ./my-config.yaml
```

---

## 12. YAML Semantics

The YAML contains three conceptual sections:

```yaml
defaults:
  ...

state:
  ...

last_error:
  ...
```

Example:

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
  availability_domains:
    - fNXZ:US-ASHBURN-AD-1
    - fNXZ:US-ASHBURN-AD-2
    - fNXZ:US-ASHBURN-AD-3
  last_deployment:
    status: succeeded
    instance_id: ocid1.instance...
    instance_name: devbox
    availability_domain: fNXZ:US-ASHBURN-AD-1
    architecture: arm64
    shape: VM.Standard.A1.Flex
    disk_gbs: 250
    timestamp: "2026-10-05T18:32:00Z"

last_error:
  timestamp: "2026-10-05T18:10:00Z"
  code: OUT_OF_CAPACITY
  message: "Out of capacity"
```

The structure above is the implemented schema: `defaults`, `state`, and `last_error` are the top-level sections.

---

## 13. YAML Persistence Rules

After a successful deployment:

- Persist the successful deployment state.
- Persist the selected configuration as defaults.

Example:

```text
✓ Deployment successful

Configuration saved to:
  ~/.oci/oci-free-vm.yaml
```

If deployment fails:

- Update `last_error`.
- Preserve the configuration.
- Do not overwrite a previously successful deployment state unless appropriate.

The YAML must remain human-readable and manually editable.

The CLI must not write secrets to it.

---

## 14. Configuration Precedence

Configuration priority:

```text
CLI arguments
    >
YAML defaults
    >
interactive prompts
    >
application defaults
```

Example:

```bash
oci-free-vm --name my-vm
```

overrides:

```yaml
defaults:
  instance:
    name: another-vm
```

Interactive prompts should only ask for values that remain unresolved.

---

## 15. Deployment Summary

Before creating infrastructure, show a complete summary.

Example:

```text
Deployment summary

  Region          us-ashburn-1
  Compartment     production

  Network
    VCN           production-vcn
    Subnet        public-subnet

  Compute
    Architecture  ARM64
    Shape         VM.Standard.A1.Flex
    OCPUs         1
    Memory        6 GB
    Disk          250 GB
    Public IP     yes
    Instance      devbox

  Availability Domains
    AD-1
    AD-2
    AD-3

  Storage
    Existing      180 GB
    New           250 GB
    Projected     430 GB
    ⚠ Exceeds 200 GB

? Deploy this infrastructure?
❯ Yes
  No
```

The user must explicitly confirm.

---

## 16. Deployment UX

After confirmation:

```text
Starting deployment...

✓ Configuration validated
✓ OCI connection verified
✓ Network ready
✓ Using 3 Availability Domains (AD-3, AD-2, AD-1)

Trying AD-3...
```

On success:

```text
✓ Instance created

Deployment successful

  Instance:       devbox
  Instance OCID:  ocid1.instance...
  Architecture:   ARM64
  Shape:           VM.Standard.A1.Flex
  AD:              AD-3
```

---

## 17. Retry Engine

Automatic retry is the core feature.

The CLI must:

1. Discover all available Availability Domains and persist them in `state.availability_domains`.
2. Attempt deployment, starting at the highest-numbered AD (AD-3 → AD-2 → AD-1).
3. Detect capacity-related failures.
4. Try the next Availability Domain, reporting any AD that was skipped and why.
5. Wait between retry cycles.
6. Check whether the instance already exists.
7. Continue until success or explicit cancellation.

A region may expose a single Availability Domain (for example `mx-monterrey-1`). The CLI warns once at startup in that case; retries repeat in the same AD because no other AD exists. Transient network failures during setup are retried up to three times with backoff before the run gives up.

Default retry interval:

```yaml
defaults:
  retry:
    interval_seconds: 900
```

Equivalent to 15 minutes.

The interval must be configurable (`--delay`, or `retry.interval_seconds` in the YAML). It must be a positive integer no greater than 2,147,483 seconds (the `setTimeout` limit).

---

## 18. Retry UX

Example:

```text
Starting deployment...

✓ Using 3 Availability Domains (AD-3, AD-2, AD-1)

AD-3
✗ Out of capacity

AD-2
✗ Out of capacity

AD-1
✗ Out of capacity

No Availability Domain currently has capacity.

Retrying in 15 minutes.

  Attempt:       3
  Last error:    Out of capacity
  Next retry:    14:32:10

Press Ctrl+C to stop.
```

The process must remain local.

If the user closes the terminal, the process may stop. The YAML preserves the last known state/error so the user can restart the deployment.

The MVP does not require cloud-side durable execution.

---

## 19. Deployment Log

Every infrastructure deployment attempt must produce a log entry.

Create a local directory:

```text
~/.oci/oci-free-vm-logs/
```

Each attempt appends one block to a single file:

```text
~/.oci/oci-free-vm-logs/oci-free-vm.log
```

Entries are separated by a line of `=` characters.

The log must contain enough information to troubleshoot the infrastructure attempt.

Example:

```text
Timestamp: 2026-10-05T18:30:00Z
Attempt: 1
Availability Domain: fNXZ:US-ASHBURN-AD-1
Instance: devbox
Architecture: ARM64
Shape: VM.Standard.A1.Flex
OCPUs: 1
Memory: 6 GB
Disk: 250 GB

Operation: LaunchInstance

Result: FAILED

Error code: OUT_OF_CAPACITY
Error: Out of capacity
```

A failure to append the log is a warning and must not change the deployment result.

Logs must **never contain private keys, authentication tokens, passwords, or other secrets**.

---

## 20. Log Format

Each appended block must be deterministic and contain:

- timestamp;
- attempt number;
- full Availability Domain name;
- instance name, architecture, shape, OCPUs, memory, and disk;
- operation and result;
- error code and message on failure.

The fixed filename `oci-free-vm.log` is valid on macOS, Linux, and Windows, so no per-attempt filename rules are needed.

Example block header:

```text
============================================================
Timestamp: 2026-10-05T18:30:00Z
Attempt: 1
Availability Domain: fNXZ:US-ASHBURN-AD-1
```

---

## 21. Successful Deployment State

When deployment succeeds, persist at least:

```yaml
state:
  availability_domains:
    - fNXZ:US-ASHBURN-AD-1
  last_deployment:
    status: succeeded
    timestamp: "..."
    instance_id: "..."
    instance_name: "..."
    availability_domain: "fNXZ:US-ASHBURN-AD-1"
    architecture: arm64
    shape: "VM.Standard.A1.Flex"
    disk_gbs: 250
    ocpus: 1
    memory_gbs: 6
    public_ip: true
    vcn_id: "ocid1.vcn..."
    subnet_id: "ocid1.subnet..."
```

This lets a subsequent CLI execution understand the last successful deployment.

---

## 22. Idempotency

Before creating an instance, the CLI must check whether the requested instance already exists.

If it exists:

```text
✓ Instance "devbox" already exists.

  OCID: ocid1.instance...

Nothing else to do.
```

The CLI must avoid accidentally creating duplicate instances after:

- a timeout;
- network interruption;
- process restart;
- ambiguous OCI API responses.

---

## 23. Error Classification

At minimum classify:

### Retryable

- Out of capacity.
- Temporary OCI service failures.
- Transient network errors.
- Transient network failures during setup, retried up to three times with backoff.

### Non-retryable

- Authorization failure.
- Invalid configuration.
- Invalid OCID.
- Missing resource.
- Unsupported shape/image combination.
- Invalid compartment.
- Invalid networking configuration.
- Local filesystem failure (full disk, missing permissions).

Unexpected errors must be rendered with a readable message; the OCI SDK transport envelope is classified as transient.

Example:

```text
✗ Deployment failed

Reason:
  Authorization failed

This error is not retryable.

Check your OCI permissions and configuration.
```

---

## 24. Ctrl+C

Ctrl+C must terminate gracefully.

Example:

```text
^C

Deployment stopped.

No resources were deleted.

Last state saved to:
  ~/.oci/oci-free-vm.yaml

Last attempt log:
  ~/.oci/oci-free-vm-logs/2026-10-05T18-30-00-000Z-attempt-003-AD-1.log
```

The CLI must never automatically destroy resources when the user cancels.

---

## 25. Exit Codes

```text
0   Success
1   Deployment failure
2   Invalid configuration
3   Authentication/authorization failure
4   User cancelled
5   Unexpected error
```

---

## 26. Project Structure

The source stays small and split by responsibility.

```text
oracle-free-tier-retrier/
├── src/
│   ├── index.ts      # CLI shell: prompts, rendering, argument parsing, entry point
│   ├── core.ts       # OCI client, planning, networking, retry engine, run orchestration
│   ├── types.ts      # shared types and YAML schemas
│   └── utils.ts      # small pure helpers
├── docs/
│   ├── configuration.md
│   ├── cli.md
│   ├── development.md
│   └── prd.md
├── package.json
├── tsconfig.json
├── README.md
├── CHANGELOG.md
└── .github/workflows/
```

`src/index.ts` is the only entry point; the other modules are imported by it or by `core.ts`.

The responsibilities are:

- `index.ts` — CLI parsing, prompts, rendering, and the entry point.
- `core.ts` — OCI client, plan building, networking, retry engine, and run orchestration.
- `types.ts` — shared types and YAML schemas.
- `utils.ts` — small pure helpers shared by the CLI and the core.

A future refactor will split the four files further so each stays under 250 pure LOC; the public imports will stay stable through re-export barrels.

---

## 27. Runtime

The package supports Node.js 22.23.4+, 24.22.1+, or 26.12.1+. Those are the first releases of each line patched for CVE-2026-111497 (Brotli decoder). Node 20 is end-of-life and has no patched release. npm treats `engines` as advisory: older versions print `EBADENGINE` but may still run, so the README tells users to upgrade rather than ignore it.

Users should be able to run:

```bash
npx oci-free-vm
```

The package must not require a globally installed CLI.

Optional global installation:

```bash
npm install -g oci-free-vm
```

must also work.

---

## 28. Platform Support

Target platforms:

### macOS

- Apple Silicon.
- Intel.

### Linux

- x64.
- ARM64.
- Docker images for `linux/amd64` and `linux/arm64`.

### Windows

- Windows 10+.
- PowerShell.
- Windows Terminal.

Do not depend on:

- bash;
- sed;
- awk;
- grep;
- Unix-specific filesystem behavior.

All filesystem operations must use Node APIs.

---

## 29. Security

The application is local-first.

It must never send credentials to a product-owned backend.

Never persist:

- private keys;
- authentication tokens;
- passwords;
- secrets.

Never write credentials into:

```text
oci-free-vm.yaml
oci-free-vm-logs/
stdout
stderr
JSON output
```

Logs must sanitize OCI API errors if they contain potentially sensitive information.

No telemetry is collected or sent.

---

## 30. Package Metadata

The package should expose:

```json
{
  "name": "oci-free-vm",
  "version": "0.6.0",
  "bin": {
    "oci-free-vm": "./dist/index.js"
  }
}
```

The package is published as `oci-free-vm`; `0.6.0` is the current release on npm (with provenance) and as the `docker.io/<dockerhub-user>/oracle-free-tier-retrier:0.6.0` image.

---

## 31. GitHub Repository

Use a simple GitHub workflow:

```text
feature branch
      ↓
Pull Request
      ↓
master
```

No GitFlow.

The repository is the source of truth.

---

## 32. GitHub Actions

Create `.github/workflows/publish.yml` and `.github/workflows/docker.yml`.

`publish.yml` must:

1. Checkout the repository at the pushed tag.
2. Install Node.js 22 and 24 for the test matrix.
3. Install dependencies.
4. Typecheck.
5. Build.
6. Run tests, including a Node 24 dist smoke.
7. Publish to npm via Trusted Publishing (OIDC) with provenance.

Publishing occurs only from a `v*.*.*` tag pushed to `master`. The same tag — and every `master` push — builds and pushes the multi-arch Docker image (`linux/amd64`, `linux/arm64`) to GHCR via `docker.yml`.

The current suite contains 47 tests; the local gate is `npm run typecheck && npm run build && npm test`.

---

## 33. Release Process

Use Semantic Versioning. The current release is `0.6.0` (2026-11-04); the live line is `0.x` (ignore the unrelated historical `v1.0.0` tag).

A release is explicit and reproducible:

```text
Developer
   │
   ▼
npm version <version> --no-git-tag-version
   │
   ▼
commit feature changes + version bump
   │
   ▼
git tag v<version>
   │
   ▼
push master, then push the tag
   │
   ▼
GitHub Actions
   │
   ├── test matrix
   ├── build
   ├── npm publish
   └── Docker image → GHCR
```

---

## 34. npm Distribution

npm is the package registry. The package is npm-first; Bun is not part of the build or release workflow.

The same package must work with:

```bash
npx oci-free-vm
```

Distribution model:

```text
GitHub
   │
   ▼
GitHub Actions
   │
   ▼
npm Registry
   │
   └── npx oci-free-vm
```

---

## 35. README

The README is the short path into the product, not the reference manual.

- Open with a one-line promise and a short paragraph: scarce free-tier capacity, automatic retries, and credentials that stay local.
- Make `npx oci-free-vm` the default run method and the first command.
- Keep exactly one fenced `bash` block per run method. Docker is documented at the end, with a single `docker run` block.
- Put the benefit-led "Why" section before the deeper behavior notes.
- Link the reference material instead of inlining it:
  - `docs/concepts.md` — core concepts: authentication, API operations, retries, classification, and state.
  - `docs/cli.md` — options and exit codes.
  - `docs/configuration.md` — the YAML file.
  - `docs/development.md` — build, test, and release.
  - `docs/prd.md` — this document.
  - `CHANGELOG.md` — release history.
- Keep troubleshooting short and practical.

---

## 36. Acceptance Criteria

The MVP is complete when a developer can:

1. Install a supported Node.js (22.23.4+, 24.22.1+, or 26.12.1+).
2. Configure OCI locally.
3. Run:

```bash
npx oci-free-vm
```

4. Select an existing VCN or create a new one.
5. Select an existing subnet when using an existing VCN.
6. Select ARM64 or x86_64.
7. Select a compatible OCI shape.
8. Configure OCPUs.
9. Configure memory.
10. Configure disk size greater than 200 GB.
11. Configure an SSH public key.
12. Configure an instance name.
13. See the existing storage allocation.
14. Receive a warning when projected storage exceeds 200 GB.
15. Review the complete deployment summary.
16. Confirm deployment.
17. See the deployment attempt for each Availability Domain.
18. Automatically retry capacity failures.
19. Stop gracefully with Ctrl+C.
20. Persist the last configuration to YAML.
21. Persist successful deployment state to YAML.
22. Persist the latest error to YAML.
23. Generate a separate `.log` file for every infrastructure deployment attempt.
24. Restart the CLI using the persisted YAML configuration.
25. Run the CLI on macOS.
26. Run the CLI on Linux.
27. Run the CLI on Windows.
28. Run the package with `npx`.
29. Publish the package automatically through GitHub Actions.
30. Never send OCI credentials to an external backend.
31. Persist discovered Availability Domains in the YAML state.
32. Retry from the highest-numbered AD and report why an AD was skipped.
33. Warn when the region exposes a single AD.
34. Run the published Docker image on `linux/amd64` and `linux/arm64`.
35. Keep typecheck, build, and the test suite green before release.
36. Append every attempt to a single `oci-free-vm.log`.
37. Treat log and state write failures as warnings, not run-ending errors.

---

## 37. Explicit Non-Goals

Do not implement in the MVP:

- Web UI.
- LLM.
- MCP.
- AWS.
- Backend.
- Database.
- User authentication.
- Terraform.
- Resource Manager.
- Automatic destroy.
- Multi-user functionality.
- Cloud-side durable execution.
- Remote execution.
- Telemetry.
- Cloud synchronization.
- Multi-region failover.
- Daemon/background service.

---

## 38. Core Product Principle

> **Boring infrastructure, excellent CLI UX.**

The implementation should remain small enough that a developer can read the entire application source and understand the provisioning flow.

The implementation is intentionally:

```text
Focused TypeScript modules
        +
One YAML file
        +
Local OCI credentials
        +
OCI APIs
        +
npm distribution
```

The product transforms the existing Python provisioning script into a polished developer tool:

```text
Python CLI
    ↓
TypeScript CLI
    ↓
npm
    ↓
npx
    ↓
OCI VM deployment
    ↓
Automatic capacity retry
    ↓
Local state + append-only log
```