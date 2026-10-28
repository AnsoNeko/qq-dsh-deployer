# 第三方说明

本工具源码采用 MIT 许可。应用依赖及其许可证以 `package-lock.json`、所安装包内的 LICENSE、Electron 的 LICENSE/Chromium notices 为准；发行目录保留 Electron 的许可证文件。

主要应用依赖：Electron（MIT）、React / React DOM（MIT）、Vite / electron-vite（MIT）、Lucide 图标（ISC）、js-yaml（MIT）、semver（ISC）、ws（MIT）、https-proxy-agent（MIT）、Zod（MIT）。

运行时下载组件独立适用原许可：

- Qwen3-TTS 运行库与 CustomVoice 模型：Apache-2.0；https://github.com/QwenLM/Qwen3-TTS 和 https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice
- uv：MIT / Apache-2.0；https://github.com/astral-sh/uv
- uv 管理的 Python standalone：Python 及附带依赖各自许可；https://github.com/astral-sh/python-build-standalone
- PyTorch / torchaudio 及 Python 依赖：以各安装包许可证为准；https://github.com/pytorch/pytorch 和 https://github.com/pytorch/audio

- Node.js：https://github.com/nodejs/node/blob/main/LICENSE
- PowerShell：https://github.com/PowerShell/PowerShell/blob/master/LICENSE.txt
- DeepSeek Harness：https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE
- QQ Bridge：https://github.com/Derpyu520/qq-bridge/blob/main/LICENSE
- SnowLuma：https://github.com/SnowLuma/SnowLuma/blob/main/LICENSE 和 https://github.com/SnowLuma/SnowLuma/blob/main/EULA.md

QQ Bridge 使用的 `@snowluma/sdk` / `@snowluma/mcp` 许可声明及包内许可文件情况见桥接上游 LICENSE 的相关说明。它们在用户执行部署时由 npm 安装，不作为本工具安装包内置组件。

本项目与腾讯、QQ、DeepSeek、SnowLuma、微软无隶属或官方背书关系。软件商标归各自权利人所有。
