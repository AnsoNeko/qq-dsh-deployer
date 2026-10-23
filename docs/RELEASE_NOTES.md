# v0.1.0 · 大肥鱼 QQ 部署助手

开发者：**安索**。

- Electron 中文桌面界面：环境总览、快速部署、连接配置、运行管理、日志诊断。
- 检测 Harness、SnowLuma、QQ Bridge、QQ、Node.js、npm、Git、preset / MCP。
- 支持微软官方 PowerShell 7 独立安装，可选加入用户 PATH，便于 AI 和终端使用。
- 固定组件版本与官方来源、下载摘要校验、配置备份、取消重试及桥接升级失败恢复。
- “关于软件”展示开发者、引用项目与蓝色源码链接。
- 内置 GitHub Release 更新：安装版自动下载后重启安装；便携版自动下载并提示退出后替换。

下载 `Setup.exe` 安装使用，或选择 `Portable.exe` 便携包。软件自身不需要系统 Node.js / .NET。`latest.yml` 与安装包的 blockmap 用于安装版自动更新，请与 EXE 一并保留。

已完成自动测试、真实 Electron 界面检查，以及隔离目录的 PowerShell / Node / 桥接和官方 desktop CLI 插件配置验收。安装包经过隔离目录安装、启动与卸载验证；便携启动经过验证。

Harness 首次账号配置、SnowLuma 首次设置及真实 QQ 消息往返需要用户参与，首版明确标记待实测。SnowLuma 自动部署须处于覆盖该用途的书面授权范围内，不内置其安装包。

安装包当前未使用商业代码签名证书。文件摘要见 `SHA256SUMS.txt`。第三方许可见仓库说明。
