# PRD — OCI VM Deployer CLI

## 1. Objective

Build a cross-platform CLI for developers that deploys virtual machines on Oracle Cloud Infrastructure (OCI) and automatically retries provisioning when an Availability Domain has insufficient capacity.

The product must be:

- Local-first.
- Backend-free.
- Database-free.
- Account-free.
- Cross-platform: macOS, Linux, and Windows.
- Distributed through npm.
- Executable through both `npx` and `bunx`.
- Configurable through a single YAML file.
- Implemented as a single TypeScript source file for the MVP.
- Published automatically through GitHub Actions.
- Designed around excellent CLI UX rather than exposing raw OCI SDK operations.

The CLI must keep OCI credentials entirely on the user's machine.

---

# 2. Target User

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

# 3. Product Value Proposition

> **Deploy an OCI VM and automatically keep trying until capacity is available.**

The basic experience should be:

```bash
bunx oci-vm
```

or:

```bash
npx oci-vm
```

The CLI:

1. Reads the user's local OCI configuration.
2. Discovers the available infrastructure.
3. Guides the user through deployment configuration.
4. Shows a final deployment summary.
5. Creates the requested infrastructure.
6. Automatically retries when capacity is unavailable.
7. Persists the result locally.
8. Produces a log for every infrastructure deployment attempt.

---

# 4. MVP Scope

## Included

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
- Availability Domain discovery.
- Automatic retry.
- Existing-instance detection.
- Local execution state.
- Per-attempt infrastructure logs.
- JSON output mode.

---

# 5. Networking / VCN UX

Networking must be an explicit step in the deployment flow.

The user must be able to choose:

```text
? Network configuration

❯ Use an existing VCN
  Create a new VCN
```

## Existing VCN

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

## Create new VCN

The CLI should ask only for the minimum required configuration.

Example:

```text
? VCN name
› oci-vm-vcn

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

# 6. CPU Architecture

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

# 7. Compute Configuration

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

# 8. Disk Storage

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

# 9. Existing Instance Storage Warning

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

# 10. OCI Authentication

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

If OCI configuration is unavailable:

```text
✗ OCI configuration not found.

Configure OCI first:

  oci setup config

Then run:

  bunx oci-vm
```

The CLI must never persist:

- OCI private keys;
- API secrets;
- passwords;
- authentication tokens.

---

# 11. YAML Configuration File

The YAML file is **not a database**.

Its purpose is:

1. Persist the configuration from the user's most recent CLI execution.
2. Store successful deployment state.
3. Store the most recent deployment error.
4. Allow users to manually provide default values.

Default filename:

```text
oci-vm.yaml
```

Optional:

```bash
oci-vm --config ./my-config.yaml
```

---

# 12. YAML Semantics

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
  last_deployment:
    status: succeeded
    instance_id: ocid1.instance...
    availability_domain: AD-1
    timestamp: "2026-10-05T18:32:00Z"

last_error:
  timestamp: "2026-10-05T18:10:00Z"
  code: OUT_OF_CAPACITY
  message: "Out of capacity"
```

The exact YAML structure may be simplified during implementation as long as these semantics remain.

---

# 13. YAML Persistence Rules

After a successful deployment:

- Persist the successful deployment state.
- Persist the selected configuration as defaults.

Example:

```text
✓ Deployment successful

Configuration saved to:
  ./oci-vm.yaml
```

If deployment fails:

- Update `last_error`.
- Preserve the configuration.
- Do not overwrite a previously successful deployment state unless appropriate.

The YAML must remain human-readable and manually editable.

The CLI must not write secrets to it.

---

# 14. Configuration Precedence

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
oci-vm --name my-vm
```

overrides:

```yaml
defaults:
  instance:
    name: another-vm
```

Interactive prompts should only ask for values that remain unresolved.

---

# 15. Deployment Summary

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

# 16. Deployment UX

After confirmation:

```text
Starting deployment...

✓ Configuration validated
✓ OCI connection verified
✓ Network ready
✓ Found 3 Availability Domains

Trying AD-1...
```

On success:

```text
✓ Instance created

Deployment successful

  Instance:       devbox
  Instance OCID:  ocid1.instance...
  Architecture:   ARM64
  Shape:           VM.Standard.A1.Flex
  AD:              AD-1
```

---

# 17. Retry Engine

Automatic retry is the core feature.

The CLI must:

1. Discover all available Availability Domains.
2. Attempt deployment.
3. Detect capacity-related failures.
4. Try another Availability Domain.
5. Wait between retry cycles.
6. Check whether the instance already exists.
7. Continue until success or explicit cancellation.

Default retry interval:

```yaml
defaults:
  retry:
    interval_seconds: 900
```

Equivalent to 15 minutes.

The interval must be configurable.

---

# 18. Retry UX

Example:

```text
Starting deployment...

✓ Found 3 Availability Domains

AD-1
✗ Out of capacity

AD-2
✗ Out of capacity

AD-3
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

# 19. Per-Attempt Infrastructure Logs

Every infrastructure deployment attempt must produce a log file.

Create a local directory:

```text
oci-vm-logs/
```

Each attempt receives its own log file.

Example:

```text
oci-vm-logs/
├── 2026-10-05T183000Z-ad-1.log
├── 2026-10-05T184500Z-ad-2.log
└── 2026-10-05T190000Z-ad-3.log
```

The log must contain enough information to troubleshoot the infrastructure attempt.

Example:

```text
Timestamp: 2026-10-05T18:30:00Z
Attempt: 1
Availability Domain: AD-1
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

Logs must **never contain private keys, authentication tokens, passwords, or other secrets**.

---

# 20. Log Naming

Log filenames must be:

- deterministic enough to identify the attempt;
- filesystem-safe;
- valid on macOS, Linux, and Windows.

Recommended format:

```text
YYYY-MM-DDTHH-mm-ss-SSSZ-<attempt>.log
```

Avoid `:` in filenames because Windows does not allow it.

Example:

```text
2026-10-05T18-30-00-000Z-attempt-001.log
```

---

# 21. Successful Deployment State

When deployment succeeds, persist at least:

```yaml
state:
  last_deployment:
    status: succeeded
    timestamp: "..."
    instance_id: "..."
    instance_name: "..."
    availability_domain: "..."
    architecture: arm64
    shape: "..."
    disk_gbs: 250
```

This lets a subsequent CLI execution understand the last successful deployment.

---

# 22. Idempotency

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

# 23. Error Classification

At minimum classify:

### Retryable

- Out of capacity.
- Temporary OCI service failures.
- Transient network errors.

### Non-retryable

- Authorization failure.
- Invalid configuration.
- Invalid OCID.
- Missing resource.
- Unsupported shape/image combination.
- Invalid compartment.
- Invalid networking configuration.

Example:

```text
✗ Deployment failed

Reason:
  Authorization failed

This error is not retryable.

Check your OCI permissions and configuration.
```

---

# 24. Ctrl+C

Ctrl+C must terminate gracefully.

Example:

```text
^C

Deployment stopped.

No resources were deleted.

Last state saved to:
  ./oci-vm.yaml

Last attempt log:
  ./oci-vm-logs/2026-10-05T18-30-00-000Z-attempt-003.log
```

The CLI must never automatically destroy resources when the user cancels.

---

# 26. Exit Codes

```text
0   Success
1   Deployment failure
2   Invalid configuration
3   Authentication/authorization failure
4   User cancelled
5   Unexpected error
```

---

# 27. Project Structure

The MVP must intentionally remain extremely small.

```text
oci-vm/
├── src/
│   └── index.ts
├── oci-vm.yaml
├── package.json
├── tsconfig.json
├── README.md
└── .github/
    └── workflows/
        └── publish.yml
```

The application logic must live in:

```text
src/index.ts
```

There must be no multi-file application architecture in the MVP.

The single TypeScript file contains:

- CLI parsing;
- YAML handling;
- OCI client;
- authentication;
- discovery;
- networking;
- compute;
- validation;
- storage calculation;
- deployment;
- retry;
- logging;
- terminal UX;
- JSON output.

---

# 28. Runtime

The package must be compatible with:

- Node.js;
- Bun.

Users should be able to run:

```bash
npx oci-vm
```

and:

```bash
bunx oci-vm
```

The package must not require a globally installed CLI.

Optional global installation:

```bash
npm install -g oci-vm
```

must also work.

---

# 29. Platform Support

Target platforms:

### macOS

- Apple Silicon.
- Intel.

### Linux

- x64.
- ARM64 where supported by dependencies.

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

All filesystem operations must use Node/Bun APIs.

---

# 30. Security

The application is local-first.

It must never send credentials to a product-owned backend.

Never persist:

- private keys;
- authentication tokens;
- passwords;
- secrets.

Never write credentials into:

```text
oci-vm.yaml
oci-vm-logs/
stdout
stderr
JSON output
```

Logs must sanitize OCI API errors if they contain potentially sensitive information.

No telemetry is enabled by default.

---

# 31. Package Metadata

The package should expose:

```json
{
  "name": "oci-vm",
  "version": "0.1.0",
  "bin": {
    "oci-vm": "./dist/index.js"
  }
}
```

The final npm package name must be verified for availability before the first release.

---

# 32. GitHub Repository

Use a simple GitHub workflow:

```text
feature branch
      ↓
Pull Request
      ↓
main
```

No GitFlow.

The repository is the source of truth.

---

# 33. GitHub Actions

Create:

```text
.github/workflows/publish.yml
```

The workflow must:

1. Checkout repository.
2. Install Node.js.
3. Install dependencies.
4. Typecheck.
5. Build.
6. Run tests.
7. Publish to npm.

Publishing should occur only from the trusted `main` branch through an explicit release/tag process.

Use npm's supported trusted publishing mechanism where possible instead of a long-lived npm token.

---

# 34. Release Process

Use Semantic Versioning:

```text
0.1.0
0.1.1
0.2.0
1.0.0
```

Initial release:

```text
0.1.0
```

The release process should be explicit and reproducible.

Example:

```text
Developer
   │
   ▼
git tag v0.1.0
   │
   ▼
GitHub
   │
   ▼
GitHub Actions
   │
   ├── test
   ├── build
   └── npm publish
```

---

# 35. npm / Bun Distribution

npm is the package registry.

Bun does not require a separate publishing pipeline.

The same package must work with:

```bash
npx oci-vm
```

and:

```bash
bunx oci-vm
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
   ├── npx oci-vm
   └── bunx oci-vm
```

---

# 36. README

The README should be concise.

Opening:

```text
# OCI VM Deployer

Deploy an OCI VM and automatically retry when capacity is unavailable.
```

Installation:

```bash
npx oci-vm
```

or:

```bash
bunx oci-vm
```

Requirements:

```text
- Node.js or Bun
- OCI CLI/configuration
- Permissions to create OCI instances
```

Basic setup:

```bash
oci setup config
bunx oci-vm
```

Then document:

- VCN selection/creation;
- architecture selection;
- disk configuration;
- YAML defaults/state;
- retry behavior;
- logs;
- troubleshooting.

---

# 37. Acceptance Criteria

The MVP is complete when a developer can:

1. Install Node.js or Bun.
2. Configure OCI locally.
3. Run:

```bash
bunx oci-vm
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
28. Run the package with both `npx` and `bunx`.
29. Publish the package automatically through GitHub Actions.
30. Never send OCI credentials to an external backend.

---

# 38. Explicit Non-Goals

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
- Daemon/background service.

---

# 39. Core Product Principle

> **Boring infrastructure, excellent CLI UX.**

The implementation should remain small enough that a developer can read the entire application source and understand the provisioning flow.

The MVP is intentionally:

```text
One TypeScript file
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
TypeScript single-file CLI
    ↓
npm
    ↓
npx / bunx
    ↓
OCI VM deployment
    ↓
Automatic capacity retry
    ↓
Local state + per-attempt logs
```