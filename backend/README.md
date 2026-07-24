# AI Subtitle Studio Backend

Express 后端负责视频上传、任务持久化、AI 服务编排、字幕编辑、SRT 导出和浏览器视频流。

## 环境要求

- Node.js 20+
- 可选：MongoDB 6+
- AI Service 默认运行在 `http://127.0.0.1:8000`

## 安装与启动

```bash
cd backend
npm install
copy .env.example .env
npm run dev
```

生产式启动：

```bash
npm start
```

默认 API 地址为 `http://127.0.0.1:3001`。健康检查：

```bash
curl http://127.0.0.1:3001/api/health
```

## 持久化模式

- 未设置 `MONGODB_URI`：直接使用项目根目录的 `data/tasks.json`，可开箱运行。
- 设置 `MONGODB_URI` 且连接成功：使用 Mongoose `VideoTask` model。
- 设置了 MongoDB 但无法连接：默认打印明确警告并降级到 JSON 文件库。
- 如需 MongoDB 连接失败时中止启动，设置 `MONGODB_FALLBACK_TO_FILE=false`。

上传视频保存在项目根目录的 `data/videos/`；字幕 JSON 和 `final.srt` 保存在
`data/subtitles/<task-id>/`。这些目录均可通过环境变量覆盖。

JSON 文件持久化适合单实例本地开发；多实例或生产环境应使用 MongoDB 和共享对象存储。

## API

### 创建任务

```http
POST /api/tasks
Content-Type: multipart/form-data

video=<MP4 file>
```

只接受字段名 `video`、`.mp4` 扩展名和 MP4 MIME 类型，并检查文件中的 MP4 `ftyp`
标记。上传大小默认上限 1024 MB，可用 `MAX_UPLOAD_MB` 调整。成功返回 `201` 和任务 DTO；
新任务处于 `awaiting_roi`，此时不会提交给 AI 服务。

### 框选字幕区域并开始任务

```http
POST /api/tasks/:id/start
Content-Type: application/json

{
  "roi": { "x": 0.1, "y": 0.62, "width": 0.8, "height": 0.22 }
}
```

ROI 使用相对于视频有效画面的归一化坐标，所有值必须位于 `0..1`，区域必须完整落在
画面内，宽高均不得小于 `0.01`。成功返回 `202`，任务原子地转为 `queued` 并入队。
同一任务重复或并发开始会返回 `409 TASK_STATE_CONFLICT`，不会重复入队。

### 查询任务

```http
GET /api/tasks
GET /api/tasks/:id
```

列表响应为 `{ "tasks": [...] }`。任务状态为：

- `queued`
- `processing`
- `completed`
- `failed`

上传后的完整状态顺序为 `awaiting_roi` → `queued` → `processing` → `completed` / `failed`。

任务 DTO 同时返回 `id` 和 `task_id`，以及 `filename`、`status`、`progress`、
`metadata`、`subtitles`、`error`、时间戳和各资源 URL。

双来源任务另外返回 `visual_status` / `audio_status`、`visual_progress` /
`audio_progress`、各自的错误与字幕数量。视觉和音频任务独立运行；两者都终止且至少一轨
成功时父任务为 `completed`，两轨都失败时才为 `failed`。其中一轨失败不会清空另一轨。

详情 DTO 还返回轻量的 `progress_snapshot`（`run_id`、`latest_seq`、
`latest_event`、`latest_frame_event`、`latest_preview_event`）及同名顶层兼容字段。
它只保存这些最新摘要，不会把事件历史或图片写入
`tasks.json` / MongoDB。任务列表继续使用不含字幕和事件快照的摘要 DTO。

### 实时分析事件（SSE）

```http
GET /api/tasks/:id/events?after_seq=12&run_id=<32-char-run-id>
Last-Event-ID: <run-id>:12
Accept: text/event-stream
```

后端轮询 AI 服务的 `GET /jobs/:task_id/events?after_seq=N`，并按任务复用一个事件
Hub 向浏览器广播。SSE 的 `event` 是协议类型（如 `stage.progress`、
`frame.analyzed`），`data` 是完整结构化事件，`id` 为 `<run_id>:<seq>`。连接可用
查询参数 `after_seq`，或用纯数字 / `<run_id>:<seq>` 形式的 `Last-Event-ID` 补发；
发现 run 已变化时会从新 run 的 0 号游标重放。重复的 `run_id + seq` 不会重复发送。

响应使用 `text/event-stream`、`no-cache, no-transform`、`keep-alive`，默认每 15 秒
发送注释心跳。浏览器断开后会释放订阅、心跳 timer，并在最后一个订阅离开时取消
正在进行的 AI 事件请求；任务处理器本身不会被取消。轮询、心跳和浏览器重试间隔可由
`AI_EVENT_POLL_INTERVAL_MS`、`SSE_HEARTBEAT_MS`、`SSE_RETRY_MS` 调整。
AI 轮询错误或响应背压会主动结束该 SSE，让浏览器携带最后游标重连，而不是无限缓存。

### 分析预览 JPEG

```http
GET /api/tasks/:id/previews/:previewId?run_id=<32-char-run-id>
```

`run_id` 和 `previewId` 都必须是 AI 服务生成的 32 位小写十六进制不透明 ID。
Express 不接受文件路径，并将 task/run/preview 交给 AI 服务再次校验归属，然后只代理
`image/jpeg`。响应采用 `private, max-age=300, immutable`；预览体积很小且 ID
不可复用，因此 Range 请求明确返回 `200` 完整 JPEG（`Accept-Ranges: none`）。浏览器
始终通过 Express 访问图片，不依赖 FastAPI 地址。

### 读取独立来源字幕

```http
GET /api/tasks/:id/visual-subtitles
GET /api/tasks/:id/audio-subtitles
```

视觉响应为 `{ "visual_subtitles": [...] }`，每项包含 `taskId`、`text`、`start`、
`end`、`bbox`、`confidence`。音频响应为 `{ "audio_subtitles": [...] }`，每项保留
句级时间以及 `words[]` 中的 `word/start/end/confidence`。这两个只读来源数组不会自动
写入最终字幕，也不会互相融合或强制对齐。

### 读取和保存字幕

```http
GET /api/tasks/:id/subtitles
PUT /api/tasks/:id/subtitles
Content-Type: application/json

{
  "subtitles": [
    {
      "id": "line-1",
      "text": "Hello",
      "start_time": 0,
      "end_time": 2,
      "confidence": 0.95,
      "position": [10, 20, 300, 80],
      "source": "ocr"
    }
  ]
}
```

保存时会校验时间范围、置信度和坐标，按开始时间排序，并立即重建
`subtitles.json` 与 `final.srt`。

### 导出 SRT

```http
GET /api/tasks/:id/export
```

以附件 `final.srt` 返回 UTF-8 SRT 文件。

### 视频播放

```http
GET /api/tasks/:id/video
Range: bytes=0-1048575
```

支持单段 HTTP byte range，正常返回 `206`、`Content-Range` 和 `Accept-Ranges`。
无 `Range` 时返回完整视频；非法或超界 range 返回 `416`。

## AI Service 协议

确认 ROI 后，后端并行提交两个互相独立的任务。视觉任务继续调用：

```http
POST {AI_SERVICE_URL}/jobs
Content-Type: multipart/form-data

video=<uploaded MP4>
task_id=<UUID>
roi_x=<normalized number>
roi_y=<normalized number>
roi_width=<normalized number>
roi_height=<normalized number>
```

之后以响应中的 `job_id`、`id` 或 `task_id`（依次优先）轮询：

```http
GET {AI_SERVICE_URL}/jobs/:id
```

音频任务使用独立 ID `<task-id>-audio` 调用：

```http
POST {AI_SERVICE_URL}/audio-jobs
GET {AI_SERVICE_URL}/audio-jobs/:id
```

标准 job DTO：

```json
{
  "task_id": "uuid",
  "status": "processing",
  "progress": 45,
  "message": "Running OCR",
  "metadata": { "fps": 30, "width": 1920, "height": 1080, "duration": 60 },
  "visual_subtitles": [],
  "audio_subtitles": [],
  "error": null,
  "artifacts": {}
}
```

后端也兼容旧视觉响应中的 `subtitles`，以及 `{ "job": {...} }`、`{ "data": {...} }`
包裹。两个来源分别持久化和轮询；来源结果不会覆盖带 revision/ETag 的 FinalSubtitle。

实时进度与图片使用：

```http
GET {AI_SERVICE_URL}/jobs/:task_id/events?after_seq=N
GET {AI_SERVICE_URL}/jobs/:task_id/previews/:preview_id?run_id=<run_id>
```

事件响应为 `{ task_id, run_id, latest_seq, events }`，事件公共字段为
`seq/task_id/run_id/type/occurred_at/payload`。图片不进入事件 JSON。

## CORS 和安全设置

- 默认只允许 Vite 的 `localhost:5173` 与 `127.0.0.1:5173`。
- `CORS_ORIGIN` 可设为逗号分隔的 allowlist，或开发环境中的 `*`。
- Helmet 安全响应头、隐藏 Express 标识、JSON body 大小限制。
- 上传名由服务端生成 UUID；原文件名清除控制字符且不会参与磁盘路径。
- 视频读取前验证持久化路径仍位于上传目录内。

## 测试

```bash
npm test
```

测试覆盖上传类型/大小验证、任务 CRUD、字幕校验与 SRT、JSON 文件重启持久化、
AI job 同步、完整/Range 视频流，以及 SSE 响应头、断线续传、新 run 恢复、重复去重、
心跳、断开清理、预览 ID/路径安全和完整 JPEG 代理策略。
