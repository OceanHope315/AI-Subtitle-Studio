# AI Subtitle Studio 架构说明

## 1. 设计目标

当前版本保证“上传—框选字幕区域—处理—人工校对—保存—导出”闭环稳定。OCR 是画面
硬字幕和时间边界的唯一事实来源；Whisper 只允许对长度相近、语义兼容的当前视觉事件
校字，不会独立补充字幕、改变时间轴或复制后续语音。

## 2. 组件关系

```mermaid
flowchart LR
    U["用户浏览器"] -->|"MP4 / 编辑操作"| F["React + Vite"]
    F -->|"REST / HTTP Range / SSE / JPEG"| B["Express Backend"]
    B -->|"VideoTask"| M[("MongoDB")]
    B -.->|"本地开发降级"| J[("JSON Store")]
    B -->|"POST job + polling / event replay"| A["FastAPI AI Service"]
    A --> V["PyAV PTS Reader"]
    A --> O["PaddleOCR Adapter"]
    A --> W["faster-whisper Adapter"]
    O --> G["Temporal Grouper"]
    W --> G
    G --> S["subtitle.json / output.srt"]
    A --> P[("progress JSONL")]
    A --> I["transient / evidence JPEG"]
    B --> E["final.srt"]
```

## 3. 任务状态流

```mermaid
stateDiagram-v2
    [*] --> awaiting_roi: Express 保存视频与任务
    awaiting_roi --> queued: 用户确认归一化字幕框
    queued --> processing: 提交 FastAPI job
    processing --> processing: 轮询进度 / 持久化快照
    processing --> completed: 字幕和产物生成
    processing --> failed: 模型、视频或服务错误
    queued --> failed: 提交失败或超时
    completed --> completed: 人工编辑并重建 final.srt
```

Express 是产品任务的事实来源；FastAPI 的 JSON job 快照用于 AI 服务重启诊断。后端
重启后会恢复 `queued` / `processing` 任务；`awaiting_roi` 不会被后台误启动。框选到入队
使用原子状态转换，重复或并发确认返回 409，不会重复创建 AI job。

前端路由固定为 `/tasks`、`/tasks/new`、`/tasks/:id`。URL 是当前任务的事实来源，
不再用 `replaceState` 清除 query；因此刷新、Logo 返回、前进和后退不会销毁任务历史。
归档只设置 `archivedAt` 并从默认列表隐藏任务，不删除视频或字幕产物。

## 4. AI 流水线

1. `VideoReader.probe` 用 PyAV 解码呈现顺序，读取原始 PTS、time base、非零起点、精确
   帧数与时长，并检测 VFR；API 秒值统一由 `(pts - start_pts) * time_base` 派生。
2. `sampled_frames` 按 PTS 采样，仅在采样点转换图像并裁剪用户的任意 x/y/w/h ROI；
   当前真实样例的推荐初始框为 `{x:0.08,y:0.52,width:0.84,height:0.24}`。
3. `PaddleOCREngine` 懒加载模型，兼容 PaddleOCR 2.x 与 3.x 输出结构。
4. 手动 ROI 内保留全部合格候选及其原画面坐标；同帧的重叠备选、同基线碎片和上下行
   字幕先组成可跟踪的完整视觉短语；纯数字仍被过滤，`AND` 等短字幕保留。
5. 多轨时序关联处理同帧多候选、逐词动画、短暂漏帧、嵌套重复和位置一致性；额外的
   廉价视觉变化扫描会在 2 FPS 粗采样间隙中发现 `WATCH OUT` 这类短事件。
6. faster-whisper 生成逐词时间戳，按标点、停顿和最大阅读时长重新断句。
7. 每个粗边界先扫描 64×32 灰度视觉差分，仅在最可能的变化点调用少量 OCR；默认每个
   起点/终点最多新增 2 次 OCR，无法确认时安全保留粗边界。
8. 融合器逐个复制 OCR 事件及其时间/位置，只从 Whisper 的相近长度窗口选择兼容校字。
9. 原始视觉事件、最终结果和诊断分别写入 `ocr_events.json`、`subtitle.json`、
   `output.srt` 与 `diagnostics.json`。

所有 cue 采用 `start` 包含、`end` 不包含，持久化 `start_frame`、
`end_frame_exclusive`、`start_pts`、`end_pts`、`time_base`。`start_time/end_time` 只作为
API、SRT 和 UI 的派生值；人工修改秒边界时前端会清除已失效的原始 PTS 字段。

浏览器预览不用低频 `timeupdate`。`requestVideoFrameCallback` 的 `mediaTime` 驱动二分
查找和时间轴 DOM；不支持时回退到 `requestAnimationFrame + currentTime`。只有命中的
cue id 变化才触发 React state，播放、暂停、seek、拖动和字幕跳转另做立即同步。

### 4.1 P1-A 进度数据面

每次 AI 运行在任务入队时即取得 32 位 `run_id`。`EventLogStore` 对该运行写独立 JSONL，
在文件内分配从 1 开始、严格递增的 `seq`。事件统一包含 `task_id/run_id/seq/type`、UTC
时间、进度、消息和类型化 payload；当前发布：

- `stage.progress`：七阶段、总体/阶段工作量和已知字幕数。
- `frame.analyzed`：真实解码帧号、PTS、time base、媒体时间、归一化 ROI、原视频全局
  坐标的原始 PaddleOCR 候选，以及可选的原帧/ROI preview ID。
- `cue.upserted`：当前真实 cue 与精确已知总数；未在前端或任务快照中累积 cue 历史。
- `job.completed` / `job.failed`：终态。completed 只暴露逻辑产物名，不广播磁盘路径。

Express 的 `ProgressEventHub` 让同一 task 的多个浏览器共享一次 FastAPI 短轮询，并把
结果广播为 SSE。游标既接受 `after_seq`，也接受 `Last-Event-ID: run_id:seq`。新 run 会
清空旧游标；重复事件按 run/seq 丢弃；`has_more` 会立即继续拉取。上游轮询失败或响应
背压会结束该浏览器流，让前端以有限指数退避和最后游标重连；断开只释放订阅和上游
AbortController，不触发任务取消。

`PreviewStore` 在 OCR 完成后才编码真实帧。普通预览按墙钟限频，长边默认 800、JPEG
quality 80，每个 run 最多保留 8 个“原帧 + ROI”bundle；先写临时文件再原子替换。
只有双 JPEG 与 bundle manifest 全部提交才进入环形索引；manifest 写入失败会回滚两张
JPEG，避免产生无法淘汰的游离文件。
边界 OCR evidence 使用独立目录且不占普通环形槽。终态清空普通预览并释放 JSONL 热
缓存；evidence 与 JSONL 留作审计/恢复。多遍流水线（例如边界精修）会真实 seek 旧帧，
因此 `seq` 全局单调，而 frame/PTS 单调性按每个 stage/pass 验证，绝不伪造媒体时间。

## 5. 数据模型

任务主要字段：

```json
{
  "taskId": "uuid",
  "filename": "video.mp4",
  "status": "awaiting_roi",
  "progress": 45,
  "roi": { "x": 0.08, "y": 0.52, "width": 0.84, "height": 0.24 },
  "metadata": { "fps": 30, "width": 1920, "height": 1080, "duration": 60 },
  "subtitles": [],
  "revision": 0,
  "archivedAt": null,
  "error": null,
  "progressSnapshot": {
    "run_id": "0123456789abcdef0123456789abcdef",
    "latest_seq": 54,
    "latest_event": {},
    "latest_frame_event": {},
    "latest_preview_event": {}
  }
}
```

字幕主要字段：

```json
{
  "id": "uuid",
  "text": "Subtitle text",
  "start_time": 0.0,
  "end_time": 2.0,
  "start_frame": 0,
  "end_frame_exclusive": 60,
  "start_pts": 400,
  "end_pts": 24400,
  "time_base": "1/12000",
  "confidence": 0.95,
  "position": [100, 600, 900, 680],
  "source": "ocr+whisper"
}
```

所有保存操作都校验非负时间、`end_time > start_time`、置信度、坐标与独占帧边界，
按开始时间排序后原子重建 JSON/SRT。旧任务没有 revision 时按 0 读取，不需要批量迁移。

## 6. API 边界

Express 面向浏览器：

- `POST /api/tasks`
- `POST /api/tasks/:id/start`
- `GET /api/tasks?page=&limit=&status=&search=`（轻量摘要）、`GET /api/tasks/:id`
- `GET|PUT /api/tasks/:id/subtitles`
- `PATCH /api/tasks/:id/archive`
- `GET /api/tasks/:id/video`
- `GET /api/tasks/:id/export`
- `GET /api/tasks/:id/events`（SSE，支持 `after_seq` / `Last-Event-ID`）
- `GET /api/tasks/:id/previews/:preview_id?run_id=...`（完整 JPEG 代理）

FastAPI 面向 Express：

- `POST /jobs`
- `GET /jobs/:task_id`
- `GET /jobs/:task_id/subtitles`
- `GET /jobs/:task_id/artifacts/:name`
- `GET /jobs/:task_id/events?after_seq=...`
- `GET /jobs/:task_id/previews/:preview_id?run_id=...`
- `GET /health`

## 7. 安全与可靠性

- 后端同时检查扩展名、MIME 与 MP4 `ftyp`，并限制上传大小与 multipart 数量。
- 服务端 UUID 决定磁盘文件名，原文件名不参与路径；视频读取前再次验证路径边界。
- 视频端点支持单 Range，越界返回 416。
- CORS 使用 allowlist，Express 启用 Helmet 和统一错误结构。
- Mongo 连接失败可配置为启动失败；本地默认明确告警后降级 JSON。
- 字幕保存必须携带 `If-Match`/expected revision；文件仓库和 Mongo 仓库都执行原子比较
  更新，旧标签页返回 409。前端 750ms 自动保存，网络失败按 taskId 写 IndexedDB。
- SPA 路由离开脏编辑器时提供“保存并离开 / 放弃修改 / 取消”；真正关闭标签页仍使用
  浏览器原生 `beforeunload` 保护。
- AI 模型懒加载，错误进入 job 的 `failed/error`，不使 API 进程退出。
- job 和文件写入使用单任务 worker 与原子替换，第一版避免同一 CPU 同时加载多份模型。
- P1-A 重启恢复只在 FastAPI lifespan 启动阶段执行，模块导入和 pytest 收集不会改写
  job。中断的普通运行持久化为 failed；已写完产物但尚未完成终态提交的运行通过内部
  write-ahead marker 收敛为 completed。恢复先检查 JSONL 尾部，避免重复终态事件，并
  幂等清理所有终态 run 的普通预览；即使事件或清理暂时失败，已持久化的成功结果仍立即
  对外显示 completed，隐藏 marker 留待下次启动重试。没有 `run_id` 的旧任务不迁移、
  不改写。事件或预览写入失败属于 best-effort 可观测性故障，不会阻断 OCR 与字幕产物。

## 8. 已知边界

- Web 当前要求人工框选 ROI；自动区域建议属于可选 V2 能力。
- YOLO 不是严格时间轴的必要组件。当前方案由手动 ROI 限定字幕带、PaddleOCR text
  detector 定位文字，再由逐帧视觉变化和受预算约束的 OCR 精修边界。YOLO 只能作为
  自动估计 ROI 的可选前置步骤，而且需要针对目标字幕样式训练并评测定制数据/权重。
- 当前单 AI worker 适合本地 MVP，不是多租户生产队列。
- IndexedDB 草稿只存在当前浏览器 profile；它不是跨设备版本历史。冲突草稿会保留，
  但当前 UI 不提供逐行三方合并。
- PaddleOCR 第一次运行需要模型下载；CPU 推理速度与分辨率、FPS 直接相关。
- JSONL 与 evidence 当前没有 TTL、压缩或自动归档；普通预览虽有环形上限并在终态清理，
  生产部署仍需按保留期将审计数据迁移到对象存储或删除。
- P1-B 的“边分析边编辑”和翻译事件/UI 尚未实现；`translation.upserted` 仅保留协议名额。
- 已建立完整 2,380 帧视频的 58 状态人工视觉真值：五个 Tier A 事件为相邻帧精确复核，
  其余 Tier B 边界声明 ±18 帧不确定度。整片评测不能被描述成全部单帧精确；语音参考
  也不得代替硬字幕 precision/recall、文本准确率和边界误差真值。
