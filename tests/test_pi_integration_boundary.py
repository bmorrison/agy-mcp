"""The optional Pi client must not alter Python dependencies, tools or payloads.

These are source/contract guards, not a substitute for auditing freshly built
wheel/sdist bytes. No Node executable, package setup or inference is required.
"""

import importlib.util
import json
import os
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _release_audit():
    spec = importlib.util.spec_from_file_location(
        "pi_boundary_release_audit", ROOT / "scripts" / "check_release_artifacts.py",
    )
    assert spec is not None and spec.loader is not None
    audit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audit)
    return audit


def test_python_project_keeps_optional_node_dependencies_out():
    config = tomllib.loads((ROOT / "pyproject.toml").read_text())
    assert config["project"]["dependencies"] == ["mcp[cli]>=1.21.2,<2", "pydantic>=2.7"]
    assert config["project"]["scripts"] == {
        "agymcp": "agy_mcp.cli:main",
        "agy-bridge": "agy_mcp.bridge:main",
        "agy-doctor": "agy_mcp.doctor:main",
        "agy-install-skill": "agy_mcp.install:main",
    }
    assert config["build-system"]["build-backend"] == "hatchling.build"


def test_python_release_allowlists_do_not_include_optional_integration():
    config = tomllib.loads((ROOT / "pyproject.toml").read_text())
    targets = config["tool"]["hatch"]["build"]["targets"]
    assert targets["wheel"]["packages"] == ["src/agy_mcp"]
    assert set(targets["sdist"]["include"]) == {
        "src/agy_mcp", "docs/architecture.md", "docs/cli-capabilities.md",
        "docs/comparison-with-cli-wrappers.md", "docs/examples.md", "docs/installation.md",
        "docs/output-strategy.md", "docs/README_EN.md", "docs/README_JA.md",
        "docs/README_ZH-TW.md", "docs/release.md", "docs/security.md",
        "docs/subagent-workflows.md", "README.md", "LICENSE", "CHANGELOG.md", "pyproject.toml",
    }
    assert not (ROOT / "package.json").exists(), "optional client must not create a root npm workspace"
    audit = _release_audit()
    for members in (audit.REQUIRED_SDIST_FILES, audit.ALLOWED_SDIST_FILES, audit.REQUIRED_WHEEL_FILES):
        assert members
        for member in members:
            assert not {"integrations", "node_modules", "agy-pi-subagents", "test", "tests"}.intersection(
                Path(member).parts,
            )
            assert Path(member).suffix not in {".ts", ".js", ".tgz"}


def test_sdist_explicitly_excludes_root_optional_integration():
    # Basename includes such as README.md also match nested dependency docs.
    # Keep this root-anchored exclusion in addition to the unchanged include list;
    # real fresh-build auditing remains necessary to prove Hatchling semantics.
    config = tomllib.loads((ROOT / "pyproject.toml").read_text())
    assert "/integrations/" in config["tool"]["hatch"]["build"]["targets"]["sdist"]["exclude"]


@pytest.mark.parametrize("module", ["quota.py", "probe_process.py"])
def test_release_requires_existing_quota_and_probe_modules(module):
    audit = _release_audit()
    assert (ROOT / "src" / "agy_mcp" / module).is_file()
    for required, prefix in (
        (audit.REQUIRED_SDIST_FILES, "src/agy_mcp"),
        (audit.REQUIRED_WHEEL_FILES, "agy_mcp"),
    ):
        member = f"{prefix}/{module}"
        assert member in required
        problems = audit._check_files("missing-module", sorted(required - {member}), required)
        assert problems == [f"[missing-module] missing required file: {member}"]
    assert f"src/agy_mcp/{module}" in audit.ALLOWED_SDIST_FILES


@pytest.mark.parametrize("member", [
    "integrations/pi-subagents/README.md",
    "integrations/pi-subagents/node_modules/example/CHANGELOG.md",
    "integrations/pi-subagents/agy-subagents/assignment.json",
])
def test_sdist_auditor_still_rejects_optional_documents_dependencies_and_state(member):
    audit = _release_audit()
    problems = audit._check_files(
        "optional-leak", sorted(audit.REQUIRED_SDIST_FILES | {member}),
        audit.REQUIRED_SDIST_FILES, audit.ALLOWED_SDIST_FILES,
    )
    assert problems == [f"[optional-leak] unexpected file shipped: {member}"]


def test_release_content_privacy_checks_remain_strict():
    audit = _release_audit()
    problems = audit._check_contents("privacy", [
        audit.ArtifactFile("README.md", b"Example /Users/foo/project"),
        audit.ArtifactFile("docs/security.md", b"sk-" + b"a" * 32),
    ])
    assert len(problems) == 2
    assert "raw macOS home path" in problems[0]
    assert "OpenAI-style API key" in problems[1]


def test_public_python_tools_do_not_require_node_or_grow_pi_controls():
    # A fresh interpreter must import the actual checkout and list the public
    # tools with no executable search path. Clearing PATH only after importing
    # server in this pytest process would miss an accidental import-time Node use.
    env = {
        **os.environ, "PATH": "", "PYTHONPATH": str(ROOT / "src"),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    for name in list(env):
        if name.startswith("AGY_PI_"):
            del env[name]
    script = (
        "import asyncio,json; from agy_mcp import server; "
        "print(json.dumps([t.name for t in asyncio.run(server.mcp.list_tools())]))"
    )
    result = subprocess.run(
        [sys.executable, "-c", script], cwd=ROOT, env=env,
        check=True, capture_output=True, text=True, timeout=10,
    )
    tools = set(json.loads(result.stdout))
    assert tools == {
        "agy", "agy_start", "agy_status", "agy_read", "agy_result", "agy_cancel",
        "agy_sessions", "agy_transcript", "agy_purge", "agy_doctor", "agy_install_skill",
        "agy_continue", "agy_quota",
    }
    assert "agy_subagent_control" not in tools
