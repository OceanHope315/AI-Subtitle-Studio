# AI Subtitle Studio 测试报告

测试日期：2026-07-16（Asia/Shanghai）

## 1. 结论

当前版本已完成“上传后手动框选 ROI，再按画面硬字幕生成严格视觉时间轴”的真实整片
回归。测试素材为 1080×1920、2,380 帧、39.7063 秒的竖屏 MP4；本次手动 ROI 为：

```json
{ "x": 0.08, "y": 0.52, "width": 0.84, "height": 0.24 }
```

最终 `subtitle.json` 与 58 状态人工视觉真值的比较结果：

| 指标 | 结果 |
| --- | ---: |
| 真值视觉状态 | 58 |
| 最终预测事件 | 57 |
| 匹配事件 | 57 |
| False positive | 0 |
| False negative | 1 |
| Precision | 1.0000 |
| Recall | 0.9828 |
| F1 | 0.9913 |
| 匹配事件归一化文本 exact | 57/57 |
| 开始边界 MAE | 1.053 帧（约 17.6 ms） |
| 最终结束边界 MAE | 0.351 帧（约 5.9 ms） |
| Tier A 相邻帧精确边界 | 5/5 |
| 最终事件时间重叠 | 0 |

唯一漏检为第 13–21 帧的开场 `HOW TO PLAY` 入场状态，只有约 0.15 秒。该阶段文字
仍在动画进入、OCR 没有得到完整可读短语；系统选择漏报，而不是根据后续画面或语音
凭空补字。这是本次 Recall 未达到 1.0 的全部原因。

这些结果不能表述成“全片 100% 单帧精确”：Tier A 的五个事件逐相邻帧复核并要求
精确；其余 Tier B 事件的人工边界声明 ±18 帧不确定度。57/57 exact 指匹配事件的
归一化文字完全一致，不代表漏检事件也被识别。

## 2. 测试环境与素材

- Windows / PowerShell
- Python 3.12.10
- Node.js 24.13.0，npm 11.6.2
- OpenCV 4.10.0
- PaddleOCR 3.5.0，PaddlePaddle 3.3.1
- faster-whisper 1.2.1，模型 `small`，CPU/int8

测试视频 `testVideo.mp4`：

- 27,060,502 bytes
- H.264 / MP4
- 1080×1920
- 59.9401 FPS
- 2,380 帧
- OpenCV 计算时长 39.7063 秒
- SHA-256：`98906EA1EEE422352E3A0B9844E262240A5F330ED3226FE29A64C04CD356512A`

人工视觉真值位于 `data/ground_truth/test-video.visual.json`，覆盖整片 58 个语义状态。
它与 `testVideo.txt` 的语音粗转写相互独立；后者不能用作硬字幕检测或视觉边界真值。

## 3. 完整真实推理

默认 `SAMPLE_FPS=2.0`，模型已缓存。本机 CPU 完整回归约 534 秒，无警告：

| 阶段 | 实际工作量 |
| --- | ---: |
| 粗采样 PaddleOCR | 80 次 |
| 短事件发现 PaddleOCR | 20 次 |
| 边界精修 PaddleOCR | 137 次 |
| Whisper 校字窗口 | 14 个 |
| 最终视觉事件 | 57 个 |

粗采样负责建立主要事件，多轨关联与同帧文字组合负责消除碎片和嵌套重复。短事件发现
在采样间隔内执行低成本视觉变化扫描，再对少量稳定候选帧调用 OCR；因此找回了只有
20 个源帧的 `WATCH OUT`。边界精修先使用局部低分辨率视觉差分定位候选变化，再以
固定 OCR 预算确认，不需要对 2,380 帧逐帧运行 PaddleOCR。

关键回归：

| 画面字幕 | 最终时间 |
| --- | --- |
| `WATCH OUT` | `21.104–21.438s` |
| `PROTECT YOURSELF` | `29.546–30.330s` |

`PROTECT YOURSELF` 是独立视觉事件。虽然同期语音继续说 “from brawlers like Mortis”，
Whisper 不会延长它的结束时间，也不会把后续句子复制进当前字幕。OCR 视觉事件始终决定
字幕条数和起止边界；Whisper 只在当前事件附近做长度与语义均受限的校字。

保留产物：

- `data/subtitles/test-video/ocr_events.json`
- `data/subtitles/test-video/subtitle.json`
- `data/subtitles/test-video/output.srt`
- `data/subtitles/test-video/diagnostics.json`
- `data/subtitles/test-video/visual-evaluation.json`

## 4. 视觉真值与可复现评估

真值将“完整稳定短语”作为一个语义状态；逐词入场、颜色高亮和运动模糊不会额外拆条。
Tier A 包含 `PROTECT YOURSELF` 邻域的五个事件，全部检查了变化点两侧的相邻源帧；
Tier B 的文字人工确认，但起止边界允许 ±18 帧标注不确定度。

运行完整真实推理：

```powershell
.\scripts\evaluate-test-video.ps1
```

对最终字幕运行视觉评估器：

```powershell
python scripts\evaluate-visual-timeline.py `
  data\ground_truth\test-video.visual.json `
  data\subtitles\test-video\subtitle.json `
  --output data\subtitles\test-video\visual-evaluation.json
```

评估器执行按时间单调的一对一匹配，并报告检测 Precision/Recall/F1、归一化文本 exact、
起止帧 MAE、Tier A 精确状态、误报和漏报。默认会将同一时段上下堆叠的 OCR 行组合为
一个语义字幕；可用 `--no-merge-multiline` 检查原始行级预测。

## 5. 两阶段 Web 工作流验证

上传后的任务先保存为 `awaiting_roi`。只有用户确认归一化字幕框，Express 才原子地
转换为 `queued` 并创建 FastAPI job。验证覆盖：

- 确认前 AI job 不存在，后台恢复流程也不会误启动 `awaiting_roi` 任务。
- React、Express、持久层与 FastAPI 接收到相同 ROI。
- 重复或并发确认返回 409，不会重复入队。
- 处理完成后可编辑、保存并原子重建 JSON/SRT。
- 视频单 Range 请求返回 206，非法范围返回 416。
- MongoDB 未启用时明确告警并使用 JSON 存储；Mongo repository 分支由自动化测试覆盖。

## 6. 自动化测试

| 层 | 命令 | 结果 |
| --- | --- | --- |
| AI | `python -m pytest ai_service/tests -q` | 67/67 通过 |
| Backend | `npm test` | 15/15 通过 |
| Frontend | `npm run test` | 26/26 通过 |
| Frontend lint | `npm run lint` | 通过，0 warning |
| Frontend build | `npm run build` | 通过 |

测试覆盖 ROI schema 与裁剪坐标、PaddleOCR 输出兼容、同帧字幕组合、多轨事件、短事件
发现、视觉边界精修、受限 Whisper 校字、SRT、完整真值 schema、视觉评估器、两阶段任务
状态、并发确认、文件/Mongo 仓库、字幕 CRUD、Range 视频流、ROI 拖拽/移动/八向缩放、
黑边坐标换算、前端 API 错误处理和生产构建。

## 7. 为什么当前不需要 YOLO

严格时间轴需要回答的是“字幕文字在哪一帧出现和消失”，而不是只在某一帧给出一个大致
字幕区域。当前流程由用户手动框选 ROI，PaddleOCR 自带的 text detector 在 ROI 内定位
文字，再由视觉变化与边界 OCR 精修时间。因此 YOLO 不是严格对齐的必要组件。

YOLO 可以作为未来的可选前置能力，用于自动建议字幕区域；但通用 YOLO 权重并不认识
本项目的编辑字幕样式。若启用，必须用目标视频分布的定制框标注训练、验证，并且仍要
保留后续 OCR 与视觉边界流程。它不能替代当前的时间轴算法。

## 8. 指标限制

- 本次指标只对应这一条真实测试视频和当前手动 ROI，不是跨语言、跨字体的泛化承诺。
- Tier B 边界是真值估计，故其 ±18 帧范围内误差应结合标注不确定度解释。
- CPU 耗时受模型缓存、机器、分辨率、ROI 面积和字幕密度影响，不是性能 SLA。
- `testVideo.txt` 是语音参考；视觉字幕和同期语音内容不同，二者必须分别评估。
