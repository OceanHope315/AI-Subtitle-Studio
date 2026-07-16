# Runtime data

- `videos/`：FastAPI 接收的视频副本。
- `jobs/`：AI job JSON 快照。
- `subtitles/<task-id>/`：`ocr_events.json`、`subtitle.json` 和 `output.srt`。
- `subtitles/test-video/`：使用手动 ROI `{x:0.08,y:0.52,width:0.84,height:0.24}`
  完成的 2,380 帧整片回归产物及视觉评估报告。
- `ground_truth/test-video.visual.json`：覆盖整段视频的 58 个视觉字幕语义状态，
  包含分级边界可信度、归一化 ROI、首尾源帧、时间戳、文字和原视频像素框。
  详细方法和不确定项见 `ground_truth/README.md`。

Express 与 FastAPI 共用此根数据目录。上传视频与普通任务产物均已在根目录
`.gitignore` 中排除，避免把大文件或用户内容提交到版本库。

视觉真值与语音/ASR 参考必须分开评估。例如测试片段中，语音会继续说
“from brawlers like Mortis”，但 `PROTECT YOURSELF` 在画面上只存在于
第 1771–1817 帧；相邻帧复核还将 `I WOULD SAY` 的旧结束帧 1959
纠正为 1953，下一条 `YOU CAN PLAY` 从第 1954 帧开始。

最终 `subtitle.json` 对整片 58 状态真值检出 57 条：Precision 1.0000、Recall 0.9828、
F1 0.9913，匹配文字 57/57 normalized exact，开始边界 MAE 1.053 帧、最终结束边界
MAE 0.351 帧、Tier A 5/5 精确、误报 0、最终时间重叠 0。唯一漏检是第 13–21 帧
约 0.15 秒的开场文字入场动画；当时 OCR 文字尚未完整可读，因此没有根据后续画面补字。

复现评估：

```powershell
python scripts\evaluate-visual-timeline.py `
  data\ground_truth\test-video.visual.json `
  data\subtitles\test-video\subtitle.json `
  --output data\subtitles\test-video\visual-evaluation.json
```
