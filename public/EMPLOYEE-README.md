# FargoWork Windows 员工试用版

复制下面这句话，发给能运行本地命令的 AI：

> 请从 https://github.com/Ansel-O/fargowork 安装 FargoWork，并帮我完成登录。

你完成钉钉授权后，直接提出出差、年假、采购或付款申请。AI 会补问必要信息、展示完整业务预览，确认一次后提交。当前是 Windows x64 测试版，测试提交需要公司的 `MCP_allow` 角色；Mac 后续支持。

## 给安装 Agent

从本包目录运行一次官方安装入口：

```powershell
./install.ps1 -Target cli -ServiceIssuer 'https://fargowork.fargowealthapp.com' -LocalArtifactDir . -Login -OpenBrowser always -OutputJsonl
```

读取并加载安装输出的员工 Skill。默认使用安装后的官方 CLI 完成业务调用，无需员工配置 MCP、安装 Node.js 或切换 FullAccess。通过只读身份和流程目录调用核验可用性，不提交流程。原生 MCP 可选；它的注册、信任与启用不是 CLI 路径的完成条件。

成功只回复“已安装并登录，可以开始办理申请。”；若仍缺登录或 Skill 加载，只提示该步骤。不要输出内部配置或验收长报告。升级时若画像提示待选择，问一次是否清空，默认保留，不阻塞安装。

排障见 [DEBUG.md](../DEBUG.md)，数据说明见 [员工数据说明](EMPLOYEE-DATA-NOTE.md)。Fargo AI/Fargo Pass 是另一产品，安装时保持它的配置和凭据。
