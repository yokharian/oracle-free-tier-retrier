#!/usr/bin/env python3
"""
OCI VM Instance Generator - Deploy VMs on Oracle Cloud Infrastructure.
Two deployment methods: Terraform via Resource Manager or OCI SDK directly.
"""

import base64
import configparser
import io
import os
import re
import sys
import time
import zipfile
from datetime import datetime
from pathlib import Path

import click
import oci

# --- Colors ---
GREEN = "\033[0;32m"
YELLOW = "\033[1;33m"
RED = "\033[0;31m"
CYAN = "\033[0;36m"
NC = "\033[0m"


def log_info(msg):
    click.echo(f"{GREEN}{msg}{NC}")


def log_warn(msg):
    click.echo(f"{YELLOW}{msg}{NC}")


def log_error(msg):
    click.echo(f"{RED}{msg}{NC}")


# --- Config Parsing ---
SCRIPT_DIR = Path(__file__).parent.resolve()
TFVARS_FILE = SCRIPT_DIR / "terraform.tfvars"
ENV_FILE = SCRIPT_DIR / ".env"
SLEEP_SECONDS = 900


def parse_tfvar(key, tfvars_path=TFVARS_FILE):
    """Parse a single key from terraform.tfvars."""
    if not tfvars_path.exists():
        log_error(f"Error: {tfvars_path} not found")
        sys.exit(1)
    content = tfvars_path.read_text()
    pattern = rf'^{key}\s*=\s*"([^"]*)"'
    match = re.search(pattern, content, re.MULTILINE)
    if match:
        return match.group(1)
    pattern_unquoted = rf'^{key}\s*=\s*(\S+)'
    match = re.search(pattern_unquoted, content, re.MULTILINE)
    if match:
        return match.group(1)
    return None


def load_tfvars():
    """Load all variables from terraform.tfvars."""
    log_warn("Loading terraform.tfvars...")
    keys = [
        "region", "compartment_id", "availability_domain", "instance_name",
        "instance_shape", "instance_ocpus", "instance_memory_gbs",
        "instance_image_id", "assign_public_ip", "vcn_cidr", "subnet_cidr",
        "dns_label", "ssh_public_key",
    ]
    config = {}
    for key in keys:
        val = parse_tfvar(key)
        if val is not None:
            if key in ("instance_ocpus", "instance_memory_gbs"):
                config[key] = float(val)
            elif key == "assign_public_ip":
                config[key] = val.lower() == "true"
            else:
                config[key] = val
    log_info("Variables loaded")
    return config


def load_env():
    """Load stack OCIDs from .env file."""
    env = {}
    if ENV_FILE.exists():
        log_warn("Loading .env...")
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
        if env.get("OCI_NETWORKING_STACK_ID"):
            log_info(f"Networking stack OCID: {env['OCI_NETWORKING_STACK_ID']}")
        if env.get("OCI_COMPUTE_STACK_ID"):
            log_info(f"Compute stack OCID: {env['OCI_COMPUTE_STACK_ID']}")
    return env


def save_env(env):
    """Save stack OCIDs to .env file."""
    lines = [
        "# Optional: Pre-existing Resource Manager stack OCIDs",
        "# Leave empty to create new stacks",
        "",
        f"OCI_NETWORKING_STACK_ID={env.get('OCI_NETWORKING_STACK_ID', '')}",
        f"OCI_COMPUTE_STACK_ID={env.get('OCI_COMPUTE_STACK_ID', '')}",
    ]
    ENV_FILE.write_text("\n".join(lines) + "\n")
    log_info("Stack OCIDs saved to .env")


def validate_compartment_id(cid):
    if not cid:
        log_error("Error: compartment_id is empty")
        sys.exit(1)
    if not (cid.startswith("ocid1.compartment.") or cid.startswith("ocid1.tenancy.")):
        log_error(f"Error: compartment_id does not look valid: {cid}")
        sys.exit(1)


# --- OCI SDK Clients ---
def get_config():
    """Load OCI config from ~/.oci/config."""
    try:
        return oci.config.from_file()
    except Exception as e:
        log_error(f"Error: OCI CLI is not properly configured. Run 'oci setup config' first.")
        log_error(f"Details: {e}")
        sys.exit(1)


def get_clients():
    """Initialize all OCI SDK clients."""
    config = get_config()
    identity = oci.identity.IdentityClient(config)
    compute = oci.core.ComputeClient(config)
    compute_composite = oci.core.ComputeClientCompositeOperations(compute)
    vnet = oci.core.VirtualNetworkClient(config)
    vnet_composite = oci.core.VirtualNetworkClientCompositeOperations(vnet)
    rm = oci.resource_manager.ResourceManagerClient(config)
    rm_composite = oci.resource_manager.ResourceManagerClientCompositeOperations(rm)
    return config, identity, compute, compute_composite, vnet, vnet_composite, rm, rm_composite


# --- Option 1: Resource Manager ---
def zip_module(module_dir):
    """Zip a Terraform module directory."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in Path(module_dir).rglob("*"):
            if f.is_file():
                zf.write(f, f.relative_to(module_dir))
    buf.seek(0)
    return buf.getvalue()


def create_rm_stack(rm, compartment_id, display_name, description, zip_bytes, variables=None):
    """Create a Resource Manager stack from a zip."""
    config_source = oci.resource_manager.models.CreateZipUploadConfigSourceDetails(
        zip_file_base64_encoded=base64.b64encode(zip_bytes).decode(),
        config_source_type="ZIP_UPLOAD",
    )
    details = oci.resource_manager.models.CreateStackDetails(
        compartment_id=compartment_id,
        display_name=display_name,
        description=description,
        config_source=config_source,
        variables=variables or {},
    )
    response = rm.create_stack(create_stack_details=details)
    return response.data.id


def update_stack_variables(rm, stack_id, variables):
    """Update variables on an existing stack."""
    rm.update_stack(
        stack_id=stack_id,
        update_stack_details=oci.resource_manager.models.UpdateStackDetails(
            variables=variables,
        ),
    )


def apply_stack(rm, stack_id):
    """Create and return an apply job."""
    details = oci.resource_manager.models.CreateApplyJobOperationDetails(
        execution_plan_strategy="AUTO_APPROVED",
    )
    response = rm.create_job(
        stack_id=stack_id,
        create_job_details=oci.resource_manager.models.CreateJobDetails(
            job_operation_details=details,
        ),
    )
    return response.data.id


def wait_for_job(rm, stack_id, timeout=3600, interval=30):
    """Wait for the latest job on a stack to complete."""
    start = time.time()
    while time.time() - start < timeout:
        response = rm.list_jobs(
            stack_id=stack_id,
            sort_by="TIMECREATED",
            sort_order="DESC",
            limit=1,
        )
        if not response.data:
            click.echo("  State: none")
            time.sleep(interval)
            continue
        job = response.data[0]
        state = job.lifecycle_state
        click.echo(f"  State: {state}")
        if state == "SUCCEEDED":
            return True
        if state in ("FAILED", "CANCELLED"):
            return False
        time.sleep(interval)
    log_error("Timeout waiting for job.")
    return False


def cancel_active_job(rm, stack_id):
    """Cancel any in-progress job on a stack."""
    response = rm.list_jobs(
        stack_id=stack_id,
        sort_by="TIMECREATED",
        sort_order="DESC",
        limit=1,
    )
    if response.data:
        job = response.data[0]
        if job.lifecycle_state in ("ACCEPTED", "IN_PROGRESS", "CANCELING"):
            log_warn(f"  Cancelling job {job.id}")
            try:
                rm.cancel_job(job_id=job.id)
            except Exception:
                pass


def get_stack_outputs(rm, stack_id):
    """Get terraform outputs from a stack."""
    try:
        response = rm.get_stack(stack_id=stack_id)
        outputs = response.data.terraform_state.outputs if response.data.terraform_state else {}
        return outputs
    except Exception:
        return {}


def deploy_networking_stack(rm, compartment_id, tfvars, existing_id=None):
    """Deploy networking via Resource Manager."""
    if existing_id:
        log_warn(f"Using existing networking stack: {existing_id}")
        return existing_id

    log_warn("Creating new networking stack...")
    tfvars_path = SCRIPT_DIR / "networking" / "terraform.tfvars"
    lines = []
    for key in ("region", "compartment_id", "vcn_cidr", "subnet_cidr", "dns_label"):
        val = tfvars.get(key)
        if val is not None:
            lines.append(f'{key} = "{val}"')
    tfvars_path.write_text("\n".join(lines) + "\n")

    zip_bytes = zip_module(SCRIPT_DIR / "networking")
    stack_id = create_rm_stack(
        rm, compartment_id, "networking-stack",
        "VCN, subnet, IGW, route table", zip_bytes,
    )
    log_info(f"  Stack created: {stack_id}")

    log_warn("Applying networking stack...")
    apply_stack(rm, stack_id)
    if not wait_for_job(rm, stack_id):
        log_error("Networking stack failed.")
        sys.exit(1)
    log_info("  Networking applied successfully.")
    return stack_id


def deploy_compute_stack(rm, compartment_id, tfvars, net_stack_id, existing_id=None):
    """Deploy compute via Resource Manager."""
    if existing_id:
        log_warn(f"Using existing compute stack: {existing_id}")
        return existing_id

    log_warn("Fetching networking outputs...")
    outputs = get_stack_outputs(rm, net_stack_id)
    subnet_name = None
    for key, val in outputs.items():
        if key == "subnet_display_name":
            subnet_name = val.value if hasattr(val, "value") else val
            break
    if not subnet_name:
        log_error("ERROR: Could not get subnet_display_name from networking outputs.")
        sys.exit(1)
    log_info(f"  Subnet: {subnet_name}")

    tfvars_path = SCRIPT_DIR / "compute" / "terraform.tfvars"
    lines = []
    for key, val in tfvars.items():
        if key == "assign_public_ip":
            lines.append(f'{key} = {"true" if val else "false"}')
        elif key in ("instance_ocpus", "instance_memory_gbs"):
            lines.append(f'{key} = {val}')
        elif val is not None:
            lines.append(f'{key} = "{val}"')
    lines.append(f'subnet_display_name = "{subnet_name}"')
    tfvars_path.write_text("\n".join(lines) + "\n")

    zip_bytes = zip_module(SCRIPT_DIR / "compute")
    variables = {"subnet_display_name": subnet_name}
    stack_id = create_rm_stack(
        rm, compartment_id, "compute-stack",
        "Compute instance with AD retry", zip_bytes, variables,
    )
    log_info(f"  Stack created: {stack_id}")
    return stack_id


def instance_exists(compute, compartment_id, display_name):
    """Check if a VM with the given name exists in a running state."""
    try:
        response = compute.list_instances(
            compartment_id=compartment_id,
            display_name=display_name,
        )
        running_states = {"PROVISIONING", "STARTING", "RUNNING", "STOPPING", "STOPPED"}
        for inst in response.data:
            if inst.lifecycle_state in running_states:
                return True
        return False
    except Exception:
        return False


def retry_compute_loop(rm, compute, compartment_id, compute_stack_id, ads, tfvars):
    """Retry compute stack across all ADs until VM is created."""
    instance_name = tfvars.get("instance_name", "vm")
    click.echo("")
    click.echo(f"{CYAN}=== Compute retry loop ==={NC}")
    click.echo(f"Stack: {compute_stack_id}")
    click.echo(f"VM: {instance_name}")
    click.echo("")

    while True:
        click.echo(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Checking if VM exists...")
        if instance_exists(compute, compartment_id, instance_name):
            log_info(f"VM '{instance_name}' already exists. Done.")
            return

        # Check current job state
        response = rm.list_jobs(
            stack_id=compute_stack_id,
            sort_by="TIMECREATED",
            sort_order="DESC",
            limit=1,
        )
        state = response.data[0].lifecycle_state if response.data else "none"
        click.echo(f"Last job state: {state}")

        if state in ("ACCEPTED", "IN_PROGRESS", "CANCELING"):
            click.echo(f"Job in progress. Waiting {SLEEP_SECONDS}s.")
            time.sleep(SLEEP_SECONDS)
            continue

        # Try each AD
        for ad in ads:
            click.echo("")
            click.echo(f"Trying availability_domain={ad}")
            update_stack_variables(rm, compute_stack_id, {"availability_domain": ad})

            try:
                apply_stack(rm, compute_stack_id)
            except Exception as e:
                log_warn(f"Apply failed for {ad}: {e}")
                continue

            if instance_exists(compute, compartment_id, instance_name):
                log_info(f"VM '{instance_name}' was created. Done.")
                return

            click.echo(f"  Apply sent for {ad}. Waiting {SLEEP_SECONDS}s...")
            time.sleep(SLEEP_SECONDS)
            if instance_exists(compute, compartment_id, instance_name):
                log_info(f"VM '{instance_name}' exists after applying {ad}.")
                return

        click.echo(f"No AD succeeded. Waiting {SLEEP_SECONDS}s before retry cycle.")
        time.sleep(SLEEP_SECONDS)


@click.command()
@click.option("--net-stack-id", help="Existing networking stack OCID")
@click.option("--comp-stack-id", help="Existing compute stack OCID")
def terraform(net_stack_id, comp_stack_id):
    """Deploy using Terraform (Resource Manager)."""
    tfvars = load_tfvars()
    env = load_env()
    click.echo("")

    compartment_id = tfvars.get("compartment_id")
    validate_compartment_id(compartment_id)

    _, identity, compute, _, _, _, rm, _ = get_clients()

    # Get ADs
    log_warn("Fetching all Availability Domains...")
    ads_response = identity.list_availability_domains(compartment_id=compartment_id)
    ads = [ad.name for ad in ads_response.data]
    if not ads:
        log_error("Error: No Availability Domains found.")
        sys.exit(1)
    log_info(f"Found {len(ads)} Availability Domain(s)")

    # Networking
    click.echo(f"{CYAN}=== Networking Stack ==={NC}")
    existing_net = net_stack_id or env.get("OCI_NETWORKING_STACK_ID")
    net_id = deploy_networking_stack(rm, compartment_id, tfvars, existing_net)

    click.echo("")

    # Compute
    click.echo(f"{CYAN}=== Compute Stack ==={NC}")
    existing_comp = comp_stack_id or env.get("OCI_COMPUTE_STACK_ID")
    comp_id = deploy_compute_stack(rm, compartment_id, tfvars, net_id, existing_comp)

    click.echo("")
    click.echo(f"{CYAN}=== Stack IDs ==={NC}")
    click.echo(f"  Networking: {net_id}")
    click.echo(f"  Compute:    {comp_id}")
    click.echo("\nStack OCIDs saved to .env for subsequent runs.")
    click.echo("")

    save_env({"OCI_NETWORKING_STACK_ID": net_id, "OCI_COMPUTE_STACK_ID": comp_id})

    retry_compute_loop(rm, compute, compartment_id, comp_id, ads, tfvars)


# --- Option 2: Direct OCI SDK ---
def prompt_compartment(identity):
    """Interactively select a compartment."""
    log_warn("Fetching compartments...")
    try:
        compartments = identity.list_compartments(
            compartment_id_in_subtree=True,
        ).data
    except Exception:
        compartments = []

    if not compartments:
        log_warn("No child compartments found. Using tenancy root as compartment.")
        oci_cfg = configparser.ConfigParser()
        oci_cfg.read(os.path.expanduser("~/.oci/config"))
        cid = oci_cfg.get("DEFAULT", "tenancy", fallback="")
        if not cid:
            log_error("Could not find tenancy OCID in ~/.oci/config")
            sys.exit(1)
        return cid, "Root (Tenancy)"

    click.echo("")
    click.echo("Available compartments:")
    for i, c in enumerate(compartments, 1):
        click.echo(f"{i}) {c.name} [{c.id}]")

    choice = click.prompt(f"Select compartment number (1-{len(compartments)})", type=int)
    c = compartments[choice - 1]
    log_info(f"Selected: {c.name}")
    click.echo("")
    return c.id, c.name


def prompt_subnet(vnet, compartment_id):
    """Interactively select a subnet, or create one if none exist."""
    log_warn("Fetching subnets in compartment...")
    subnets = vnet.list_subnets(compartment_id=compartment_id).data

    if not subnets:
        click.echo("")
        log_warn("No subnets found in this compartment.")
        deploy = click.confirm("Deploy VCN + subnet using OCI SDK?", default=True)
        if not deploy:
            log_error("Cannot proceed without a subnet.")
            sys.exit(1)
        return deploy_cli_networking(vnet, compartment_id)

    click.echo("")
    click.echo("Available subnets:")
    for i, s in enumerate(subnets, 1):
        name = s.display_name or "(unnamed)"
        cidr = s.cidr_block or s.cidr
        click.echo(f"{i}) {name} - {cidr} [{s.id}]")

    choice = click.prompt(f"Select subnet number (1-{len(subnets)})", type=int)
    s = subnets[choice - 1]
    log_info("Subnet selected")
    click.echo("")
    return s.id


def deploy_cli_networking(vnet_composite, compartment_id):
    """Create VCN + subnet directly via SDK."""
    log_warn("Deploying VCN + subnet using OCI SDK...")
    tfvars = load_tfvars()

    dns_label = tfvars.get("dns_label", "00000000")
    vcn_cidr = tfvars.get("vcn_cidr", "10.0.0.0/16")
    subnet_cidr = tfvars.get("subnet_cidr", "10.0.0.0/24")

    # Create VCN
    log_warn("Creating VCN...")
    vcn_details = oci.core.models.CreateVcnDetails(
        compartment_id=compartment_id,
        cidr_block=vcn_cidr,
        display_name=f"vcn-{dns_label}",
        dns_label=f"vcn{dns_label}",
    )
    vcn_response = vnet_composite.create_vcn_and_wait_for_state(
        vcn_details,
        wait_for_states=[oci.core.models.Vcn.LIFECYCLE_STATE_AVAILABLE],
        waiter_kwargs={"max_wait_seconds": 300, "succeed_on_not_found": False},
    )
    vcn = vcn_response.data
    log_info(f"  VCN created: {vcn.id}")

    # Create subnet
    log_warn("Creating subnet...")
    subnet_details = oci.core.models.CreateSubnetDetails(
        compartment_id=compartment_id,
        vcn_id=vcn.id,
        cidr_block=subnet_cidr,
        display_name=f"subnet-{dns_label}",
        dns_label=f"subnet{dns_label}",
        route_table_id=vcn.default_route_table_id,
    )
    subnet_response = vnet_composite.create_subnet_and_wait_for_state(
        subnet_details,
        wait_for_states=[oci.core.models.Subnet.LIFECYCLE_STATE_AVAILABLE],
        waiter_kwargs={"max_wait_seconds": 300, "succeed_on_not_found": False},
    )
    subnet = subnet_response.data
    log_info(f"  Subnet created: {subnet.id}")

    # Create internet gateway
    log_warn("Creating internet gateway...")
    igw_details = oci.core.models.CreateInternetGatewayDetails(
        compartment_id=compartment_id,
        vcn_id=vcn.id,
        display_name=f"igw-{dns_label}",
        is_enabled=True,
    )
    igw_response = vnet_composite.create_internet_gateway_and_wait_for_state(
        igw_details,
        wait_for_states=[oci.core.models.InternetGateway.LIFECYCLE_STATE_AVAILABLE],
        waiter_kwargs={"max_wait_seconds": 300, "succeed_on_not_found": False},
    )
    log_info(f"  Internet gateway created: {igw_response.data.id}")

    # Update default route table
    log_warn("Updating default route table...")
    vnet_composite.update_route_table_and_wait_for_state(
        vcn.default_route_table_id,
        update_route_table_details=oci.core.models.UpdateRouteTableDetails(
            route_rules=[
                oci.core.models.RouteRule(
                    destination="0.0.0.0/0",
                    destination_type="CIDR_BLOCK",
                    network_entity_id=igw_response.data.id,
                )
            ],
        ),
        wait_for_states=[oci.core.models.RouteTable.LIFECYCLE_STATE_AVAILABLE],
        waiter_kwargs={"max_wait_seconds": 300, "succeed_on_not_found": False},
    )
    log_info("  Route table updated.")

    log_info("Networking applied successfully.")
    click.echo("")
    return subnet.id


def prompt_image(compute, compartment_id):
    """Interactively select an Ubuntu image."""
    log_warn("Fetching Canonical Ubuntu images...")
    images = compute.list_images(
        compartment_id=compartment_id,
        operating_system="Canonical Ubuntu",
        sort_by="TIMECREATED",
        sort_order="DESC",
    ).data

    if not images:
        log_error("Error: No Canonical Ubuntu images found.")
        sys.exit(1)

    click.echo("")
    click.echo("Available Canonical Ubuntu images (showing top 10):")
    for i, img in enumerate(images[:10], 1):
        click.echo(f"{i}) {img.display_name} [{img.id}]")

    choice = click.prompt("Select image number (1-10)", type=int, default=1)
    img = images[choice - 1]
    log_info(f"Selected: {img.display_name}")
    click.echo("")
    return img.id


def prompt_shape_config(tfvars):
    """Prompt for shape configuration with defaults from tfvars."""
    log_warn("Instance Configuration:")
    shape = click.prompt("Shape", default=tfvars.get("instance_shape", "VM.Standard.A1.Flex"))
    ocpus = click.prompt("OCPUs", default=tfvars.get("instance_ocpus", 1), type=float)
    memory = click.prompt("Memory in GBs", default=tfvars.get("instance_memory_gbs", 6), type=float)
    log_info(f"Shape: {shape}, OCPUs: {ocpus}, Memory: {memory}GB")
    click.echo("")
    return shape, ocpus, memory


def prompt_ssh_key(tfvars):
    """Load SSH public key from tfvars or file."""
    ssh_key = tfvars.get("ssh_public_key")
    if ssh_key:
        log_info("SSH key loaded from terraform.tfvars")
        click.echo("")
        return ssh_key

    log_warn("No ssh_public_key in terraform.tfvars.")
    path = click.prompt("Enter SSH public key file path (leave empty to skip)", default="")
    if path and os.path.isfile(path):
        key = Path(path).read_text().strip()
        log_info("SSH key loaded from file")
        click.echo("")
        return key
    log_warn("Skipping SSH key")
    click.echo("")
    return None


def parse_failure_reason(error_msg):
    """Parse OCI error message for common failure reasons."""
    lower = error_msg.lower()
    if "out of" in lower and "capacity" in lower:
        return "Out of capacity"
    if "outof" in lower and "capacity" in lower:
        return "Out of capacity"
    if "not authorized" in lower or "notauthorized" in lower:
        return "Authorization failed"
    if "invalid" in lower or "bad request" in lower:
        return "Invalid configuration"
    if "serviceerror" in lower:
        match = re.search(r'"message":\s*"([^"]*)"', error_msg)
        if match:
            return match.group(1)
    return "Unknown error"


@click.command()
@click.option("--compartment-id", help="Compartment OCID")
@click.option("--subnet-id", help="Subnet OCID")
@click.option("--image-id", help="Image OCID")
@click.option("--shape", help="Instance shape")
@click.option("--ocpus", type=float, help="Number of OCPUs")
@click.option("--memory", type=float, help="Memory in GBs")
@click.option("--ssh-key", "ssh_key_path", help="Path to SSH public key file")
@click.option("--name", "instance_prefix", help="Instance name prefix")
def direct(compartment_id, subnet_id, image_id, shape, ocpus, memory, ssh_key_path, instance_prefix):
    """Deploy using OCI SDK directly."""
    tfvars = load_tfvars()
    click.echo("")

    _, identity, compute, compute_composite, vnet, vnet_composite, _, _ = get_clients()

    # Compartment
    if compartment_id:
        validate_compartment_id(compartment_id)
        compartment_name = "Provided"
    else:
        compartment_id, compartment_name = prompt_compartment(identity)

    # Subnet
    if subnet_id:
        log_info(f"Using provided subnet: {subnet_id}")
    else:
        subnet_id = prompt_subnet(vnet, compartment_id)

    # Image
    if image_id:
        log_info(f"Using provided image: {image_id}")
    else:
        image_id = prompt_image(compute, compartment_id)

    # Shape
    if shape and ocpus and memory:
        log_info(f"Shape: {shape}, OCPUs: {ocpus}, Memory: {memory}GB")
    else:
        shape, ocpus, memory = prompt_shape_config(tfvars)

    # SSH Key
    if ssh_key_path:
        ssh_public_key = Path(ssh_key_path).read_text().strip()
    else:
        ssh_public_key = prompt_ssh_key(tfvars)

    # Instance name
    if not instance_prefix:
        instance_prefix = click.prompt("Instance name prefix", default="vm")

    # Get ADs
    log_warn("Fetching Availability Domains...")
    ads_response = identity.list_availability_domains(compartment_id=compartment_id)
    ads = [ad.name for ad in ads_response.data]
    if not ads:
        log_error("Error: No Availability Domains found.")
        sys.exit(1)
    log_info(f"Found {len(ads)} Availability Domain(s)")
    click.echo("")

    # Summary
    log_warn("Summary:")
    click.echo(f"  Compartment: {compartment_name}")
    click.echo(f"  Subnet: {subnet_id}")
    click.echo(f"  Image: {image_id}")
    click.echo(f"  Shape: {shape} (OCPUs: {ocpus}, Memory: {memory}GB)")
    click.echo(f"  Instances: {len(ads)} (one per AD)")
    click.echo("")

    if not click.confirm("Proceed with instance creation?", default=False):
        click.echo("Aborted.")
        sys.exit(0)

    click.echo("")
    log_info("Launching instances...")
    click.echo("")

    created_ads = []
    created_ids = []
    failed_ads = []
    failed_reasons = []

    while len(created_ads) < len(ads):
        for ad_name in ads:
            if ad_name in created_ads:
                log_info(f"Skipping {ad_name} (already created)")
                continue

            ad_num = ad_name.split("-")[-1] if "-" in ad_name else "1"
            instance_name = f"{instance_prefix}-{ad_num}"

            log_warn(f"Launching {instance_name} in {ad_name}...")

            launch_details = oci.core.models.LaunchInstanceDetails(
                display_name=instance_name,
                compartment_id=compartment_id,
                availability_domain=ad_name,
                shape=shape,
                shape_config=oci.core.models.LaunchInstanceShapeConfigDetails(
                    ocpus=ocpus,
                    memory_in_gbs=memory,
                ),
                source_details=oci.core.models.InstanceSourceViaImageDetails(
                    image_id=image_id,
                ),
                create_vnic_details=oci.core.models.CreateVnicDetails(
                    subnet_id=subnet_id,
                    assign_public_ip=True,
                    display_name=f"{instance_name}-vnic",
                    assign_private_dns_record=True,
                ),
                metadata={"ssh_authorized_keys": ssh_public_key} if ssh_public_key else {},
                is_pv_encryption_in_transit_enabled=True,
            )

            try:
                response = compute_composite.launch_instance_and_wait_for_state(
                    launch_details,
                    wait_for_states=[oci.core.models.Instance.LIFECYCLE_STATE_RUNNING],
                    waiter_kwargs={"max_wait_seconds": 600, "succeed_on_not_found": False},
                )
                instance = response.data
                created_ads.append(ad_name)
                created_ids.append(instance.id)
                log_info(f"  {instance_name} created: {instance.id}")
            except oci.exceptions.ServiceError as e:
                reason = parse_failure_reason(str(e))
                failed_ads.append(ad_name)
                failed_reasons.append(reason)
                log_error(f"  Failed: {instance_name} in {ad_name}")
                log_error(f"  Reason: {reason}")
            except Exception as e:
                reason = parse_failure_reason(str(e))
                failed_ads.append(ad_name)
                failed_reasons.append(reason)
                log_error(f"  Failed: {instance_name} in {ad_name}")
                log_error(f"  Reason: {reason}")

            click.echo("")

        if len(created_ads) < len(ads):
            log_warn(f"{len(failed_ads)} AD(s) failed. Retrying in {SLEEP_SECONDS}s...")
            for idx, ad in enumerate(failed_ads):
                log_warn(f"  {ad}: {failed_reasons[idx]}")
            failed_ads = []
            failed_reasons = []
            time.sleep(SLEEP_SECONDS)

    # Summary
    log_info("=== Summary ===")
    click.echo(f"Successful: {len(created_ads)}")
    if created_ads:
        click.echo("")
        click.echo("Created Instances:")
        for idx, ad in enumerate(created_ads):
            click.echo(f"  {ad}: {created_ids[idx]}")


# --- Option 3: Destroy ---
@click.command()
@click.option("--net-stack-id", help="Networking stack OCID")
@click.option("--comp-stack-id", help="Compute stack OCID")
def destroy(net_stack_id, comp_stack_id):
    """Destroy Resource Manager stacks."""
    click.echo(f"{CYAN}=== Destroying stacks ==={NC}")
    env = load_env()
    tfvars = load_tfvars()
    click.echo("")

    compartment_id = tfvars.get("compartment_id")
    validate_compartment_id(compartment_id)

    _, _, _, _, _, _, rm, _ = get_clients()

    # Find stacks
    if net_stack_id:
        net_id = net_stack_id
    else:
        net_id = env.get("OCI_NETWORKING_STACK_ID")

    if comp_stack_id:
        comp_id = comp_stack_id
    else:
        comp_id = env.get("OCI_COMPUTE_STACK_ID")

    if not net_id and not comp_id:
        click.echo("No stacks found. Set OCI_NETWORKING_STACK_ID or OCI_COMPUTE_STACK_ID in .env, or create stacks first.")
        return

    if comp_id:
        log_warn(f"Destroying compute stack: {comp_id}")
        cancel_active_job(rm, comp_id)
        try:
            rm.delete_stack(stack_id=comp_id)
            log_info("  Compute stack deleted.")
        except Exception as e:
            log_error(f"  Failed to delete compute stack: {e}")

    if net_id:
        log_warn(f"Destroying networking stack: {net_id}")
        cancel_active_job(rm, net_id)
        try:
            rm.delete_stack(stack_id=net_id)
            log_info("  Networking stack deleted.")
        except Exception as e:
            log_error(f"  Failed to delete networking stack: {e}")


# --- Main CLI ---
@click.group()
def cli():
    """OCI VM Instance Generator - Deploy VMs on Oracle Cloud Infrastructure."""
    pass


cli.add_command(terraform)
cli.add_command(direct)
cli.add_command(destroy)


if __name__ == "__main__":
    cli()
