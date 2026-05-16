"""Tests for compute instance operations: instance_exists."""

from unittest.mock import MagicMock

import pytest

import main


class TestInstanceExists:
    @pytest.fixture
    def mock_compute(self):
        return MagicMock()

    @pytest.mark.parametrize(
        "lifecycle_state,expected",
        [
            ("RUNNING", True),
            ("PROVISIONING", True),
            ("STARTING", True),
            ("STOPPING", True),
            ("STOPPED", True),
            ("TERMINATED", False),
            ("TERMINATING", False),
        ],
    )
    def test_instance_lifecycle_states(self, mock_compute, lifecycle_state, expected):
        mock_instance = MagicMock()
        mock_instance.lifecycle_state = lifecycle_state
        mock_compute.list_instances.return_value = MagicMock(data=[mock_instance])

        result = main.instance_exists(mock_compute, "comp-id", "testvm")
        assert result is expected

    def test_no_instances(self, mock_compute):
        mock_compute.list_instances.return_value = MagicMock(data=[])
        assert main.instance_exists(mock_compute, "comp-id", "testvm") is False

    def test_exception_returns_false(self, mock_compute):
        mock_compute.list_instances.side_effect = Exception("API error")
        assert main.instance_exists(mock_compute, "comp-id", "testvm") is False

    def test_calls_list_instances_with_correct_args(self, mock_compute):
        mock_compute.list_instances.return_value = MagicMock(data=[])
        main.instance_exists(mock_compute, "comp-123", "my-vm")
        mock_compute.list_instances.assert_called_once_with(
            compartment_id="comp-123",
            display_name="my-vm",
        )
