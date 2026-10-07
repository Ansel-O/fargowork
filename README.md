# FargoWork — Windows 员工试用版

FargoWork 让 AI 帮公司员工准备出差、年假、采购和付款流程。AI 读取标准 Skill，通过本地 FargoWork 连接程序访问公司的云端 MCP 服务；身份、权限、固定流程目标和业务校验由云端控制。

**当前是 Windows x64 试用版，所有流程都是测试用途，云端暂未开放业务提交。Mac 待稳定后支持。**已知客户端有安装适配，其他客户端使用标准 stdio MCP 入口。适配实现通过测试不等于每个客户端已经完成真实员工验收。

## 交给 AI 安装

把下面的话和本仓库链接交给你正在使用的 AI：

> 请从 https://github.com/Ansel-O/fargowork 安装 FargoWork Windows 试用版到当前客户端。阅读 README 和安装说明，使用固定版本 v1.1.0；核对下载包的 SHA-256，选择当前客户端的安装目标，执行安装并打开钉钉授权页面。不要让我手工编辑 MCP 配置，不要请求 token、AppSecret 或密钥。安装、登录和工具连接的结果分别报告；最后通过 FargoWork 的 get_current_user 工具验证身份。遇到客户端需要信任或启用时，告诉我点击哪里。

你完成钉钉授权，必要时在客户端确认信任并启用，然后新开会话。

AI 必须能下载文件并运行本地命令；只支持聊天的客户端需要自身的插件安装入口。未知客户端的自动配置方式需按其官方说明核对，不能猜目录或覆盖已有连接。

## 给安装 Agent 的步骤

1. 确认是 Windows x64，并确认当前客户端。目标可为 `cursor`、`codex`、`workbuddy`、`claude-code`；多个目标可用逗号分隔。未知第三方客户端先用 `manual`，再根据输出及该客户端官方文档完成接入。
2. 下载固定 tag 的 `public/bootstrap.ps1` 到本地文件并阅读。它读取同 tag 的发布清单，下载完整员工包，校验外层 SHA-256、大小和包内文件集合，再运行包内安装器。
3. 以下示例在 Cursor 中安装；为当前客户端替换 `-Target`，无需 Node.js 或 Python：

```powershell
Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/Ansel-O/fargowork/v1.1.0/public/bootstrap.ps1' -OutFile './fargowork-bootstrap.ps1'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File './fargowork-bootstrap.ps1' -Target cursor -Login -OpenBrowser always -OutputJsonl
```

多端示例使用 `-Target 'cursor,codex'`。安装器只处理 FargoWork 自己的文件和连接；外来同名配置会报告冲突，不接管。用户的钉钉授权和客户端信任始终由用户本人完成。安装退出成功不自动代表客户端已信任或 MCP 工具已可用；以各阶段实际输出为准。

4. 登录后由当前客户端调用 `get_current_user`，确认身份，再调用 `list_work_templates` 验证工具可用。不要为验证连接提交流程。
5. 第三方客户端使用输出的绝对 EXE 路径和 `bridge` 参数注册 stdio MCP，并加载输出的标准 Skill。配置不包含 Bearer token。当前 Bridge 面向客户端协商 `2025-11-25`，向云端使用 `2026-07-28`；仅支持远程 HTTP 或不同协议的客户端不能据此保证可用。

## 下载 ZIP 或从内部平台安装

从 [v1.1.0 试用 Release](https://github.com/Ansel-O/fargowork/releases/tag/v1.1.0) 下载 `fargowork-employee-v1.1.0-windows-x64.zip`，按同 tag 的 [发布清单](public/release/windows-trial.json) 校验，再交给 AI。完整包内有安装器、说明、Skill 和原生连接程序。

解压后在包目录运行，例如：

```powershell
./install.ps1 -Target cursor -ServiceIssuer 'https://fargowork.fargowealthapp.com' -LocalArtifactDir . -Login -OpenBrowser always -OutputJsonl
```

内部平台可分发同一完整包，或分发安装说明引导获取该包。仅安装 `SKILL.md` 不会自动安装连接程序或完成登录。

## 更新、数据与边界

升级使用下一版完整包和对应说明；当前不自动追踪 `latest`。客户端配置和凭据与维护者开发环境分开，刷新凭据由 Windows DPAPI 保护；同一 Windows 用户的多客户端连接复用员工配置。Skill 指导预览与确认，当前没有独立可信的人类确认凭证。云端继续限制身份、所有权和业务权限。

把个人偏好放在自有文件中，不直接改受管官方 Skill；受管内容会在升级时更新。若已经直接修改官方 Skill，安装器会保留修改并提示人工处理。WorkBuddy 仍需按输出路径导入 Skill，以及在 UI 信任并启用连接。业务输入和预览会进入你选择的 AI 上下文，使用符合公司要求的模型，问题反馈不得包含凭据或真实敏感业务内容。见 [员工数据说明](public/EMPLOYEE-DATA-NOTE.md) 和 [安全说明](SECURITY.md)。

本仓库与员工包仅公开客户端，不包含 Server 源码、业务字段映射、审批规则、密钥或运行态。发布物目前没有代码签名或 CI provenance；SHA-256用于对照发布清单检查完整性。
