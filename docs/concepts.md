# Core concepts

`oci-free-vm` does one job: it keeps asking OCI for a free-tier VM until a launch succeeds. This page explains what that involves — the credentials it needs, the OCI API operations it calls, how retries cycle through Availability Domains, how failures are classified, and what gets written to disk. Flags and exit codes are in [the CLI reference](cli.md); the state file's fields are in [the configuration file](configuration.md).

## Authentication

The CLI signs OCI requests with an API key, locally:

- **Config file:** `~/.oci/config`, overridable with the `OCI_CONFIG_FILE` environment variable. The profile comes from `--profile`, then `OCI_CONFIG_PROFILE`, then `DEFAULT`; if the named profile section does not exist, the `DEFAULT` section is used.
- **Required profile keys:** `user`, `tenancy`, `fingerprint`, `region`, and `key_file`. `pass_phrase` is read when present.
- **Private key:** the file `key_file` points to must be readable and contain a valid PEM RSA key. A missing config file, missing profile, missing key entry, unreadable key, or malformed PEM stops the run before any API call, with exit code 3. An interactive run instead offers to create `~/.oci/config` and `~/.oci/oci_api_key.pem` for you.
- **API keys only:** session-token profiles (`oci session authenticate`) are not supported; every request is signed with the API key.

The Identity, Compute, Virtual Network, and Block Storage clients are all built from the same credentials.

## OCI API operations

| Operation | Service | Used for |
| --- | --- | --- |
| `ListCompartments` | Identity | The compartment picker in interactive runs |
| `ListAvailabilityDomains` | Identity | AD discovery for the plan, per-AD shape lookups, the storage scan, and the retry target list |
| `ListVcns`, `ListSubnets` | Virtual Network | Selecting and verifying an existing network |
| `ListShapes` | Compute | Shapes offered for the architecture, and whether the chosen shape exists in each AD |
| `ListImages` | Compute | The newest Canonical Ubuntu image for the chosen shape |
| `ListInstances` | Compute | Existing-instance detection by name, checked before every retry cycle |
| `ListBootVolumes` | Block Storage | Existing boot-volume sizes for the storage warning |
| `LaunchInstance` | Compute | The deployment itself — one call per attempt |
| `CreateVcn`, `CreateInternetGateway`, `UpdateRouteTable`, `GetSecurityList`, `UpdateSecurityList`, `CreateSubnet` | Virtual Network | Only with `--network-mode create`: a VCN with an internet gateway, a default route to it, a TCP/22 ingress rule, and a subnet |

Setup reads that can flake — plan loading, AD listing, network preparation, AD resolution — get up to three attempts, waiting 2 seconds then 4 seconds, before the run gives up. Only failures classified as retryable (below) get those attempts.

## How retries cycle through Availability Domains

The retry engine runs until an instance exists, you press Ctrl+C, or a non-retryable failure occurs. Each pass through the cycle:

1. **Check whether the instance already exists.** `ListInstances` is filtered by the chosen name; a live instance with that name ends the run as "already exists" (exit 0).
2. **Resolve the AD target list.** Every AD in the compartment is considered. An AD is skipped when the shape is not offered there, when its shape list cannot be read, or when no subnet in the VCN is usable in it — each skip is reported with its reason. If nothing qualifies, the CLI fails open and tries every AD (or the single AD the chosen subnet belongs to) rather than none. Targets run highest-numbered first: AD-3 → AD-2 → AD-1; unknown names keep the order the API returned.
3. **Try each target once.** Each try increments the cumulative attempt counter, calls `LaunchInstance`, and appends a `SUCCEEDED` or `FAILED` block to the attempt log. A retryable failure — a capacity error, for example — moves on to the next AD; a non-retryable failure ends the run immediately with its classified exit code.
4. **When every target has been tried**, the run records `last_error`, prints the last error and the next retry time, waits `retry.interval_seconds` (default: 900 seconds, 15 minutes; set with `--delay`), and starts again from step 1. There is no attempt limit.

Regions that expose a single AD repeat there — the CLI warns about that before deploying. Ctrl+C stops the loop and deletes nothing.

## Failure classification

Every error passes through one classifier that decides whether to keep trying:

| The error is | Kind | Retryable | Code | Exit |
| --- | --- | --- | --- | --- |
| An OCI service error whose code or message says "out of capacity" or "out of host capacity" | `capacity` | yes | `OUT_OF_CAPACITY` | 1 |
| HTTP 429 (rate limit) or any 5xx | `transient` | yes | `TRANSIENT` | 1 |
| A network failure (refused/reset connections, timeouts, DNS) or the OCI SDK's transport giving up | `transient` | yes | `TRANSIENT` | 1 |
| HTTP 401 or 403, or the service code `NotAuthorizedOrNotFound` | `auth` | no | `AUTH` | 3 |
| A local configuration problem or HTTP 400 | `invalid` | no | `CONFIG` | 2 |
| A local file error (disk full, permissions, open-file limits) | `local` | no | `LOCAL` | 5 |
| Any other HTTP error from OCI | `fatal` | no | `DEPLOY` | 1 |
| Anything unrecognised | `fatal` | no | `UNEXPECTED` | 5 |

Retryable kinds (`capacity`, `transient`) drive the cycle above. Everything else stops the run and prints what to do next — fix the configuration, check the IAM policy, free disk space. In `--json` mode the same `code` and `message` appear in the `error` object.

## State, last_error, and logs

Persistence is local and best-effort: if a write fails, the CLI warns and the run continues.

**The config file** (`~/.oci/oci-free-vm.yaml`, or `--config <path>`) is updated at four points:

- **After AD discovery** — `state.availability_domains` stores the full AD list the region exposed.
- **After every failed cycle** — `last_error` records `{ timestamp, code, message }` for the failure that ended the cycle, and `defaults` is refreshed with the plan that was used (region, architecture, compartment, network OCIDs, instance settings, SSH key, retry interval).
- **On success** — `state.last_deployment` records the status, timestamp, instance OCID and name, AD, architecture, shape, disk/OCPUs/memory, public-IP setting, and the VCN/subnet OCIDs; `defaults` is refreshed and the previous `last_error` is kept.
- **On a non-retryable failure or Ctrl+C** — `defaults` and `state` are saved and `last_error` is overwritten with the failure (Ctrl+C keeps the previous `last_error` instead, and deletes nothing; cancelling during the prompts writes nothing).

Each field is documented in [the configuration file](configuration.md).

**The attempt log** (`~/.oci/oci-free-vm-logs/oci-free-vm.log`) receives one block per `LaunchInstance` attempt: timestamp, attempt number, AD, instance, architecture, shape, OCPUs, memory, disk, operation, result, and — for failures — the classified error code and message. Blocks are separated by a line of `=` characters, and key material, request signatures, and passphrases are redacted before anything is written.
