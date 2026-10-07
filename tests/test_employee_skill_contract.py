"""Published employee instructions must preserve the CLI and consent boundaries.

These checks read shipped documents only; no login, installation or service
request is used to test a documentation contract.
"""
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
SKILL_DIR = PUBLIC / "agent-plugin/fargowork/skills/fargowork-employee"


def repository_document(name):
    """These two source docs are exported to the public repository root."""
    source = PUBLIC / name
    return source if source.is_file() else ROOT / name


def text(path):
    return path.read_text(encoding="utf-8")


def contract(path):
    return " ".join(text(path).split())


def test_homepage_has_one_short_install_request_without_distribution_faq():
    readme = text(repository_document("README.md"))
    quote_lines = [line[2:].strip() for line in readme.splitlines() if line.startswith("> ")]
    assert quote_lines == ["请帮我安装 FargoWork，按仓库说明完成登录。"]
    assert len(quote_lines[0]) <= 40
    assert not re.search(r"\bzip\b|\.zip|内部平台|下载 ZIP|手工编辑", readme, flags=re.I)
    assert "v1.3.0/public/bootstrap.ps1" in readme
    assert "-Target cli -Login" in readme
    assert "原生 MCP 是可选" in readme
    assert "不作为 CLI 安装完成条件" in readme


def test_employee_completion_does_not_depend_on_host_mcp_or_long_report():
    for path in (repository_document("README.md"), PUBLIC / "EMPLOYEE-README.md"):
        doc = text(path)
        assert "已安装并登录，可以开始办理申请。" in doc
        assert "官方 CLI" in doc
        assert "FullAccess" in doc
        assert "不" in doc
    package = text(PUBLIC / "EMPLOYEE-README.md")
    assert "注册、信任与启用不是 CLI 路径的完成条件" in package
    assert "不要输出内部配置或验收长报告" in package


def test_skill_permits_official_cli_but_rejects_ad_hoc_clients():
    skill = contract(SKILL_DIR / "SKILL.md")
    assert "fargowork tools list --output jsonl" in skill
    assert "fargowork tools call NAME --output jsonl" in skill
    assert "UTF-8 JSON argument" in skill
    assert "--input-file PATH" in skill
    assert "official CLI for workflow tools" in skill
    assert "temporary Node/Python MCP client" in skill
    assert "native FargoWork MCP connection is an optional" in skill
    assert "Do not require registration, trust or enable" in skill
    assert "If a client has no separately configured" not in skill
    assert "Do not open a shell" not in skill


def test_confirmation_is_once_for_the_same_exact_draft_and_invalidated_on_change():
    skill = contract(SKILL_DIR / "SKILL.md")
    assert "single_final" in skill and "exact_draft" in skill
    assert "Ask once:" in skill
    assert "after that preview authorizes that exact draft" in skill
    assert "has already been previewed and clearly confirmed" in skill
    assert "has not changed or expired" in skill
    assert "Do not ask again" in skill
    assert "changed material value" in skill
    assert "invalidates the old confirmation" in skill
    assert "Asia/Singapore creation date" in skill
    assert "not its final confirmation" in skill
    assert "not re-prepare merely" in skill


def test_business_completion_and_support_errors_are_not_tool_completion():
    skill = contract(SKILL_DIR / "SKILL.md")
    assert "status=completed" in skill
    assert "not that the application was submitted" in skill
    assert "isError" in skill
    assert "action_result.display_message" in skill
    assert "Never retry a submission on" in skill
    assert "safe employee message and support" in skill
    assert "Hide draft_id, tool names" in skill
    assert "Do not narrate module" in skill


def test_account_preferences_do_not_authorize_business_or_cross_accounts():
    skill = contract(SKILL_DIR / "SKILL.md")
    assert "Compare its verified corp_id/userid" in skill
    assert "A mismatch stops the" in skill
    assert "Do not enumerate other profiles" in skill
    assert "keeping is the default" in skill
    assert "default/no-answer path" in skill
    assert "Do not repeat the question for the same reviewed client" in skill
    assert "profile reset" in skill and "explicit clear choice" in skill
    assert "cannot change identity, roles" in skill
    assert "Fargo AI/Fargo Pass is a separate product" in skill


def test_references_keep_one_confirmation_and_silent_contract_loading():
    for name in ("workflow-annual-leave.md", "workflow-business-trip.md"):
        reference = contract(SKILL_DIR / "references" / name)
        assert "silently through the official CLI" in reference
        assert "without narrating tool" in reference
        assert "ask once" in reference
        assert "already been" in reference and "without asking again" in reference
    time_contract = text(SKILL_DIR / "references/time-contract.md")
    assert "Read this reference silently" in time_contract
    assert "Never calculate or send epoch milliseconds" in time_contract


def test_debug_is_the_only_diagnostic_guide_and_contains_no_install_success_claim():
    debug = text(repository_document("DEBUG.md"))
    assert "diagnostics export --days 1" in debug
    assert "当前不按单个操作编号筛选" in debug
    assert "不自动上传" in debug
    assert "MCP 注册、信任或 UI 连接" in debug
    assert "不从已有成功推断 FullAccess" in debug
    assert "未知提交结果不自动重发" in debug
    for name in ("README.md", "EMPLOYEE-README.md"):
        path = repository_document(name) if name == "README.md" else PUBLIC / name
        assert "diagnostics export" not in text(path)
        assert "DEBUG.md" in text(path)
