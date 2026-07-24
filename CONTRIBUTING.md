# Contributing to AI Subtitle Studio

感谢你愿意改进 AI Subtitle Studio。提交代码即表示你有权贡献这些内容，并同意按本项目
的 Apache License 2.0 发布。

## 开始之前

- 讨论较大的功能或架构改动前，请先创建 Issue。
- 不要提交视频、音频、模型权重、运行日志、任务快照、`.env` 或其他用户数据。
- 测试素材必须允许公开再分发，并在 PR 中说明来源及许可证。
- 一个 PR 尽量只解决一个问题；同时更新相关测试和文档。

## 开发环境

需要 Windows 10/11、Python 3.12 和 Node.js 20+。在仓库根目录运行：

```powershell
.\scripts\setup.ps1
.\scripts\start.ps1
```

需要可选的 WhisperX 音频轨时：

```powershell
.\scripts\setup.ps1 -WithWhisperX
```

安装脚本会在 `ai_service/.venv` 创建 Python 虚拟环境，并分别使用两个
`package-lock.json` 安装 Node.js 依赖。

## 提交前验证

```powershell
.\ai_service\.venv\Scripts\python.exe -m pytest ai_service\tests -q

Push-Location backend
npm test
Pop-Location

Push-Location frontend
npm run lint
npm run test
npm run build
Pop-Location
```

如果改动 OCR、时间边界或 PTS 映射，还应使用有合法授权的本地素材完成相应真实回归；
不要把素材或生成的运行数据提交到仓库。

## Pull Request

PR 描述应说明：

- 改了什么以及为什么；
- 如何验证；
- 是否改变 API、配置、数据格式或模型依赖；
- UI 改动前后的截图（如适用）；
- 新增测试素材的来源及再分发许可（如适用）。
