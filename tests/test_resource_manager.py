"""Tests for Resource Manager operations: stacks, jobs, deployments, retry loop."""

from unittest.mock import MagicMock

import pytest

import main


class TestWaitForJob:
    @pytest.fixture
    def mock_rm(self):
        return MagicMock()

    @pytest.mark.parametrize(
        "state,expected",
        [
            ("SUCCEEDED", True),
            ("FAILED", False),
            ("CANCELLED", False),
        ],
    )
    def test_terminal_states(self, mock_rm, state, expected):
        mock_job = MagicMock()
        mock_job.lifecycle_state = state
        mock_rm.list_jobs.return_value = MagicMock(data=[mock_job])
        assert main.wait_for_job(mock_rm, "stack-id", timeout=1, interval=0) is expected

    def test_no_jobs_returns_false(self, mock_rm):
        mock_rm.list_jobs.return_value = MagicMock(data=[])
        assert main.wait_for_job(mock_rm, "stack-id", timeout=1, interval=0) is False

    def test_times_out_on_in_progress(self, mock_rm):
        mock_job = MagicMock()
        mock_job.lifecycle_state = "IN_PROGRESS"
        mock_rm.list_jobs.return_value = MagicMock(data=[mock_job])
        assert main.wait_for_job(mock_rm, "stack-id", timeout=1, interval=0.1) is False


class TestCancelActiveJob:
    @pytest.fixture
    def mock_rm(self):
        return MagicMock()

    @pytest.mark.parametrize(
        "state,should_cancel",
        [
            ("ACCEPTED", True),
            ("IN_PROGRESS", True),
            ("CANCELING", True),
            ("SUCCEEDED", False),
            ("FAILED", False),
        ],
    )
    def test_cancel_logic(self, mock_rm, state, should_cancel):
        mock_job = MagicMock()
        mock_job.id = "job-123"
        mock_job.lifecycle_state = state
        mock_rm.list_jobs.return_value = MagicMock(data=[mock_job])

        main.cancel_active_job(mock_rm, "stack-id")

        if should_cancel:
            mock_rm.cancel_job.assert_called_once_with(job_id="job-123")
        else:
            mock_rm.cancel_job.assert_not_called()

    def test_no_jobs_does_nothing(self, mock_rm):
        mock_rm.list_jobs.return_value = MagicMock(data=[])
        main.cancel_active_job(mock_rm, "stack-id")
        mock_rm.cancel_job.assert_not_called()


class TestGetStackOutputs:
    @pytest.fixture
    def mock_rm(self):
        return MagicMock()

    def test_returns_outputs(self, mock_rm):
        mock_state = MagicMock()
        mock_state.outputs = {"subnet_id": MagicMock(value="subnet-123")}
        mock_rm.get_stack.return_value = MagicMock(data=MagicMock(terraform_state=mock_state))
        assert "subnet_id" in main.get_stack_outputs(mock_rm, "stack-id")

    def test_returns_empty_on_no_state(self, mock_rm):
        mock_rm.get_stack.return_value = MagicMock(data=MagicMock(terraform_state=None))
        assert main.get_stack_outputs(mock_rm, "stack-id") == {}

    def test_returns_empty_on_exception(self, mock_rm):
        mock_rm.get_stack.side_effect = Exception("API error")
        assert main.get_stack_outputs(mock_rm, "stack-id") == {}


class TestCreateRmStack:
    @pytest.fixture
    def mock_rm(self):
        mock = MagicMock()
        mock.create_stack.return_value = MagicMock(data=MagicMock(id="stack-123"))
        return mock

    def test_creates_stack_with_variables(self, mock_rm):
        zip_bytes = b"fake zip content"
        result = main.create_rm_stack(
            mock_rm, "comp-id", "test-stack", "description", zip_bytes, {"key": "value"}
        )
        assert result == "stack-123"
        details = mock_rm.create_stack.call_args[1]["create_stack_details"]
        assert details.compartment_id == "comp-id"
        assert details.display_name == "test-stack"
        assert details.variables == {"key": "value"}
        assert details.config_source.config_source_type == "ZIP_UPLOAD"

    def test_creates_stack_without_variables(self, mock_rm):
        zip_bytes = b"fake zip content"
        result = main.create_rm_stack(mock_rm, "comp-id", "test-stack", "description", zip_bytes)
        assert result == "stack-123"
        details = mock_rm.create_stack.call_args[1]["create_stack_details"]
        assert details.variables == {}


class TestApplyStack:
    @pytest.fixture
    def mock_rm(self):
        mock = MagicMock()
        mock.create_job.return_value = MagicMock(data=MagicMock(id="job-123"))
        return mock

    def test_creates_apply_job(self, mock_rm):
        result = main.apply_stack(mock_rm, "stack-id")
        assert result == "job-123"
        details = mock_rm.create_job.call_args[1]["create_job_details"]
        assert details.job_operation_details.execution_plan_strategy == "AUTO_APPROVED"


class TestUpdateStackVariables:
    @pytest.fixture
    def mock_rm(self):
        return MagicMock()

    def test_updates_variables(self, mock_rm):
        main.update_stack_variables(mock_rm, "stack-id", {"availability_domain": "AD-1"})
        call_kwargs = mock_rm.update_stack.call_args[1]
        assert call_kwargs["stack_id"] == "stack-id"
        assert call_kwargs["update_stack_details"].variables == {"availability_domain": "AD-1"}


class TestDeployNetworkingStack:
    @pytest.fixture
    def mock_rm(self):
        return MagicMock()

    def test_returns_existing_id(self, mock_rm, mock_tfvars_path):
        mock_rm = MagicMock()
        result = main.deploy_networking_stack(mock_rm, "comp-id", {}, existing_id="existing-id")
        assert result == "existing-id"
        mock_rm.create_stack.assert_not_called()

    def test_creates_new_stack(self, monkeypatch, mock_tfvars_path, tmp_path):
        mock_rm = MagicMock()
        mock_rm.create_stack.return_value = MagicMock(data=MagicMock(id="new-stack-id"))
        mock_job = MagicMock()
        mock_job.lifecycle_state = "SUCCEEDED"
        mock_rm.list_jobs.return_value = MagicMock(data=[mock_job])

        net_dir = tmp_path / "networking"
        net_dir.mkdir()
        (net_dir / "main.tf").write_text("resource {}")

        monkeypatch.setattr(main, "SCRIPT_DIR", tmp_path)
        result = main.deploy_networking_stack(mock_rm, "comp-id", {
            "region": "us-ashburn-1",
            "compartment_id": "comp-id",
            "vcn_cidr": "10.0.0.0/16",
            "subnet_cidr": "10.0.0.0/24",
            "dns_label": "test1234",
        })

        assert result == "new-stack-id"
        mock_rm.create_stack.assert_called_once()


class TestDeployComputeStack:
    def test_returns_existing_id(self, mock_tfvars_path):
        mock_rm = MagicMock()
        result = main.deploy_compute_stack(
            mock_rm, "comp-id", {}, "net-stack-id", existing_id="existing-comp-id"
        )
        assert result == "existing-comp-id"
        mock_rm.create_stack.assert_not_called()

    def test_creates_new_stack(self, mock_tfvars_path):
        mock_rm = MagicMock()
        mock_state = MagicMock()
        mock_state.outputs = {"subnet_display_name": MagicMock(value="subnet-test")}
        mock_rm.get_stack.return_value = MagicMock(data=MagicMock(terraform_state=mock_state))
        mock_rm.create_stack.return_value = MagicMock(data=MagicMock(id="new-comp-stack"))

        tfvars = {
            "region": "us-ashburn-1",
            "compartment_id": "comp-id",
            "instance_name": "testvm",
            "instance_shape": "VM.Standard.A1.Flex",
            "instance_ocpus": 1.0,
            "instance_memory_gbs": 6.0,
            "assign_public_ip": True,
        }

        result = main.deploy_compute_stack(mock_rm, "comp-id", tfvars, "net-stack-id")
        assert result == "new-comp-stack"
        mock_rm.create_stack.assert_called_once()


class TestRetryComputeLoop:
    def test_exits_when_vm_exists(self, monkeypatch, mock_tfvars_path):
        mock_rm = MagicMock()
        mock_compute = MagicMock()
        mock_compute.list_instances.return_value = MagicMock(data=[
            MagicMock(lifecycle_state="RUNNING")
        ])

        monkeypatch.setattr(main, "SLEEP_SECONDS", 0)
        main.retry_compute_loop(
            mock_rm, mock_compute, "comp-id", "stack-id",
            ["AD-1", "AD-2"], {"instance_name": "testvm"}
        )

        mock_rm.list_jobs.assert_not_called()

    def test_tries_each_ad(self, monkeypatch, mock_tfvars_path):
        mock_rm = MagicMock()
        mock_compute = MagicMock()

        call_count = [0]

        def mock_list_instances(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return MagicMock(data=[])
            return MagicMock(data=[MagicMock(lifecycle_state="RUNNING")])

        mock_compute.list_instances.side_effect = mock_list_instances

        mock_job = MagicMock()
        mock_job.lifecycle_state = "FAILED"
        mock_rm.list_jobs.return_value = MagicMock(data=[mock_job])
        mock_rm.create_job.return_value = MagicMock(data=MagicMock(id="job-123"))

        monkeypatch.setattr(main, "SLEEP_SECONDS", 0)
        main.retry_compute_loop(
            mock_rm, mock_compute, "comp-id", "stack-id",
            ["AD-1"], {"instance_name": "testvm"}
        )

        mock_rm.update_stack.assert_called_once()
