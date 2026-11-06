# oci-free-vm

**A free-tier OCI VM, without the console-refresh marathon.**

Oracle Cloud's Always Free ARM capacity is scarce. Launch requests come back with *"Out of capacity"* for hours or days, and retrying by hand is a chore. `oci-free-vm` is one command that does the waiting: it reads your OCI config, walks through the deploy, and keeps retrying until the VM exists or you stop it.

Your credentials stay on your machine. There is no backend and nothing to sign up for. It runs on Windows, macOS, and Linux.

## Run it

```bash
npx oci-free-vm
```

You need **Node.js 22.23.4+, 24.22.1+, or 26.12.1+** — the first releases of each line patched for [CVE-2026-111497](https://nvd.nist.gov/vuln/detail/CVE-2026-111497), a high-severity Brotli decoder flaw. Node 20 is end-of-life with no patched release. npm only warns (`EBADENGINE`), so an older Node may still run the CLI; upgrade instead.

That is the whole setup. Answer the prompts, or pass flags — see [CLI options](docs/cli.md) for the non-interactive form.

<details>
<summary><strong>First time with OCI? Create <code>~/.oci/config</code></strong></summary>

`oci-free-vm` signs requests with an API key. Pick one path:

- **`oci setup config` (recommended).** Install the [Oracle Cloud CLI](https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm), then run `oci setup config`. It generates the key pair, registers it with your user, and writes the config file.
- **The OCI Console.** Open **My profile → API keys → Add API key**, generate a key pair, download the private key, and paste the configuration snippet into `~/.oci/config`. Oracle's walkthrough: [API signing keys](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm).
- **`oci session authenticate` is not supported.** Session profiles use tokens; this CLI signs with API keys only.

</details>

## Why oci-free-vm

**Capacity is temporary. The retry is not.** A full Availability Domain is not an error you should have to babysit. The CLI records the attempt, waits, and tries again on a schedule you control.

**It tries every AD the region offers, highest first.** Within each cycle it starts at the highest-numbered AD and works down (AD-3 → AD-2 → AD-1). If an AD is skipped, it tells you why.

**Your credentials stay local.** The CLI reads `~/.oci/config` and signs OCI requests itself. Nothing is sent to a third-party service.

**Interactive or scripted.** Prompts walk through the deploy; `--json --yes` turns the same command into something a script can call.

**Boring where it matters.** It checks for an existing instance by name before every cycle, writes one log per attempt, and exits with meaningful codes.

## How retries work

It reads `~/.oci/config`, asks only for unresolved values, shows a plan, and creates the instance. Before every cycle it checks whether an instance with that name already exists.

- **Order:** AD-3 → AD-2 → AD-1. Skipped ADs are reported with a reason.
- **Retried:** capacity, rate limits (429), transient 5xx, and network failures. **Not retried:** authorization and invalid configuration.
- **Single-AD regions:** some regions expose one AD. Retries repeat there; check with `oci iam availability-domain list`.
- **Stopping:** Ctrl+C deletes nothing, and the last state is saved.

## Configuration

Values resolve as **flags > YAML > prompts > defaults**. The YAML file stores your defaults, discovered ADs, and last error — see [the configuration file](docs/configuration.md). Flags and exit codes live in the [CLI reference](docs/cli.md).

## Logs

Every attempt writes its own file under `~/.oci/oci-free-vm-logs/`. No private keys or signatures are written.

## Troubleshooting

- **`oci-free-vm needs an interactive terminal`** — run it in a terminal (with Docker, add `-it`), or use `--json`.
- **`OCI configuration not found`** — create `~/.oci/config` with `oci setup config` or the Console path above.
- **`Authorization failed or requested resource not found`** — check the compartment OCID and the user's IAM policy.
- **Only one AD is tried** — the region may expose just one. Verify with `oci iam availability-domain list`.
- **Old behavior** — `npx` caches packages; run `npm cache clean --force`. A local build needs `npm run build`.
- **`ENOSPC` or `EACCES`** — free disk space or fix permissions for `~/.oci` and `~/.ssh`. Log and state write failures are warnings; the retry loop continues.

## Docs

- [CLI options and exit codes](docs/cli.md)
- [Configuration file](docs/configuration.md)
- [Development and releases](docs/development.md)
- [Changelog](CHANGELOG.md)

## Run it with Docker

```bash
docker run --rm -it \
  -v ~/.oci:/home/node/.oci \
  -v ~/.ssh:/home/node/.ssh \
  ghcr.io/yokharian/oracle-free-tier-retrier:latest
```

The mounts matter: `~/.oci` gives the CLI your credentials and a place to keep `oci-free-vm.yaml` and its logs; `~/.ssh` lets it use or generate your key pair. On Windows PowerShell, write `~` as `${HOME}`.

For scripts, add `--json --yes` and pass `--compartment-id`, `--vcn-id`, `--subnet-id`, `--name`, and `--disk` on that same command. Compose users can run `docker compose run --rm oci-free-vm`. If a pull is denied, sign in with a GitHub token that has `read:packages`; build locally with `docker build -t oci-free-vm .`.

## License

MIT.
