# AI Subtitle Studio
<img width="1672" height="941" alt="image" src="https://github.com/user-attachments/assets/e81423f3-a285-4c56-baa5-6f88d062601e" />

AI Subtitle Studio 是一个完整可运行的 AI 视频字幕辅助制作平台。它以 PaddleOCR
检测画面硬字幕，用 faster-whisper 在视觉事件内受限校字，通过网页完成 ROI 框选、
任务恢复、校对、逐帧时间轴检查、自动保存与 SRT 导出。

本项目是从旧 Tkinter 原型重新设计的新工程；旧目录 `D:\new project` 未被修改。
详细审查见 [旧项目代码审查报告](docs/OLD_PROJECT_REVIEW.md)。

## 已实现的产品闭环

1. React 页面拖放或选择 MP4；上传后任务停在 `awaiting_roi`。
2. 用户在真实视频内容上拖拽、移动或缩放字幕框，确认后才启动识别。
3. Express 校验并持久化归一化 ROI，原子地将任务入队并提交 AI 服务。
4. FastAPI 只裁剪用户框选区域，粗抽帧发现视觉字幕并保留全部 OCR 候选。
5. 视觉变化扫描定位边界，再以固定 OCR 预算精修到接近源视频单帧。
6. OCR 决定字幕条数和时间轴；faster-whisper 只能在当前视觉事件内受限校字。
7. `/tasks` 任务中心可恢复全部状态；Logo、新建、刷新和浏览器前进/后退都由正式路由管理。
8. 播放器用呈现帧 `mediaTime` 切换预览字幕，并支持逐帧前后移动和全片/5 秒/1 秒时间轴。
9. 字幕修改 750ms 防抖自动保存；失败时按 taskId 写 IndexedDB，revision 冲突返回 409。

## 架构

```text
React + Vite :5173
        │ REST / Range
Express :3001 ───── MongoDB（推荐）/ JSON 文件降级
        │ 异步 job + polling
FastAPI :8000
        ├── PyAV PTS 视频读取与抽帧
        ├── PaddleOCR 硬字幕检测
        └── faster-whisper 文本校验与断句
```

更完整的状态流、数据模型和设计取舍见 [架构说明](docs/ARCHITECTURE.md)。

## 目录

```text
AI-Subtitle-Studio/
├── frontend/                   React + Vite Web 字幕编辑器
│   └── src/
│       ├── api/                后端 API 封装
│       ├── components/         上传、播放器、字幕表、时间轴
│       ├── hooks/              任务轮询
│       ├── pages/              任务中心、上传与任务工作区
│       └── utils/              时间、字幕校验与 IndexedDB 草稿
├── backend/                    Express 编排服务
│   ├── routes/                 任务、字幕、视频和导出 API
│   ├── models/                 Mongoose VideoTask
│   ├── services/               AI 客户端、任务仓库、SRT 服务
│   ├── middleware/             统一错误处理
│   └── test/                   Node 原生测试
├── ai_service/                 FastAPI AI 服务
│   ├── video/                  PyAV PTS 读取、抽帧和边界映射
│   ├── ocr/                    PaddleOCR 2.x/3.x 适配器
│   ├── whisper/                faster-whisper 适配器
│   ├── alignment/              OCR 时序聚合与 OCR/ASR 融合
│   ├── subtitle/               JSON、SRT 与字幕指标
│   ├── evaluation/             视觉时间轴真值评估器
│   └── tests/                  Pytest 测试
├── data/
│   ├── videos/                 AI 服务运行时视频
│   ├── subtitles/              OCR、JSON 与 SRT 产物
│   ├── ground_truth/            人工逐帧视觉字幕真值
│   └── jobs/                   AI job 快照
├── docs/                       审查、架构、测试与实施记录
├── scripts/                    安装与样例评测脚本
└── docker-compose.yml          可选 MongoDB
```

## 环境要求

- Windows 10/11（当前实测环境）；Linux/macOS 也可运行
- Python 3.12
- Node.js 20+
- MongoDB 6+（推荐但非启动必需）
- 首次 PaddleOCR / Whisper 运行需下载模型；之后可离线推理

当前 Windows 上 PaddlePaddle 3.x 的 oneDNN/PIR 兼容开关已在代码中处理。

## 一次性安装

可在项目根目录执行：

```powershell
.\scripts\setup.ps1
```

也可以分别安装：

```powershell
cd D:\AI-Subtitle-Studio\ai_service
python -m pip install -r requirements.txt

cd D:\AI-Subtitle-Studio\backend
npm install

cd D:\AI-Subtitle-Studio\frontend
npm install
```

建议为 Python 创建虚拟环境后再安装依赖。

## 启动

打开三个 PowerShell 终端。

AI Service：

```powershell
cd D:\AI-Subtitle-Studio\ai_service
python main.py
```

Backend：

```powershell
cd D:\AI-Subtitle-Studio\backend
copy .env.example .env
npm run dev
```

Frontend：

```powershell
cd D:\AI-Subtitle-Studio\frontend
copy .env.example .env.local
npm run dev
```

打开 `http://localhost:5173`，根路径会进入 `/tasks` 任务中心。服务健康检查分别为：

- `http://localhost:8000/health`
- `http://localhost:3001/api/health`

### 使用 MongoDB

```powershell
cd D:\AI-Subtitle-Studio
docker compose up -d mongo
```

在 `backend/.env` 中设置：

```env
MONGODB_URI=mongodb://127.0.0.1:27017/ai_subtitle_studio
```

未配置 MongoDB 或连接失败时，后端会明确提示并降级到
`data/tasks.json`；这让本地 MVP 仍可完整运行。多实例或生产部署必须使用
MongoDB 与共享对象存储。

## 使用真实样例评测

默认脚本使用用户提供的旧项目测试素材，并采用前端为该素材预置的手动 ROI
`{x:0.08,y:0.52,width:0.84,height:0.24}`：

```powershell
.\scripts\evaluate-test-video.ps1
```

等价命令：

```powershell
python ai_service\cli.py `
  "D:\new project\test\testVideo.mp4" `
  --roi 0.08 0.52 0.84 0.24 `
  --ground-truth "D:\new project\test\testVideo.txt" `
  --output "D:\AI-Subtitle-Studio\data\subtitles\test-video"
```

产物：

- `data/subtitles/test-video/ocr_events.json`
- `data/subtitles/test-video/subtitle.json`
- `data/subtitles/test-video/output.srt`
- `data/subtitles/test-video/diagnostics.json`

用整片 58 状态人工视觉真值评测最终时间轴：

```powershell
python scripts\evaluate-visual-timeline.py `
  data\ground_truth\test-video.visual.json `
  data\subtitles\test-video\subtitle.json `
  --output data\subtitles\test-video\visual-evaluation.json
```

## 当前实测结果

在 1080×1920、2,380 帧、39.7063 秒的真实 `testVideo.mp4` 整片上：

- 上传后保持 `awaiting_roi`；用户确认前不会创建 FastAPI job，确认后才进入 `queued`
- ROI 从 React → Express → FastAPI 原样持久化为
  `{x:0.08,y:0.52,width:0.84,height:0.24}`
- 58 条人工视觉状态中检出 57 条：Precision 1.0000、Recall 0.9828、F1 0.9913
- 57/57 个匹配事件的归一化文本完全一致；无误报、无最终字幕时间重叠
- 开始边界 MAE 1.053 帧，最终结束边界 MAE 0.351 帧
- Tier A 的五个相邻帧复核事件 5/5 起止边界完全一致
- `WATCH OUT` 为 `21.104–21.438s`；`PROTECT YOURSELF` 为
  `29.546–30.330s`，没有附加后续语音句子
- 唯一漏检是第 13–21 帧、约 0.15 秒的开场文字入场动画；这些帧中的 OCR 文字尚未
  完整可读，系统选择不凭空补字
- 完整 CPU 回归使用 80 次粗采样 OCR、20 次短事件发现 OCR、137 次边界 OCR 和
  14 个 Whisper 校字窗口，无警告，耗时约 534 秒
- P0 时间校准使用 PyAV 原始 PTS；目标 Byron 视频实测为 29.97 FPS、`time_base=1/11988`、
  `start_pts=400`。相邻源帧 762/763 正好从 `AND HEAL THEM` 切到 `WHEN YOU CAN`；映射
  边界为 25.458792 秒，相对旧 25.460 秒误差 1.208ms，小于一个 33.367ms 呈现帧
- AI / Backend / Frontend 自动化测试分别为 70 / 17 / 40 项；compile、lint 与生产构建通过
- 隔离任务库的真实 HTTP 验收恢复了目标历史任务的 88 条字幕；分页轻量摘要、刷新路由、
  revision 0→1、第二标签式旧版本 409、后端重启后 revision/字幕恢复均通过

这里的检出率来自 `data/ground_truth/test-video.visual.json` 的逐事件视觉真值；
`testVideo.txt` 仍只是语音粗转写，不能代替硬字幕真值。Tier A 是逐相邻帧精确复核，
其余 Tier B 边界带有 ±18 帧标注不确定度，因此不能把整片结果描述成“100% 单帧精确”。
完整证据和限制见 [测试报告](docs/TEST_REPORT.md)。

## 测试命令

```powershell
cd D:\AI-Subtitle-Studio\ai_service
python -m pytest tests -q

cd D:\AI-Subtitle-Studio\backend
npm test

cd D:\AI-Subtitle-Studio\frontend
npm run lint
npm run test
npm run build
```

## 配置

- AI：`ai_service/.env.example`
- Backend：`backend/.env.example`
- Frontend：`frontend/.env.example`

AI 服务默认 2 FPS 粗采样、每个起止边界最多新增 2 次 OCR、Whisper 模型为 `small`
CPU/int8。Web 工作流使用手动框选 ROI；当前测试素材的推荐初始框为
`0.08 0.52 0.84 0.24`。CLI 未传 `--roi` 时才使用
`OCR_ROI_TOP`/`OCR_ROI_BOTTOM` 的兼容默认区域。可用 `SAMPLE_FPS` 和
`BOUNDARY_OCR_BUDGET` 调整速度/边界确认预算。

严格时间轴不要求 YOLO：手动 ROI 先限定字幕带，PaddleOCR 的文字检测器在框内定位
文字，视觉变化与边界 OCR 再决定出现/消失帧。YOLO 只适合做可选的自动字幕区域估计；
若启用，需要针对目标视频样式准备并验证定制标注数据和权重，不能拿通用目标检测模型
直接替代上述时间轴逻辑。

## 后续路线

- V2：可选字幕区域自动估计、批量 PaddleOCR、扩充更多视频样式的视觉真值集。
- V3：WhisperX 词级对齐、OCR/ASR 动态规划融合、GPU worker 与任务队列。
- V4：翻译、术语库、多人协作、版本历史、对象存储和云端部署。
