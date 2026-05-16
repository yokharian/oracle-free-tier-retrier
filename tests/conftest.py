"""Shared fixtures for OCI VM Instance Generator tests."""

import pytest

import main


@pytest.fixture
def runner():
    from click.testing import CliRunner
    return CliRunner()


@pytest.fixture
def tmp_tfvars(tmp_path):
    """Create a temporary terraform.tfvars file."""
    content = (
        'region              = "us-ashburn-1"\n'
        'compartment_id      = "ocid1.tenancy.oc1..aaaaaaaaavk4tr3ylnbnhawfzauar4ftme5kexmjaizojjz4wz6u5ghesbvq"\n'
        'availability_domain = "fNXZ:US-ASHBURN-AD-1"\n'
        'instance_name       = "testvm"\n'
        'instance_shape      = "VM.Standard.A1.Flex"\n'
        'instance_ocpus      = 1\n'
        'instance_memory_gbs = 6\n'
        'instance_image_id   = "ocid1.image.oc1.iad.aaaaaaaa43mhod2mxpjivckby6qsa2cmy6x3hj6bgb2xplozrib3edslmnpq"\n'
        'assign_public_ip    = true\n'
        'vcn_cidr            = "10.0.0.0/16"\n'
        'subnet_cidr         = "10.0.0.0/24"\n'
        'dns_label           = "05120944"\n'
        'ssh_public_key      = "ssh-rsa AAAAB3test user@host"\n'
    )
    tfvars = tmp_path / "terraform.tfvars"
    tfvars.write_text(content)
    return tfvars


@pytest.fixture
def tmp_env(tmp_path):
    """Create a temporary .env file."""
    content = (
        "OCI_NETWORKING_STACK_ID=ocid1.ormstack.oc1.iad.aaaaaaaatestnet\n"
        "OCI_COMPUTE_STACK_ID=ocid1.ormstack.oc1.iad.aaaaaaaatestcomp\n"
    )
    env = tmp_path / ".env"
    env.write_text(content)
    return env


@pytest.fixture
def mock_tfvars_path(monkeypatch, tmp_tfvars):
    """Monkeypatch TFVARS_FILE and ENV_FILE to use temp files."""
    monkeypatch.setattr(main, "TFVARS_FILE", tmp_tfvars)
    monkeypatch.setattr(main, "ENV_FILE", tmp_tfvars.parent / ".env")
    return tmp_tfvars
