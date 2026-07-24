"""Test process isolation - verify main process doesn't import GPU dependencies."""

import sys


def test_main_import_does_not_load_cuda_deps() -> None:
    """Verify that importing ai_service.main does not load torch, whisperx, etc."""
    # Take snapshot of current modules
    modules_before = set(sys.modules.keys())

    # Import main module
    import ai_service.main  # noqa: F401

    # Check what new modules were loaded
    modules_after = set(sys.modules.keys())
    new_modules = modules_after - modules_before

    # List of modules that should NOT be imported by main
    forbidden_modules = {
        "torch",
        "torchaudio",
        "whisperx",
        "pyannote",
        "faster_whisper",
    }

    # Check that none of the GPU dependencies were imported
    loaded_forbidden = forbidden_modules.intersection(new_modules)
    assert (
        not loaded_forbidden
    ), f"Main process loaded forbidden GPU modules: {loaded_forbidden}"


def test_runner_import_does_not_load_cuda() -> None:
    """Verify that importing runner does not load torch, whisperx, etc."""
    # Clean modules first
    modules_before = set(sys.modules.keys())

    # Import runner
    import ai_service.whisperx.runner  # noqa: F401

    # Check what new modules were loaded
    modules_after = set(sys.modules.keys())
    new_modules = modules_after - modules_before

    # Runner should NOT import torch or whisperx
    forbidden_modules = {
        "torch",
        "torchaudio",
        "whisperx",
        "pyannote",
        "faster_whisper",
    }

    loaded_forbidden = forbidden_modules.intersection(new_modules)
    assert (
        not loaded_forbidden
    ), f"Runner loaded forbidden GPU modules: {loaded_forbidden}"


def test_whisperx_installed_check_does_not_import() -> None:
    """Test that whisperx_installed() doesn't import the third-party module."""
    # Remove modules to start fresh
    for mod in list(sys.modules.keys()):
        if "whisperx" in mod or "torch" in mod:
            del sys.modules[mod]

    from ai_service.whisperx import whisperx_installed

    # Call the function
    result = whisperx_installed()

    # Check that torch was not imported
    assert "torch" not in sys.modules, "whisperx_installed() imported torch"
    # The function just checks for spec, it shouldn't import whisperx
    # (unless the third-party package is actually installed)
