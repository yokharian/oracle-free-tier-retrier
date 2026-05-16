"""Tests for utility functions: parse_failure_reason, zip_module."""

import io
import zipfile

import pytest

import main


class TestParseFailureReason:
    @pytest.mark.parametrize(
        "error_msg,expected",
        [
            ("Out of host capacity", "Out of capacity"),
            ("Out of capacity in AD-1", "Out of capacity"),
            ("OutOfHostCapacity error", "Out of capacity"),
            ("NotAuthorizedOrNotFound", "Authorization failed"),
            ("not authorized to perform", "Authorization failed"),
            ("InvalidParameterValue", "Invalid configuration"),
            ("Bad Request", "Invalid configuration"),
            ("Some random error", "Unknown error"),
        ],
    )
    def test_parse_known_errors(self, error_msg, expected):
        assert main.parse_failure_reason(error_msg) == expected

    def test_service_error_with_message(self):
        msg = 'ServiceError: {"message": "LimitExceeded", "code": "LimitExceeded"}'
        assert main.parse_failure_reason(msg) == "LimitExceeded"


class TestZipModule:
    def test_zip_creates_valid_zip(self, tmp_path):
        module_dir = tmp_path / "module"
        module_dir.mkdir()
        (module_dir / "main.tf").write_text("resource {}")
        (module_dir / "variables.tf").write_text("variable {}")

        zip_bytes = main.zip_module(module_dir)
        assert len(zip_bytes) > 0

        buf = io.BytesIO(zip_bytes)
        with zipfile.ZipFile(buf, "r") as zf:
            names = zf.namelist()
            assert "main.tf" in names
            assert "variables.tf" in names

    def test_zip_empty_directory(self, tmp_path):
        module_dir = tmp_path / "empty"
        module_dir.mkdir()
        zip_bytes = main.zip_module(module_dir)
        assert len(zip_bytes) > 0
