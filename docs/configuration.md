# The `oci-free-vm.yaml` file

The CLI remembers what it needs in `~/.oci/oci-free-vm.yaml`. Override the location with `--config <path>`. The file is memory, not a database: it stores your last-used `defaults`, the discovered Availability Domains and last successful deployment under `state`, and the most recent failure under `last_error`.

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
  last_deployment:
    status: succeeded
    instance_id: ocid1.instance...
    availability_domain: fNXZ:US-ASHBURN-AD-1

last_error:
  timestamp: "2026-10-05T18:10:00Z"
  code: OUT_OF_CAPACITY
  message: "Out of capacity"
```

- `defaults` — the last-used configuration, and the values a later run uses when no flag overrides them.
- `state.availability_domains` — every Availability Domain the region exposed when the CLI last checked.
- `state.last_deployment` — the last successful deployment, including the instance OCID and its AD.
- `last_error` — the most recent failure code and message.

The file is created on the first run and stays human-readable and editable. Secrets are never written to it.
