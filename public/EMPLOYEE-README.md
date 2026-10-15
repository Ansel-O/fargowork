# FargoWork 员工包

在官方安装器准备的员工包目录中运行本包安装入口并完成钉钉登录：

    ./install.ps1 -Target cli -ServiceIssuer 'https://fargowork.fargowealthapp.com' -LocalArtifactDir . -Login -OpenBrowser always -OutputJsonl

Agent 读取安装成功结果中的 `skill_path` 并加载员工 Skill。完成后只需简短回复“已安装并登录，可以开始办理申请。”；若步骤未完成，按 [排障说明](../DEBUG.md)处理。

[员工数据说明](EMPLOYEE-DATA-NOTE.md)
