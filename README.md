# FargoWork — Windows 员工试用版

FargoWork 让 AI 帮公司员工准备出差、年假、采购和付款流程。AI 读取标准 Skill，通过本地 FargoWork 连接程序访问公司的云端 MCP 服务；身份、权限、固定流程目标和业务校验由云端控制。

**当前是 Windows x64 试用版，所有流程都是测试用途；只有公司 `MCP_allow` 角色成员可以提交测试流程。Mac 待稳定后支持。**标准 Plugin、Skill 和 MCP 连接程序是一套交付；客户端信任、加载与实际工具调用仍需在你的客户端验收。

## 交给 AI 安装

把下面的话和本仓库链接交给你正在使用的 AI：

> 请从 https://github.com/Ansel-O/fargowork 安装或更新 FargoWork Windows 试用版，使用固定版本 v1.2.0 的官方 bootstrap 入口一次完成安装和登录。按本说明确定当前宿主的接入方式，不猜配置目录，不重复尝试不同安装命令，不动 Fargo AI 或其他产品。引导我本人完成钉钉授权及客户端信任，分别报告安装、登录和实际 MCP 工具结果。最后调用 get_current_user 与 list_work_templates。更新后若提示画像选择，请主动问我是否清空，默认保留；未回答不阻塞安装。失败时给出安全阶段、错误码和诊断导出方式，不要求我发凭据。

你完成钉钉授权，必要时在客户端确认信任并启用，然后新开会话。

AI 必须能下载文件并运行本地命令；只支持聊天的客户端需要自身的插件安装入口。未知客户端的自动配置方式需按其官方说明核对，不能猜目录或覆盖已有连接。

## 给安装 Agent 的步骤

1. 确认是 Windows x64，并确认当前宿主。目标可为 `cursor`、`codex`、`workbuddy`、`claude-code`；多个目标可用逗号分隔。支持标准 Plugin 的宿主按官方方式加载包；未知第三方使用 `manual` 返回的 Plugin/stdio/Skill 契约，由宿主或安装 Agent 按已核实的官方方式接入，不猜配置。Cindy 与 Codex 是不同宿主：不能因为 Cindy 内嵌 Codex 就宣称其工具已经接通。
2. 下载固定 tag 的 `public/bootstrap.ps1` 到本地文件并阅读。它读取同 tag 的发布清单，下载完整员工包，校验外层 SHA-256、大小和包内文件集合，再运行包内安装器。
3. 以下示例在 Cursor 中安装；为当前客户端替换 `-Target`，无需 Node.js 或 Python：

```powershell
Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/Ansel-O/fargowork/v1.2.0/public/bootstrap.ps1' -OutFile './fargowork-bootstrap.ps1'
powershell.exe -NoProfile -File './fargowork-bootstrap.ps1' -Target cursor -Login -OpenBrowser always -OutputJsonl
```

下载脚本后运行一次官方入口即可；不要把预检、安装、登录各自重新安装一轮。多端示例使用 `-Target 'cursor,codex'`。若已经知道内嵌 Codex CLI 的实际绝对路径，可传 `-CodexPath '已核实的codex.exe完整路径'`；找不到时停止报告，不全盘搜索或猜路径。公司设备策略阻止执行时保留错误，遵循 IT 要求，不更改策略或提权。

安装器只处理 FargoWork 自己的文件和连接；外来同名配置会报告冲突，不接管。用户的钉钉授权和客户端信任始终由用户本人完成。安装退出成功不自动代表客户端已信任或 MCP 工具已可用；以各阶段实际输出为准。`-DryRun` 会下载并校验临时发布物及写入诊断，但不会安装客户端配置；它不是零文件写入。

4. 登录后由当前客户端调用 `get_current_user`，确认身份，再调用 `list_work_templates` 验证工具可用。不要为验证连接提交流程。
5. 第三方客户端使用输出的绝对 EXE 路径和 `bridge` 参数注册 stdio MCP，并加载输出的标准 Skill。配置不包含 Bearer token。当前 Bridge 面向客户端协商 `2025-11-25`，向云端使用 `2026-07-28`；仅支持远程 HTTP 或不同协议的客户端不能据此保证可用。

## 下载 ZIP 或从内部平台安装

从 [v1.2.0 试用 Release](https://github.com/Ansel-O/fargowork/releases/tag/v1.2.0) 下载 `fargowork-employee-v1.2.0-windows-x64.zip`，按同 tag 的 [发布清单](public/release/windows-trial.json) 校验，再交给 AI。完整包内有安装器、说明、标准 Plugin/Skill 和原生连接程序。

解压后在包目录运行，例如：

```powershell
./install.ps1 -Target cursor -ServiceIssuer 'https://fargowork.fargowealthapp.com' -LocalArtifactDir . -Login -OpenBrowser always -OutputJsonl
```

内部平台可分发同一完整包，或分发安装说明引导获取该包。仅安装 `SKILL.md` 不会自动安装连接程序或完成登录。

## 更新、数据与边界

升级使用下一版完整包和对应说明；当前不自动追踪 `latest`。客户端配置和凭据与维护者开发环境分开，刷新凭据由 Windows DPAPI 保护；同一 Windows 用户的多客户端连接复用员工配置。Skill 指导预览与确认，当前没有独立可信的人类确认凭证。云端继续限制身份、所有权和业务权限。

首次验证登录后会创建当前企业与员工账号自己的画像文档。更新保留该文档，实际升级后由 Agent 主动询问是否清空；默认保留，没有回答也不阻塞安装。换账号加载另一份画像，清空只影响当前账号，不删除登录凭据或其他账号资料。个人偏好只辅助起草，不提供权限，也不自动确认提交。账号切换后新开会话，避免旧聊天仍含上一账号资料。

受管官方 Skill 随版本更新；直接改过的内容会保留并提示人工处理。WorkBuddy 仍需按输出路径导入 Skill，并在 UI 信任启用连接。业务输入和预览会进入你选择的 AI 上下文，使用符合公司要求的模型。

本地安全诊断统一位于 `%APPDATA%\FargoWork\diagnostics`，保留最多 7 天、总量最多 20 MiB；用操作编号串起安装与登录阶段。发生问题时让 Agent 使用 CLI 的 `diagnostics export` 导出本次窗口，无需手工打包整个目录。导出需你主动提供给支持，不自动上传，不含凭据、画像或业务正文。FargoWork 与独立产品 Fargo AI/Fargo Pass 的安装、凭据和日志互不处理。见[员工数据说明](public/EMPLOYEE-DATA-NOTE.md)和[安全说明](SECURITY.md)。

本仓库与员工包仅公开客户端，不包含 Server 源码、业务字段映射、审批规则、密钥或运行态。发布物目前没有代码签名或 CI provenance；SHA-256用于对照发布清单检查完整性。
