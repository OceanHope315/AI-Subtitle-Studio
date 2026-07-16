# AI Subtitle Studio AI Service

FastAPI 服务负责 OpenCV 视频读取、PaddleOCR 硬字幕检测、faster-whisper 辅助、时序
融合以及 JSON/SRT 产物生成。

## 启动

```powershell
python -m pip install -r requirements.txt
copy .env.example .env
python main.py
```

默认地址为 `http://127.0.0.1:8000`，OpenAPI 文档为 `/docs`。

## API

- `GET /health`：进程与模型依赖诊断（不会提前加载大模型）。
- `POST /jobs`：multipart 字段 `video`、可选 `task_id`、`language`、
  `sample_fps`、`enable_whisper`，以及成组提供的归一化字幕框 `roi_x`、
  `roi_y`、`roi_width`、`roi_height`。坐标相对于原视频画面，范围为 0 到 1。
- `GET /jobs/:task_id`：任务状态、进度、元数据、字幕和错误。
- `GET /jobs/:task_id/subtitles`：字幕 JSON。
- `GET /jobs/:task_id/artifacts/ocr_events.json`
- `GET /jobs/:task_id/artifacts/subtitle.json`
- `GET /jobs/:task_id/artifacts/output.srt`
- `GET /jobs/:task_id/artifacts/diagnostics.json`：ROI、采样率、精修 OCR 预算/调用数及
  最终视觉事件帧边界与置信度。

任务状态为 `queued`、`processing`、`completed` 或 `failed`。AI worker 默认为 1，避免
CPU 环境并行加载多份 Paddle/Whisper 模型。

## CLI

```powershell
python cli.py VIDEO.mp4 --output OUTPUT_DIR --ground-truth REFERENCE.srt
```

用 `--no-whisper` 可验证 OCR-only 路径，用 `--sample-fps` 调整采样密度。
可用 `--roi X Y WIDTH HEIGHT` 指定归一化字幕框；不指定时保留原有
`OCR_ROI_TOP`/`OCR_ROI_BOTTOM` 默认区域。

当前 1080×1920 真实测试素材使用的手动 ROI 为：

```powershell
python cli.py VIDEO.mp4 --roi 0.08 0.52 0.84 0.24 --output OUTPUT_DIR
```

管线以 OCR 视觉事件决定字幕条数和时间轴，并在粗抽帧后只对事件边界逐帧回扫。
Whisper 仅校正长度相近且语义兼容的文字，不会独立创建字幕或扩写后续语句。
边界回扫对所有帧只计算低分辨率视觉变化，并通过 `BOUNDARY_OCR_BUDGET`
限制每个起点/终点新增的 OCR 次数（默认 2）；无法在预算内确认时保留粗边界。
为发现完全落在粗采样间隔内的短字幕，服务会对字幕带做一次廉价变化扫描，并只对
未被粗采样覆盖的短稳定区间执行代表帧 OCR；`DISCOVERY_OCR_BUDGET`（默认 24）
是整段视频的新增 OCR 硬上限。

完整 2,380 帧、39.7063 秒样例回归实际使用 80 次粗采样 OCR、20 次短事件发现 OCR、
137 次边界 OCR 和 14 个 Whisper 校字窗口，约 534 秒且无警告。最终时间轴相对 58
状态人工视觉真值检出 57 条，Precision 1.0000、Recall 0.9828、F1 0.9913；匹配文本
57/57 normalized exact，开始边界 MAE 1.053 帧、最终结束边界 MAE 0.351 帧，Tier A
5/5 精确，误报与最终时间重叠均为 0。唯一漏检是第 13–21 帧约 0.15 秒的开场入场
动画，OCR 当时未得到完整可读文字，管线不会从后续帧凭空补字。

复现视觉评估：

```powershell
python ..\scripts\evaluate-visual-timeline.py `
  ..\data\ground_truth\test-video.visual.json `
  ..\data\subtitles\test-video\subtitle.json `
  --output ..\data\subtitles\test-video\visual-evaluation.json
```

YOLO 不是严格时间轴的必要依赖：手动 ROI 先限定字幕带，PaddleOCR text detector 定位
其中的文字，视觉变化与边界 OCR 决定起止帧。YOLO 只适合作为可选的自动 ROI 建议器，
并需要按目标字幕样式训练和验证定制数据/权重；即使加入，也不能替代后续时间轴精修。

## 测试

```powershell
python -m pytest tests -q
```

当前自动化结果为 67/67 通过。

PaddleOCR 3.x 在部分 Windows CPU 上默认 oneDNN/PIR 路径会失败；适配器在导入 Paddle
之前设置兼容标志，并显式使用 mobile detection/recognition 模型与 `enable_mkldnn=False`。
