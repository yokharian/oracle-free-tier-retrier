"""Tests for config parsing: parse_tfvar, load_tfvars, load_env, save_env, validate_compartment_id."""

import pytest

import main


class TestParseTfvar:
    def test_parse_string_value(self, tmp_tfvars):
        result = main.parse_tfvar("region", tmp_tfvars)
        assert result == "us-ashburn-1"

    def test_parse_compartment_id(self, tmp_tfvars):
        result = main.parse_tfvar("compartment_id", tmp_tfvars)
        assert result == "ocid1.tenancy.oc1..aaaaaaaaavk4tr3ylnbnhawfzauar4ftme5kexmjaizojjz4wz6u5ghesbvq"

    def test_parse_nonexistent_key(self, tmp_tfvars):
        result = main.parse_tfvar("nonexistent_key", tmp_tfvars)
        assert result is None

    def test_parse_missing_file(self, tmp_path):
        missing = tmp_path / "nonexistent.tfvars"
        with pytest.raises(SystemExit, match="1"):
            main.parse_tfvar("region", missing)

    @pytest.mark.parametrize(
        "key,expected",
        [
            ("region", "us-ashburn-1"),
            ("compartment_id", "ocid1.tenancy.oc1..aaaaaaaaavk4tr3ylnbnhawfzauar4ftme5kexmjaizojjz4wz6u5ghesbvq"),
            ("instance_name", "testvm"),
            ("instance_shape", "VM.Standard.A1.Flex"),
            ("vcn_cidr", "10.0.0.0/16"),
            ("subnet_cidr", "10.0.0.0/24"),
            ("dns_label", "05120944"),
            ("ssh_public_key", "ssh-rsa AAAAB3test user@host"),
        ],
    )
    def test_parse_all_string_values(self, tmp_tfvars, key, expected):
        assert main.parse_tfvar(key, tmp_tfvars) == expected


class TestLoadTfvars:
    def test_load_all_keys(self, monkeypatch):
        values = {
            "region": "us-ashburn-1",
            "compartment_id": "ocid1.tenancy.oc1..aaaaaaaaavk4tr3ylnbnhawfzauar4ftme5kexmjaizojjz4wz6u5ghesbvq",
            "instance_name": "testvm",
            "instance_shape": "VM.Standard.A1.Flex",
            "instance_ocpus": "1",
            "instance_memory_gbs": "6",
            "assign_public_ip": "true",
            "vcn_cidr": "10.0.0.0/16",
            "subnet_cidr": "10.0.0.0/24",
            "dns_label": "05120944",
            "ssh_public_key": "ssh-rsa AAAAB3test user@host",
            "availability_domain": "fNXZ:US-ASHBURN-AD-1",
            "instance_image_id": "ocid1.image.oc1.iad.test",
        }
        monkeypatch.setattr(main, "parse_tfvar", lambda key, tfvars_path=None: values.get(key))
        result = main.load_tfvars()
        assert result["region"] == "us-ashburn-1"
        assert result["compartment_id"] == values["compartment_id"]
        assert result["instance_name"] == "testvm"
        assert result["instance_shape"] == "VM.Standard.A1.Flex"
        assert result["instance_ocpus"] == 1.0
        assert result["instance_memory_gbs"] == 6.0
        assert result["assign_public_ip"] is True
        assert result["vcn_cidr"] == "10.0.0.0/16"
        assert result["subnet_cidr"] == "10.0.0.0/24"
        assert result["dns_label"] == "05120944"
        assert result["ssh_public_key"] == "ssh-rsa AAAAB3test user@host"

    @pytest.mark.parametrize(
        "content,expected",
        [
            ("assign_public_ip = false\n", "false"),
            ("assign_public_ip = true\n", "true"),
        ],
    )
    def test_parse_bool_values(self, tmp_path, content, expected):
        tfvars = tmp_path / "terraform.tfvars"
        tfvars.write_text(content)
        assert main.parse_tfvar("assign_public_ip", tfvars) == expected

    @pytest.mark.parametrize(
        "content,key,expected",
        [
            ("instance_ocpus = 2\n", "instance_ocpus", "2"),
            ("instance_memory_gbs = 12\n", "instance_memory_gbs", "12"),
            ("instance_ocpus = 4.0\n", "instance_ocpus", "4.0"),
        ],
    )
    def test_parse_numeric_values(self, tmp_path, content, key, expected):
        tfvars = tmp_path / "terraform.tfvars"
        tfvars.write_text(content)
        assert main.parse_tfvar(key, tfvars) == expected

    def test_parse_tfvar_handles_comments(self, tmp_path):
        tfvars = tmp_path / "terraform.tfvars"
        tfvars.write_text('# comment\nregion = "us-ashburn-1"\n')
        assert main.parse_tfvar("region", tfvars) == "us-ashburn-1"


class TestLoadEnv:
    def test_load_existing_env(self, monkeypatch, tmp_env):
        monkeypatch.setattr(main, "ENV_FILE", tmp_env)
        result = main.load_env()
        assert result["OCI_NETWORKING_STACK_ID"] == "ocid1.ormstack.oc1.iad.aaaaaaaatestnet"
        assert result["OCI_COMPUTE_STACK_ID"] == "ocid1.ormstack.oc1.iad.aaaaaaaatestcomp"

    def test_load_empty_env(self, monkeypatch, tmp_path):
        env = tmp_path / ".env"
        env.write_text("# empty\n")
        monkeypatch.setattr(main, "ENV_FILE", env)
        assert main.load_env() == {}

    def test_load_missing_env(self, monkeypatch, tmp_path):
        env = tmp_path / ".env"
        monkeypatch.setattr(main, "ENV_FILE", env)
        assert main.load_env() == {}

    def test_load_env_with_comments(self, monkeypatch, tmp_path):
        env = tmp_path / ".env"
        env.write_text("# comment\nOCI_NETWORKING_STACK_ID=ocid1.ormstack.oc1.iad.test\n# another\n")
        monkeypatch.setattr(main, "ENV_FILE", env)
        assert main.load_env()["OCI_NETWORKING_STACK_ID"] == "ocid1.ormstack.oc1.iad.test"


class TestSaveEnv:
    def test_save_env(self, monkeypatch, tmp_path):
        env = tmp_path / ".env"
        monkeypatch.setattr(main, "ENV_FILE", env)
        main.save_env({"OCI_NETWORKING_STACK_ID": "net-123", "OCI_COMPUTE_STACK_ID": "comp-456"})
        content = env.read_text()
        assert "OCI_NETWORKING_STACK_ID=net-123" in content
        assert "OCI_COMPUTE_STACK_ID=comp-456" in content


class TestValidateCompartmentId:
    @pytest.mark.parametrize(
        "cid",
        [
            "ocid1.compartment.oc1..aaaaaaaaatest",
            "ocid1.tenancy.oc1..aaaaaaaaatest",
        ],
    )
    def test_valid_ids(self, cid):
        main.validate_compartment_id(cid)

    @pytest.mark.parametrize(
        "cid",
        [
            "",
            "invalid-ocid",
            "ocid1.unknown.oc1..test",
        ],
    )
    def test_invalid_ids(self, cid):
        with pytest.raises(SystemExit, match="1"):
            main.validate_compartment_id(cid)
