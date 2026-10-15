# 安装 FargoWork

请在 Windows 电脑上把仓库首页的一句话发给能运行本机命令的 AI。Agent 使用固定版本 v1.4.1 的官方入口，完成安装和钉钉登录：

```powershell
Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/Ansel-O/fargowork/v1.4.1/public/bootstrap.ps1' -OutFile './fargowork-bootstrap.ps1'
powershell.exe -NoProfile -File './fargowork-bootstrap.ps1' -Login -OpenBrowser always
```

安装成功后，Agent 读取返回结果中的 `skill_paths`，加载出差、年假、采购、对外付款四个流程 Skill 和员工入口 Skill。确认安装与登录完成后，只需简短回复“已安装并登录，可以开始办理申请。”；不要向员工展示安装事件、配置或验收报告。

如安装、登录或 Skill 加载未完成，Agent 说明实际缺少的步骤，并按 [排障说明](DEBUG.md)处理；不要提交申请来验证安装。
