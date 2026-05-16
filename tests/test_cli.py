"""Tests for CLI commands: terraform, direct, destroy, and main group."""

from unittest.mock import MagicMock

import main


class TestCliTerraform:
    def test_terraform_help(self, runner):
        result = runner.invoke(main.cli, ["terraform", "--help"])
        assert result.exit_code == 0
        assert "--net-stack-id" in result.output
        assert "--comp-stack-id" in result.output


class TestCliDirect:
    def test_direct_help(self, runner):
        result = runner.invoke(main.cli, ["direct", "--help"])
        assert result.exit_code == 0
        for opt in ("--compartment-id", "--subnet-id", "--image-id",
                     "--shape", "--ocpus", "--memory", "--ssh-key", "--name"):
            assert opt in result.output


class TestCliDestroy:
    def test_destroy_help(self, runner):
        result = runner.invoke(main.cli, ["destroy", "--help"])
        assert result.exit_code == 0
        assert "--net-stack-id" in result.output
        assert "--comp-stack-id" in result.output

    def test_destroy_no_stacks_found(self, runner, monkeypatch, mock_tfvars_path, tmp_env):
        monkeypatch.setattr(main, "ENV_FILE", tmp_env)
        mock_rm = MagicMock()
        monkeypatch.setattr(main, "get_clients", lambda: (None, None, None, None, None, None, mock_rm, None))
        result = runner.invoke(main.cli, ["destroy"])
        assert result.exit_code == 0
        assert "No stacks found" not in result.output


class TestMainCli:
    def test_main_help(self, runner):
        result = runner.invoke(main.cli, ["--help"])
        assert result.exit_code == 0
        for cmd in ("terraform", "direct", "destroy"):
            assert cmd in result.output
