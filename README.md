# FargoWork

让 AI 帮你办理公司的出差、年假、采购和付款申请。

把仓库链接交给 AI，并说：

> 请帮我安装 FargoWork，按仓库说明完成登录。

完成钉钉登录后，直接告诉 AI 要办什么。它会补问必要信息、展示申请预览，确认一次后提交。

当前支持 Windows x64；四个流程均为测试用途，测试提交需要公司的 `MCP_allow` 角色。Mac 后续支持。

## 给安装 Agent

使用固定版本 v1.3.0 的官方入口一次完成安装、登录和 Skill 加载，默认通过官方 CLI 办事：

```powershell
Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/Ansel-O/fargowork/v1.3.0/public/bootstrap.ps1' -OutFile './fargowork-bootstrap.ps1'
powershell.exe -NoProfile -File './fargowork-bootstrap.ps1' -Target cli -Login -OpenBrowser always -OutputJsonl
```

加载安装输出的员工 Skill，用安装后的 `fargowork.exe tools call` 验证当前身份及流程目录；不要提交申请来验证安装。员工不需手写 MCP 配置，也不需临时 Node 脚本或 FullAccess。原生 MCP 是可选接入方式，不作为 CLI 安装完成条件。

成功只回复“已安装并登录，可以开始办理申请。”；尚未完成时只说明实际缺少的步骤。工具目录、配置、操作编号和测试报告不作为员工安装汇报。

[数据说明](public/EMPLOYEE-DATA-NOTE.md) · [排障说明](DEBUG.md)

FargoWork 与 Fargo AI/Fargo Pass 是独立产品，使用各自的安装和登录配置。
