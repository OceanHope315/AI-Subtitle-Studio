# AI Subtitle Studio 测试报告

测试日期：2026-07-16 至 2026-07-17（Asia/Shanghai）

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
| AI | `python -m pytest ai_service/tests -q` | 80/80 通过 |
| Backend | `npm test` | 27/27 通过 |
| Frontend | `npm run test` | 62/62 通过 |
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

## 9. P0-A 时间轴校准（2026-07-17）

前端自动化确认预览不再注册 `timeupdate` 处理器：优先消费
`requestVideoFrameCallback` 的 `mediaTime`，不支持时才使用
`requestAnimationFrame + currentTime`。测试还覆盖 `[start,end)` 二分查找、只有 cue id
变化才更新 React、播放/暂停/seek 立即同步、29.97 FPS 帧步进，以及全片/5 秒/1 秒视图。

AI 读取层已从 OpenCV 的 `frame_index / fps` 切到 PyAV PTS。新增真实编码回归覆盖
30000/1001、60000/1001 CFR，以及 non-zero PTS + VFR；cue 保存
`start_frame/end_frame_exclusive/start_pts/end_pts/time_base`，秒值由 PTS 派生。

目标任务 `f8c9a5b3-9686-41f3-9bce-7766f5290cc9` 的源视频实测：

| 项目 | 实测 |
| --- | ---: |
| 解码帧数 | 1,576 |
| FPS | 29.97 |
| time base | 1/11988 |
| start PTS / start time | 400 / 0.0333667s |
| PTS 派生时长 | 52.5859193s |
| VFR | 否 |
| `AND HEAL THEM` 最后一帧 | 762 |
| `WHEN YOU CAN` 第一帧 | 763 |
| 独占切换边界 | 25.4587921s |
| 相对旧 25.460s 边界误差 | 1.208ms |
| 一个呈现帧 | 33.367ms |

抽取并人工查看相邻源帧 762/763，画面确实分别为 `AND HEAL THEM` 和
`WHEN YOU CAN`。两条 cue 的 `end_frame_exclusive/start_frame` 均为 763，
`end_pts/start_pts` 均为 305600，没有间隙、重叠或随时长增长的误差项。

## 10. P0-B 任务恢复与保存安全

新增自动化覆盖正式路由、Logo、前进/后退、全部任务状态、分页/筛选/搜索摘要、软归档、
750ms 自动保存、IndexedDB 草稿恢复、离线状态、安全离开对话框和多标签 revision 冲突。

真实 HTTP 端到端使用隔离的 `tasks.json` 副本和隔离字幕目录，视频只读指向现有真实
`data/videos`；原始任务库及产物没有写入。结果：

- `/api/tasks?limit=100` 返回 10 个轻量摘要与 pagination，响应项不含 `subtitles`。
- 任务中心对应的历史任务为 `completed`，摘要显示 88 条字幕；详情字幕接口恢复 88 条。
- 首次保存 revision 从 0 原子更新到 1；模拟第二标签继续使用 revision 0，服务返回
  `409 REVISION_CONFLICT`，且 revision 1 的文本没有被覆盖。
- 终止并重新启动真实 Express 进程后，任务仍为 `completed`，88 条字幕和 revision 1
  均从隔离 JSON 文件恢复。
- Vite 对 `/tasks`、`/tasks/new`、`/tasks/:id` 三个直接 URL 均返回 200；组件路由测试
  进一步验证 Logo、back、forward 能恢复相应页面。

本机曾成功启动 Edge 150/CDP 1.3，但持续无头浏览器进程在应用审批额度耗尽后无法再次
授权，因此没有把“真实 Edge 内的完整点击回放”计为通过。播放器误差验收由真实源视频
相邻帧/PTS 检查和浏览器 API 组件测试共同完成；这是本轮仍需在可用 GUI/CI 浏览器环境
复跑的限制，不影响真实 HTTP、PTS 和自动化结论。

## 11. P0 自动化基线与结果

修改前实际基线为 AI 67、Backend 15、Frontend 26，compile/lint/build 通过。修改后：

| 层 | 命令 | 结果 |
| --- | --- | --- |
| AI | `python -m pytest ai_service/tests -q` | 70/70 通过 |
| AI compile | `python -m compileall -q ai_service` | 通过 |
| Backend | `npm test` | 17/17 通过 |
| Frontend | `npm run test` | 40/40 通过 |
| Frontend lint | `npm run lint` | 通过，0 warning |
| Frontend build | `npm run build` | 通过 |

测试新增量为 AI +3、Backend +2、Frontend +14；没有修改 ROI、视觉时间轴、OCR/Whisper
约束相关预期，也没有引入 YOLO、实时进度、渐进编辑或翻译。以上仅是 P0 当时的历史
基线；当前 P1-A 结果见下一节。

## 12. P1-A 可视化分析进度（2026-07-17）

### 12.1 自动化回归

所有测试都将 `DATA_DIR` 指向工作区内的隔离临时目录；没有把测试 job、视频或字幕写入
现有 `data`。

| 层 | 命令 | 最终结果 |
| --- | --- | --- |
| AI | `cd ai_service; python -m pytest tests -q` | 80/80 通过 |
| AI compile | `python -m compileall ai_service` | exit 0 |
| Backend | `cd backend; npm test` | 27/27 通过 |
| Frontend | `cd frontend; npm run test` | 62/62 通过（14 files） |
| Frontend lint | `npm run lint` | 通过，0 warning |
| Frontend build | `npm run build` | 通过，51 modules |
| Diff | `git diff --check` | 通过（仅 Git 的 CRLF 提示） |

新增覆盖事件顺序与 JSONL 重启恢复、坏尾修复、JPEG 限频/环形/evidence、真实 PTS 和
全局 OCR 坐标、manifest 失败成对回滚、可观测性写入失败不阻断任务、重复崩溃下唯一
终态、成功提交恢复、启动清扫且 import/测试收集不触碰真实 job、SSE cursor/new-run/去重/
`has_more`、共享轮询、上游错误、慢消费者背压、JPEG 代理、任务轻量快照、前端 SSE
解析与有限退避、每次真正推进游标后重置连续失败预算、同游标任务快照不回退 live 状态、
刷新恢复、黑边 overlay、图片预加载失败、旧图与 OCR 事实同帧，以及 reduced-motion。

### 12.2 真实 PaddleOCR + Express + Edge 端到端

验收全程使用独立 AI/Backend 数据目录和独立端口。样片读取自现有视频但只复制到隔离
目录：16,794,732 bytes，1080×1920，252 帧，4.2042 秒，59.9401 FPS，H.264，
`time_base=1/60000`，`start_pts=960`；ROI 为
`{x:0.08,y:0.52,width:0.84,height:0.24}`，Whisper 关闭。

最终代码的快速协议回归使用 1 FPS、关闭短事件发现、每边界 1 次 OCR。它不是准确率
基准（因此生成 5 条，而上面的 2 FPS 完整流程在同片生成 7 条），结果如下：

- 第一个 SSE 客户端收到 seq 1–4 和首张真实 OCR 帧后主动关闭。该帧为 frame 0、
  PTS 960、`1/60000`，并带真实 PaddleOCR 候选和随机 preview ID；后台任务未取消。
- 新开的真实 Edge 页面从任务快照与 SSE 恢复到 boundary refinement。截图实见原帧、
  ROI 放大图、OCR 框/文字/置信度、frame 233、PTS 234193、媒体时间 3.887 秒、已处理
  7/10、字幕事件 5、事件游标 39 和“连接已恢复”；旧 `subtitle_count=0` 未覆盖真实计数。
- 用 `Last-Event-ID: b78dd03147434cff9b43d947fafd20f1:4` 续接时，背压安全断流后
  自动按 5–28、29–52、53–54 三段补齐；50 个补发事件连续、唯一、无倒退，最终收到
  `job.completed`（5 条）。coarse OCR 与 boundary refinement 各自的真实 frame/媒体时间
  单调；跨 stage 的 seek 保留真实 PTS，不伪造全局递增媒体时间。
- 15 个 `cue.upserted` 均带精确 `detected_cue_count=5`。任务 JSON 只含 seq 54 的轻量
  快照、最新 frame seq 43 和最新 preview frame seq 43，不含 `events` 数组。

修复前的首轮 2 FPS 验收也真实完成：76 个事件、69.147 秒、7 条字幕；从 seq 4 经
4 个 SSE 连接完整恢复到 seq 76。该轮发现“轮询 DTO 的处理中 subtitle_count=0 覆盖
事件计数”的竞争，随后修复并以最终轮 Edge 截图和自动化用例复验。

### 12.3 图片、清理与安全

- 原帧和 ROI 均为真实 JPEG；首轮人工查看可读到 `USE THEM TO ATTACK`，ROI 与 OCR
  框位置一致。前端最多保留 5 个缩略图引用，AI 普通预览最多 8 个 bundle。
- 最终轮终态后普通 preview 目录为 0 文件，首张普通 preview 返回 404；边界 evidence
  保留 18 张 JPEG、694,900 bytes，仍可取回。
- 对 evidence 发送 `Range: bytes=0-9` 仍返回完整 `200 OK`、`Content-Length: 39256`、
  `Accept-Ranges: none`，避免分片 JPEG/缓存语义混乱。
- 完整事件 JSONL 中没有 Windows 绝对路径；`job.completed.artifacts` 仅列逻辑产物名。
  preview/task/run ID 均先做格式与归属校验，图片响应固定为 `image/jpeg` 和 `nosniff`。

### 12.4 性能、内存和存储边界

最终真实轮从首事件到终态为 40.026 秒，写 54 个事件；JSONL 为 34,614 bytes，普通
预览终态为 0，保留 evidence 为 694,900 bytes。首轮较高工作量配置的 JSONL 为
49,870 bytes、evidence 为 1,022,873 bytes。两轮配置不同，因此不把 40.026/69.147 秒
当成 P1-A 前后性能对比或 SLA。

另做 7+7 次相同 4 秒合成视频的受控微基准（假 OCR，用于隔离可观测性开销）：无事件
中位 30.16ms，启用 JSONL+JPEG 中位 99.53ms，绝对增加 69.37ms；Python `tracemalloc`
峰值中位从 52.9KiB 到 311.2KiB，增加 258.3KiB。百分比为 +230% 是因为假 OCR 基线
仅 30ms，不能外推到真实 PaddleOCR；有意义的是绝对开销和固定上限。OpenCV 的 native
内存不完全计入 `tracemalloc`。

中途字幕计数不再每帧重建完整 temporal graph，而在 observation 数 1/2/4/8/… 时更新，
最终聚合和终态强制精确。这使额外聚合保持在最终聚合的数量级。热事件缓存终态释放，
前端状态只保存一个最新 frame、一个最新有图 frame 和 5 张缩略图。

当前 JSONL 与 evidence 没有 TTL/压缩/自动归档，是已记录的生产存储边界；普通预览已有
环形上限和终态清理。P1-B“边分析边编辑”及翻译事件/翻译 UI 本轮明确未实现。

### 12.5 原数据完整性

验收前后 `data` 均为 96 个文件、429,437,352 bytes；按“相对路径 + size + 每文件
SHA-256”排序生成的目录清单 SHA-256 前后均为
`D4B1C4129A8A86D0F24A19E9107DAB88F084093A4F69E1C3A91367E6B3040D45`。
`data/tasks.json` SHA-256 前后均为
`B26A7E6174B331CD557B8AD0C28C2D078F0EC8C71719CABDD2B66ABD769E4977`。
