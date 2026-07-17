# 实施记录

| 修改范围 | 修改内容 | 修改原因 |
| --- | --- | --- |
| `docs/OLD_PROJECT_REVIEW.md` | 扫描旧代码、日志、测试和输出并量化失败 | 先吸收旧经验且不修改旧项目 |
| `ai_service/video/` | OpenCV 元数据探测、顺序抽帧、ROI 裁剪 | 建立稳定且可测的视频输入层 |
| `ai_service/ocr/` | PaddleOCR 懒加载、2.x/3.x 解析、Windows CPU 兼容、候选过滤 | 替代旧项目千行耦合 OCR 规则 |
| `ai_service/whisper/` | faster-whisper 逐词时间戳、断句与短尾合并 | 用 ASR 辅助 OCR 文本和断句 |
| `ai_service/alignment/` | 动画字幕时序聚合、位置一致性、OCR/ASR 融合 | 减少旧项目过切分、空洞和贪心错配 |
| `ai_service/subtitle/` | JSON/SRT 生成、解析与代理评测 | 形成标准产物和可回归指标 |
| `ai_service/main.py` | FastAPI health、异步 job、进度、产物接口 | 与 Express 解耦长耗时推理 |
| `ai_service/job_store.py` | 线程安全内存状态和原子 JSON 快照 | 支持重启诊断及本地运行 |
| `ai_service/cli.py`、`evaluation/visual_timeline.py` | 离线处理与 58 状态视觉时间轴评测命令 | 无需启动 Web 即可复现实验与严格指标 |
| `ai_service/tests/` | 67 项视频、ROI、OCR 组合、短事件、边界、融合、评估器和 SRT 测试 | 固化关键算法行为 |
| `backend/models/VideoTask.js` | Mongoose 任务与字幕 schema | 满足 MongoDB 数据模型需求 |
| `backend/services/taskStore.js` | Mongo repository 与 JSON 降级 | Mongo 缺失时仍能启动完整闭环 |
| `backend/services/aiClient.js` | 视频提交和 job 查询 | 对接 FastAPI |
| `backend/services/taskProcessor.js` | 异步轮询、恢复、超时与状态同步 | 避免 HTTP 上传请求阻塞数分钟 |
| `backend/services/subtitleService.js` | 字幕校验、JSON 与 final.srt | 保证编辑保存和导出一致 |
| `backend/routes/tasks.js` | 上传、列表、详情、字幕、Range、导出路由 | 提供完整产品 API |
| `backend/middleware/`、`utils/` | 安全路径、MP4 检查、错误和 DTO | 统一边界校验及前端协议 |
| `backend/test/` | 15 项 API/服务/持久化测试 | 验证两阶段任务、并发确认与降级路径 |
| `frontend/src/api/` | 上传进度、轮询、保存和下载 API | 统一网络错误处理 |
| `frontend/src/components/` | 上传区、进度、播放器、字幕列表、时间轴 | 实现 Web 字幕编辑工作台 |
| `frontend/src/hooks/` | 任务轮询与卸载清理 | 稳定展示长任务状态 |
| `frontend/src/utils/` | 时间解析、字幕规范化和校验 | 防止无效时间轴保存 |
| `frontend/src/**/*.test.*` | 26 项组件、ROI 坐标、API 和工具测试 | 验证编辑器显示、框选与交互 |
| 根目录文档与脚本 | 安装、启动、架构、测试、Mongo Compose | 让项目可交接、可复现 |
| `frontend/src/components/RoiSelectionPanel.jsx`、`utils/roi.js` | 视频内容坐标上的拖框、移动、八向缩放、黑边换算与遮罩 | 上传后先人工排除 HUD，再启动识别 |
| `backend/routes/tasks.js`、`services/taskStore.js` | `awaiting_roi` 两阶段状态、原子 `/start`、ROI 校验与持久化 | 防止确认前识别及重复入队 |
| `ai_service/video/reader.py`、`main.py` | 任意归一化 ROI 裁剪、全局坐标恢复、API/CLI 传递 | 让前端框选真正约束 PaddleOCR 输入 |
| `ai_service/alignment/temporal.py` | 全候选多轨关联、短字幕、嵌套去重、视觉事件主导的受限 Whisper 校字 | 禁止把后续语音扩进当前硬字幕 |
| `ai_service/pipeline.py` | 粗采样、低分辨率视觉变化扫描、固定 OCR 预算边界精修、诊断产物 | 接近单帧边界且避免数千次 CPU OCR |
| `ai_service/ocr/composition.py` | 同帧重叠候选抑制、同基线碎片拼接和多行字幕组合 | 避免半句、重复行和 HUD 候选进入时间轴 |
| `ai_service/pipeline.py` 短事件发现 | 粗采样间隙低成本变化扫描与全片 OCR 硬预算 | 找回 `WATCH OUT` 等短于采样间隔的字幕 |
| `ai_service/evaluation/visual_timeline.py`、`scripts/evaluate-visual-timeline.py` | 单调一对一事件匹配、文本/检测/帧边界/Tier A 指标 | 用可复现视觉真值评价最终产物 |
| `data/ground_truth/test-video.visual.json` | 完整 2,380 帧的 58 个视觉状态、位置、边界和 A/B 可信等级 | 将视觉真值与 ASR 参考彻底分离 |
| `data/subtitles/test-video/diagnostics.json` | ROI、80 次粗 OCR、20 次发现 OCR、137 次边界 OCR 及最终事件 | 保存完整真实回归的可审计证据 |
| `frontend/src/App.jsx`、`pages/TasksPage.jsx`、`pages/NewTaskPage.jsx`、`pages/TaskWorkspace.jsx` | 正式 `/tasks` 路由、轻量任务中心、全状态恢复、归档与安全离开 | 修复 query/replaceState 导致的历史任务不可恢复 |
| `frontend/src/components/VideoPanel.jsx`、`Timeline.jsx`、`pages/EditorPage.jsx` | `requestVideoFrameCallback(mediaTime)`、RAF 回退、二分 cue 命中、帧步进与全片/5秒/1秒缩放 | 消除 `timeupdate` 带来的 100–200ms 预览滞后 |
| `frontend/src/utils/draftStore.js`、`SafetyDialogs.jsx` | 750ms 自动保存、IndexedDB task 草稿、恢复提示、saving/synced/offline/conflict 状态 | 防止网络失败、刷新和离开页面丢失字幕修改 |
| `backend/routes/tasks.js`、`services/taskStore.js`、`models/VideoTask.js` | 分页/筛选/搜索摘要、软归档、revision/If-Match 原子更新与 409 | 列表不再传全部字幕，多标签不再静默覆盖 |
| `ai_service/video/reader.py`、`schemas.py`、`pipeline.py` | PyAV 呈现顺序 PTS、非零起点/VFR、独占结束帧和原始 PTS cue | 移除 `frame_index/fps` 作为真实时间基的线性漂移风险 |
| P0-A/P0-B 测试 | AI 70、Backend 17、Frontend 40；真实隔离 HTTP 恢复/冲突/重启；目标边界相邻帧复核 | 固化本轮时间校准、任务恢复和保存安全 |
