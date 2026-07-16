# 旧项目代码审查报告

> 审查对象：`D:\new project`  
> 审查方式：只读扫描源码、说明文档、依赖、测试资产、SRT、OCR/对齐日志与抽帧调试图；未修改旧项目任何文件。  
> 审查日期：2026-07-15

## 1. 执行结论

旧项目是一个针对竖屏英文游戏短视频的 **Tkinter + OpenCV + PaddleOCR 桌面 MVP**。它已经跑通了“视频抽帧 → OCR 候选筛选 → 视觉事件聚类 → 与外部 Whisper 字幕对齐 → SRT 导出”的实验链路，也留下了较丰富的调试资产；但它并不是可扩展的软件产品，且没有真正调用 Whisper、没有 Web 前端、后端 API、数据库、任务系统或字幕编辑器。

本次审查的主要结论如下：

1. **可以复用的是数据模型、文件解析、调试思路和测试资产，不应整体搬运两个千行核心模块。** `paddle_ocr.py` 与 `hybrid_aligner.py` 各超过 1,000 行，混合了模型适配、图像预处理、业务规则、聚类、对齐和日志 I/O，测试与演进成本过高。
2. **效果不佳并非单纯的 OCR 模型问题。** 33–36 秒的日志中，画面字幕 `YOU CAN PLAY`、`BASICALLY SIRIUS`、`EVERYWHERE`、`BECAUSEIT'S`、`SO OP RIGHT NOW`、`MAYBENOT` 已被 PaddleOCR 以约 0.98–1.00 的置信度识别，但最终 SRT 在 `32.632–37.237` 秒出现 4.605 秒空洞。主要损失发生在全帧候选分组、最高分候选选择、事件聚类和贪心对齐阶段。
3. **多预处理结果的融合方法会制造重复与污染。** 同一区域的不同 OCR 读数在相似度不足时被直接拼接，产生 `SIRIUS SIRIUS`、`JUST3-TAP THEM 3-TAPT THEM`、`ALL YOUR SHADOWS TISHADOWS ALL YOUR` 等结果；字幕框又会与玩家名、血量、作者署名合并。
4. **对齐层只带来有限的词级改善。** 以用户指定的 `testVideo.txt` 作代理参考，OCR-only SRT 的 WER 为 66.23%，对齐后为 62.34%，只改善 3.89 个百分点；字符错误率反而由 45.23% 上升到 46.20%。40 个事件中仅 20 个被判定为 matched。
5. **`testVideo.txt` 不能直接作为“硬字幕 OCR Ground Truth”。** 它是连续语音的粗粒度转写，画面硬字幕是经过编辑的短语，两者存在真实内容差异；例如参考开头包含 `Today I will teach you`，画面标题只有 `HOW TO PLAY SIRIUS`。因此本报告中的 WER/CER 和边界误差只能视为代理指标。新项目必须把“语音转写真值”和“逐帧硬字幕真值”分开建立。

## 2. 项目结构

### 2.1 规模统计

| 项目 | 数量/大小 |
|---|---:|
| 文件总数 | 159 |
| Python 源文件 | 21（其中 `src` 20 个、手工测试 1 个） |
| `src` 物理行数 | 2,608 行 |
| `src` 非空非纯注释行 | 2,220 行 |
| `.pyc` 文件 | 42 |
| 调试帧 | 80 张，29,476,672 bytes |
| 文本日志/文本资产 | 9 个 `.txt` |
| SRT | 3 个 |
| 测试视频 | 27,060,502 bytes |
| 项目总大小 | 58,180,920 bytes |

所有 20 个 `src/*.py` 文件均可被 Python AST 正常解析，未发现语法错误；但这不等于依赖齐全或运行路径已被测试。

### 2.2 目录树

```text
D:\new project
├─ README.md / README_zh.md
├─ requirements.txt
├─ aligned_phrase_subtitles.srt       # OCR + 外部字幕对齐结果
├─ visual_events_only.srt             # OCR-only 视觉事件结果
├─ debug_summary.txt
├─ debug_ocr_log.txt
├─ debug_ocr_raw_result.txt
├─ subtitle_position_debug.txt
├─ visual_events_debug.txt
├─ debug_alignment_log.txt
├─ missing_against_whisper.txt
├─ debug_frames/                       # 80 张带框抽帧
├─ test/
│  ├─ testVideo.mp4                    # 指定测试视频
│  ├─ testVideo.txt                    # 15 段粗粒度语音转写
│  ├─ test.png                         # 单帧 OCR 样例
│  ├─ test.py                          # 无断言的手工 OCR 脚本
│  └─ aligned_subtitles.srt            # 与根目录对齐结果完全相同
└─ src/
   ├─ app.py / config.py
   ├─ gui/main_window.py
   ├─ video/frame_reader.py
   ├─ ocr/base.py / preprocess.py / paddle_ocr.py
   ├─ detector/yolo_subtitle_detector.py
   ├─ pipeline/extractor.py / hybrid_aligner.py
   └─ subtitle/model.py / merge.py / srt.py
```

存在两个“只有字节码、没有源文件”的遗留模块：

- `src/ocr/__pycache__/tesseract_ocr.cpython-312.pyc`：反汇编可见其曾使用 Tesseract、二值化预处理和 `OcrResult`；当前 `base.py` 已没有 `OcrResult`，因此不能直接恢复运行。
- `src/video/__pycache__/roi.cpython-312.pyc`：曾按 `roi_top_ratio`、`roi_bottom_ratio` 裁剪字幕 ROI；当前配置已无这两个字段，同样属于被删除但未清理的旧迭代。

这说明旧项目经历过 Tesseract/固定 ROI → PaddleOCR/整帧启发式的路线迁移，但仓库没有清理构建产物，也没有保留可追溯版本历史。

## 3. 已有功能

旧项目实际流程为：

```text
用户选择视频 + 已生成的 Whisper JSON/SRT/TXT + 可选 YOLO 权重
  → OpenCV 按 sample_fps 抽帧
  → 每帧最多执行 5 个预处理版本的 PaddleOCR
  → 文本框基础过滤、邻近框合并、字幕可能性打分
  → 每帧只取最高分候选
  → 按时间、文本相似度、位置和高度聚类成视觉字幕事件
  → 与外部字幕词/短语做时间窗 + 模糊文本匹配
  → 输出用户指定 SRT，并额外覆盖写入多份固定名称调试文件
```

已实现能力：

- MP4 等常见视频的 OpenCV 解码、FPS/帧数读取和等间隔抽帧。
- PaddleOCR 2.x 风格结果解析，并兼容若干字典/对象形态。
- 原图、对比度灰度、自适应阈值、白字掩膜、彩色字掩膜五路 OCR。
- 文本框尺寸、置信度、位置、长宽比、HUD 数字、颜色和字幕样式启发式评分。
- 可选 Ultralytics YOLO 框检测；无权重、加载失败或无检测框时退回整帧 OCR。
- 连续 OCR 观测的事件聚类、短事件放行、后处理合并。
- 读取 Whisper/WhisperX 风格 JSON 中的词时间戳，或把 SRT 段内时长均匀分配给词。
- SRT/TXT 解析、SRT 时间格式化和导出。
- Tkinter 文件选择、采样率选择、后台线程和进度条。
- OCR 原始结果、候选框、位置评分、视觉事件、对齐、缺失项和摘要日志。

明确未实现的能力：

- **没有 Whisper 推理调用。** README 也明确说明旧项目刻意避免 ASR；程序只读取用户提前准备的 JSON/SRT/TXT。
- 没有 FastAPI AI 服务、Express 后端、MongoDB、上传任务、异步队列或任务恢复。
- 没有 React Web 界面、视频播放器、字幕列表、时间轴编辑、保存/版本控制。
- 没有 `subtitle.json` 标准产物、下载接口、鉴权、限流、上传校验、批处理或取消任务。
- 没有真正的自动化测试、性能基准、模型版本记录或可重复评估脚本。

## 4. 逐模块分析

| 模块 | 当前职责与优点 | 主要问题 | 复用建议 |
|---|---|---|---|
| `src/config.py` | 用 dataclass 集中 49 个提取、聚类、对齐和调试参数 | 参数大多是针对 1080×1920 测试视频调出的像素阈值；无分层、校验和配置来源；部分参数已成为死配置 | 仅复用参数清单作为实验记录；新项目改为 Pydantic 分层配置并使用归一化坐标 |
| `video/frame_reader.py` | 代码小，资源释放正确，时间戳由帧号/FPS计算 | 不支持 VFR/旋转元数据、取消、解码错误区分；FPS 失败时静默用 25；进度估算少算一帧 | 可重写并保留接口思想；加入视频探测 DTO、生成器取消和单元测试 |
| `ocr/preprocess.py` | 简单灰度、双边滤波、放大、Otsu | 当前主流程完全未调用，与 `paddle_ocr.py` 内部预处理重复 | 不直接复用；把预处理做成可组合、可基准的独立策略 |
| `ocr/base.py` | 曾尝试抽象 OCR Protocol | Protocol 只返回字符串，与当前框、置信度、位置数据不匹配；实际未使用 | 新建结构化 `OcrDetection` 协议；旧文件不复用 |
| `ocr/paddle_ocr.py` | 兼容结果解析、坐标归一化、掩膜和调试覆盖图有参考价值 | 1,003 行单体；一帧五次 OCR；多版本冲突时拼接文本；启发式高度过拟合；英文字符白名单；全局文件 I/O；分数可大于 1 | 拆成 engine/parser/preprocess/candidate-selector/debug-renderer；复用解析测试样例和部分纯函数，不复制主类 |
| `detector/yolo_subtitle_detector.py` | 轻量可选适配器，坐标裁剪正确 | 没有权重；加载/推理异常全部吞掉；用户无法知道是否真的使用 YOLO；属于需求规划中的 V2 | 保留接口概念，V1 不依赖；V2 加模型状态、错误码、指标和版本信息 |
| `pipeline/extractor.py` | 早期 OCR-only 连续文本合并器，结构相对简单 | 当前 GUI 不使用；与 hybrid 流程重复；未利用位置框；属于死代码 | 不复用实现，只保留 disappearance grace 的思想 |
| `pipeline/hybrid_aligner.py` | 视觉事件、词、短语、匹配结果的数据结构丰富；日志字段有诊断价值 | 1,053 行单体；每帧只保留 top-1；固定像素阈值；贪心占用词；低置信匹配也消费词；硬编码阈值 70 绕过配置；大量未调用函数 | 数据结构迁移为 Pydantic；算法改为单调动态规划/全局匹配；旧主类不复用 |
| `subtitle/model.py` | 最小字幕段模型 | 无 ID、置信来源、位置、版本和校验 | 扩展成 API/数据库共用模型 |
| `subtitle/merge.py` | 相似文本和短间隔合并逻辑清晰 | 仅字符 SequenceMatcher；会原地修改输入；无位置与语言感知 | 纯函数思想可复用，需改成不可变、带空间与置信度条件 |
| `subtitle/srt.py` | SRT 时间解析、格式化、写入代码简洁 | 无序列/重叠/负时长校验；普通无时间文本会被设为 999999 秒；SRT 段内词时间为线性伪造 | 可作为新实现的起点，并补齐验证、测试和显式错误 |
| `gui/main_window.py` | 能完成本地选择文件、启动任务和显示进度 | 固定尺寸、英文、无编辑器；worker 线程直接调用 `messagebox`，违反 Tk 线程安全；无取消和任务隔离 | 产品目标是 React，Tkinter 不复用 |
| `test/test.py` | 能人工验证单张图片的 PaddleOCR | 只有 6 行、无断言、依赖当前工作目录、可能触发模型下载；未覆盖项目模块 | 不作为测试复用；保留 `test.png` 作 fixture |

静态引用扫描还发现至少 10 个只定义未使用的主要符号，包括 `SubtitleExtractor`、`OcrEngine`、`preprocess_subtitle_image`、`alignment_similarity`、`_match_event_to_words`、`_match_event_to_phrase`、`_should_post_merge`、`_max_words_for_ocr`、`_has_unrelated_extra_words`、`_representative_text`。这进一步表明核心文件是在连续试验中追加形成，而不是围绕稳定边界设计。

## 5. 可复用资产

### 5.1 建议复用

1. **测试媒体与失败样本**
   - `test/testVideo.mp4`：39.706 秒、2,380 帧、59.940 FPS、1080×1920，适合作为首个竖屏游戏视频回归样例。
   - `test/test.png`：包含标题字幕、作者署名、玩家名和多个数值 HUD，适合测试候选框污染。
   - 80 张调试帧：覆盖标题、战斗 HUD、地图菜单和人物口播等典型场景。
2. **结构化数据思想**
   - `OcrObservation`、`VisualSubtitleEvent`、`WhisperWord`、`EventMatch` 的字段可迁移为新服务的 Pydantic 模型。
   - 视觉事件保留 `merged_texts`、split/merge reason 的设计很适合解释性调试。
3. **纯函数或局部算法经验**
   - SRT 毫秒格式化与基础解析。
   - OCR 2.x 多形态结果的安全解析、框坐标归一化。
   - 视频资源释放、基于真实 FPS 的帧时间戳计算。
   - 消失宽限、空间一致性和多帧共识是正确方向，但需重新实现。
4. **调试方法**
   - 保存带框帧、原始 OCR、候选淘汰原因、事件合并原因、对齐详情和摘要指标。
   - 新项目应将其改为按 `task_id` 隔离、可开关、可下载的结构化 JSONL/指标，而非覆盖固定文件。

### 5.2 不建议直接复用

- 两个千行主类及其硬编码阈值。
- 测试视频专用文本替换表和 HUD 词表。
- 多路 OCR 低相似结果直接拼接的策略。
- top-1 候选 + 局部贪心词占用的对齐实现。
- Tkinter 界面、全局相对路径日志、无状态校验的线程模型。
- 当前 `requirements.txt`：仅固定部分版本，`pillow`、`ultralytics` 未固定，且没有 FastAPI、Whisper、测试或服务化依赖。

## 6. 存在问题与失败原因

### 6.1 OCR 候选选择比文字识别本身更差

旧流程对每帧的五种预处理结果先按区域合并。若两个读数处于同一区域但文字相似度低于 0.72，代码会把两段文本拼起来，而不是投票或选择置信度更高者。这直接解释了重复文本。随后，相邻框按宽松的垂直间距和中心距离做传递式分组，容易把字幕、血量和玩家名连成一个组。

候选评分还同时奖励大面积、横向、居中、全大写和彩色文字；这些特征也是游戏菜单、玩家名和 HUD 的特征。彩色框最低置信度可降到 0.25，使 HUD 更容易进入候选。调试日志中 795 个原始框是纯数字，说明场景中的干扰本来就非常强。

### 6.2 top-1 丢弃与事件聚类造成高置信字幕消失

`HybridSubtitleAligner` 每帧只选择得分最高的一个候选，没有跟踪 top-k 字幕轨迹。复杂菜单帧中，UI 文本组合的面积/样式分数可能超过真正字幕；而这些 UI 组合随帧变化，无法通过最少帧数、文本相似度和空间一致性检查。最终表现为“PaddleOCR 已识别，SRT 却没有”。

`_is_fast_subtitle_event` 使用 `180≤x≤900`、`850≤y≤1580` 的固定像素带，只适合约 1080×1920 竖屏。位置容忍度和标准差也使用绝对像素，换分辨率后阈值意义改变。

### 6.3 文本规则对测试视频过拟合

`normalize_ocr_text` 和 `normalize_alignment_text` 各自维护一份重复但不完全相同的替换表，包含 `HOWTOPLAY`、`USETHEGADGET`、`ADD MORE SHADOWS`、`Yoshi825` 场景相关规则。HUD 词表也直接写入 `REWE`、`SK GAMING`、`BRAWL` 等品牌/游戏词。

这种规则既漏掉粘连形式，如 `SKYoshi825`，也可能误伤正常词；同时正则只保留 ASCII 英文，配置中的 `language` 并不能带来真正的多语言能力。

### 6.4 对齐使用伪造词时间和局部贪心策略

输入 SRT 没有真实 word-level 时间戳时，旧代码把一个 2–4 秒句子的时长平均分给每个空白词。这并不是 Whisper 的词级时间，时间窗匹配基础已经失真。

对齐按事件顺序贪心选择词，并永久占用已选索引；即使事件进入 fallback，只要找到分数大于约 55 的候选，也会占用部分词，影响后续事件。OCR 粘词如 `YOUHAVE`、`LIKEMORTIS` 又无法通过按词裁剪逻辑，导致 fallback。

此外，实际使用的短语匹配阈值硬编码为 70，而 `config.align_similarity_threshold=60` 只被一个未调用的旧函数使用。对齐还可能把完整 OCR 文本替换为更短内容，例如：

- `USE THE GADGET` → `GADGET`
- `GOING TO DISAPPEAR` → `DISAPPEAR.`

### 6.5 置信度和摘要指标会误导诊断

40 个视觉事件的平均 OCR confidence 为 0.9858，但其中一半对齐失败，代理 WER 仍超过 62%。这个 confidence 主要表示 PaddleOCR 对所选框字符的置信度，不表示“该框是字幕”“事件完整”或“与语音一致”。候选 score 的权重总和可超过 1，日志中实际出现 1.0235，因此它也不是概率。

`missing_against_whisper.txt` 只要短语附近存在任意已匹配视觉事件，就把该短语标为 matched，并没有验证该短语的词是否被使用。它报告 29/37（78.4%）短语 matched，但真正 matched 的事件只有 20/40（50%），由 matched 事件实际选中的参考词只有 51/154（33.1%）。

### 6.6 性能、隔离与可靠性不足

- 397 个采样帧 × 5 个预处理版本，设计上最多调用 PaddleOCR 1,985 次；没有批推理、变化检测、缓存或自适应采样。
- 调试默认开启，39.7 秒视频产生 80 张图、约 29.48 MB，仅根目录文本调试文件又约 0.68 MB。
- 日志和额外 SRT 使用固定相对路径；每次初始化会清空部分日志，多任务会互相覆盖。
- YOLO 加载与推理异常全部被吞掉并静默退回整帧 OCR，用户无法判断配置是否生效。
- `frame_count_estimate()` 对该视频返回 396，但实际生成 397 个采样帧，进度会超过 100% 后再由 UI 截断。
- 最后一个事件结束于 39.740 秒，比视频实际 39.706 秒长约 34 ms；没有对媒体时长裁剪。
- Tk worker 线程直接调用 `messagebox`，不是线程安全的 UI 更新方式。
- 没有任务目录、原子写入、失败清理、取消、重试、超时、模型健康检查或磁盘配额。

### 6.7 工程与产品闭环缺失

- 没有 `pyproject.toml`、锁文件、`.gitignore`、CI、pytest 配置、覆盖率、格式化/静态检查配置。
- 42 个 `.pyc` 和大量输出文件混入项目；根目录结果与 `test/aligned_subtitles.srt` SHA-256 完全相同，后者不是独立的 golden expected result。
- `test/test.py` 没有断言，也不测试视频管线、SRT、聚类、对齐或 GUI。
- 不具备用户要求的上传、任务状态、MongoDB 持久化、Web 编辑、保存和下载闭环。

## 7. 日志与测试证据

### 7.1 输入资产

| 指标 | 结果 |
|---|---:|
| 视频是否可由 OpenCV 打开 | 是 |
| 分辨率 | 1080×1920 |
| FPS | 59.9400767 |
| 总帧数 | 2,380 |
| 实际时长 | 39.706322 秒 |
| `testVideo.txt` | 15 段、0–39 秒、154 个空白分词 |
| 旧流程采样帧 | 397，约 9.99 FPS |

### 7.2 OCR 与事件管线

| 阶段 | 数量 | 说明 |
|---|---:|---|
| raw OCR boxes | 2,300 | 五路 OCR 去区域重叠后的框计数汇总 |
| 基础框过滤日志中标记 kept | 1,087 | 约占 2,302 条框/空结果日志的 47.2% |
| 纯数字过滤 | 795 | 34.5%，反映 HUD 数值干扰严重 |
| 短文本过滤 | 301 | 13.1% |
| 非横向过滤 | 72 | 3.1% |
| 小型边缘 HUD 过滤 | 45 | 2.0% |
| grouped kept candidates | 783 | 与 raw box 非同一统计口径，平均约 1.97/采样帧 |
| post-merge 前事件 | 43 | 事件过滤后 |
| post-merge 后事件 | 40 | 合并了 3 个事件 |
| 进入事件的采样帧 | 246 | 占 397 帧的 62.0% |
| matched / fallback | 20 / 20 | 对齐成功率 50% |
| 导出字幕 | 40 | fallback 也直接导出 OCR 文本 |

典型证据：

- `0.300–2.202`：标题和作者署名反复合并，形成 `HOW TO PLAY ... SIRIUS BY YOSHI825`。
- `16.216–17.918`：字幕与血量/玩家名合并，形成 `4800 IFYOU ARE LIKE`、`SHADOW AND SKYOSHI825 7400`。
- `22.723–24.124`：`WHEN YOU DIE` 被拼入 `4440`，下一事件出现 `TISHADOWS ALL YOUR` 重复。
- `32.632–37.237`：最终 SRT 没有事件；但逐帧日志明确识别了多组真实字幕，说明这是下游筛选/聚类损失，不应归因成 PaddleOCR 完全漏检。

### 7.3 与声明 Ground Truth 的代理对比

计算口径：大小写折叠；词级保留英文缩写、撇号和连字符；把 40 个输出事件按时间顺序拼接后与 154 词参考比较。由于参考是语音粗转写而非硬字幕逐帧标注，以下指标仅用于比较旧流程内部版本，不能代表真实 OCR 精度。

| 指标 | `visual_events_only.srt` | `aligned_phrase_subtitles.srt` |
|---|---:|---:|
| 条目数 | 40 | 40 |
| 归一化输出词数 | 109 | 111 |
| 词替换 S | 43 | 41 |
| 词删除 D | 52 | 49 |
| 词插入 I | 7 | 6 |
| WER | 66.23% | 62.34% |
| CER | 45.23% | 46.20% |
| 0–39 秒字幕时间覆盖 | 24.119 秒（61.8%） | 24.119 秒（61.8%） |
| 时长 min / median / max | 0.300 / 0.601 / 1.101 秒 | 相同 |
| 小于 0.6 秒的条目 | 16/40 | 16/40 |
| 字符速率大于 20 CPS | 23/40 | 20/40 |

结果表明：Whisper 文本替换使代理 WER 绝对下降 3.89 个百分点，但没有改善任何时间覆盖，且 CER 略差；它不是稳定的文本修复器。

若将输出事件按时间中点归入 15 个粗参考段，再用每组最早/最晚事件估计边界：起点绝对误差均值约 0.339 秒，终点绝对误差均值约 0.483 秒，最大终点误差 3.368 秒。这个最大误差来自 32–36 秒参考段的大面积缺失。输出最大空洞为：

| 空洞 | 时长 |
|---|---:|
| 32.632–37.237 | 4.605 秒 |
| 21.121–22.723 | 1.602 秒 |
| 30.330–31.331 | 1.001 秒 |
| 6.106–7.107 | 1.001 秒 |

### 7.4 Ground Truth 本身的适用性问题

抽帧和日志证明 `testVideo.txt` 与画面硬字幕不是同一个标注层：

| 时间附近 | `testVideo.txt` 语音转写 | 画面硬字幕/高置信 OCR |
|---|---|---|
| 0–2 秒 | `Today I will teach you how to play Sirius.` | `HOW TO PLAY SIRIUS`，另有 `BY: Yoshi825` |
| 16–18 秒 | `if you want to get another shadow...` | `IF YOU ARE LIKE` / `ONE-SHOT TO GET` / `SHADOW...` |
| 34–37 秒 | `because it's so pure right now. Maybe not in Nacot...` | `BECAUSE IT'S` / `SO OP RIGHT NOW` / `MAYBE NOT` / `IN KNOCKOUT` |
| 37–39.7 秒 | `but in any other map it's really good.` | `BUT ON MANY` / `HE'S REALLY GOOD` |

差异包含口语与编辑字幕的改写，也包含转写错误，如 `pure`/`OP`、`Nacot`/`Knockout`。此外参考在 39.000 秒结束，而视频还有约 0.706 秒，最后一条硬字幕正位于该尾段。新项目不能用这份文件单独计算 OCR 精确率。

## 8. 重新设计方案

### 8.1 服务边界

按用户指定技术栈采用三层架构，但必须明确职责，避免把旧单体逻辑原样拆成三个进程：

```text
React + Vite
  ├─ 上传页、任务进度
  └─ Video Player + Subtitle List + Timeline Editor
          │ REST/JSON
Express Backend
  ├─ MP4 上传与安全校验
  ├─ VideoTask 状态机、字幕 CRUD、SRT 下载
  ├─ MongoDB 持久化与乐观版本控制
  └─ 调用/轮询 FastAPI AI 任务
          │ 内部 API
Python FastAPI AI Service
  ├─ video probe / frame sampler
  ├─ ROI + PaddleOCR
  ├─ temporal tracker / event builder
  ├─ Whisper ASR（可配置）
  ├─ monotonic alignment / confidence fusion
  └─ subtitle.json + output.srt + metrics
```

每个任务使用独立目录 `data/tasks/{task_id}/`，包含 source、work、debug、output；所有产物先写临时文件再原子替换。MongoDB 只存任务元数据、字幕段和文件引用，不把视频二进制塞入文档。

建议状态机：

```text
queued → probing → extracting_ocr → transcribing → aligning → ready
   └──────────────────────────────→ failed / cancelled
```

### 8.2 V1 OCR 管线

1. **视频探测**：校验 MP4、时长、分辨率、FPS、旋转；统一时间基准，并把输出 end clamp 到视频时长。
2. **分辨率归一化 ROI**：V1 以底部/中下区域为默认搜索区，同时保留可配置全帧回退；所有框使用 `[0,1]` 归一化坐标。不要把 YOLO 设为 V1 必需项。
3. **廉价变化检测 + OCR**：保持足够高的时间采样，但先对 ROI 做 SSIM/感知哈希或边缘差分；无变化时复用观测，变化时再 OCR。支持批量推理。
4. **多预处理共识**：同一框的多版本结果按置信度、编辑距离和投票选择代表文本；绝不把冲突读数直接拼接。
5. **字幕候选轨迹**：每帧保留 top-k，并按时间、位置、尺寸、颜色和文本相似度做轨迹关联。字幕选择基于连续轨迹，而不是孤立帧最高分。
6. **事件边界**：以首次稳定出现/最后稳定出现确定边界；对文字切换做变点检测；保留原始观测和边界置信区间。
7. **通用 HUD 抑制**：用轨迹特征区分 HUD（长期固定、数字主导、边缘位置）与字幕（短时、语句形态、位置相对稳定），避免测试视频专用词表。

### 8.3 OCR + Whisper 融合

- Whisper 必须由 AI Service 实际调用，返回 segment 和 word 时间；同时允许关闭 ASR，保证 OCR-only 可独立完成闭环。
- OCR 负责画面字幕是否出现及时间边界；ASR 只在时间重叠、文本相似和单调顺序都满足时修正文字。
- 使用全局单调动态规划或最小费用匹配，替代逐事件贪心占词。
- 低置信匹配不得消耗 ASR 词；无法确定时保留 OCR 原文并标记 `needs_review=true`，交给 Web 编辑器。
- 不强制全大写，不使用视频专用替换表；规范化与显示文本分离。

建议 `subtitle.json` 段模型至少包含：

```json
{
  "id": "segment-id",
  "text": "",
  "start_time": 0.0,
  "end_time": 2.0,
  "confidence": 0.95,
  "ocr_confidence": 0.96,
  "alignment_confidence": 0.83,
  "position": [0.2, 0.62, 0.8, 0.72],
  "source": "ocr|ocr_asr|manual",
  "needs_review": false,
  "version": 1
}
```

### 8.4 可观测性

- 每个任务记录模型版本、配置快照、媒体元数据、阶段耗时、采样帧数、OCR 调用数和淘汰原因计数。
- 明确区分 `recognition_confidence`、`subtitle_probability`、`track_confidence`、`alignment_confidence`，不得混成一个 0–1 数字。
- 调试帧按失败片段采样并设置数量/空间上限，不再默认保存整段 0.5 秒间隔图片。
- YOLO/Whisper/PaddleOCR 的加载失败必须形成可见健康状态和任务错误，不能静默降级。

### 8.5 测试与评价重建

必须建立两套不同参考：

1. **Hard-subtitle Ground Truth**：逐条记录画面真实文字、首次/末次可见时间、框坐标；用于 OCR、检测和边界评价。
2. **ASR Ground Truth**：记录语音内容与词时间；用于 Whisper 和 OCR-ASR 融合评价。

建议核心指标：

- 事件检测 precision / recall / F1，匹配条件使用时间 IoU + 空间 IoU。
- start/end MAE、P95 和最大误差。
- 对已匹配硬字幕事件计算 CER/WER，不把未显示的口语词当 OCR deletion。
- HUD false-positive rate、漏检连续时长、needs-review 命中率。
- 速度：处理时长/视频时长、OCR 调用数、峰值内存、产物磁盘占用。

测试分层：

- Python 单元测试：时间转换、OCR 结果解析、共识合并、事件边界、SRT round-trip、异常输入。
- AI 集成测试：`testVideo.mp4` 生成合法 `subtitle.json` 和 SRT，且所有时间有序、无负时长、不越过视频。
- Backend 测试：上传、任务状态、字幕 CRUD、并发版本冲突、下载。
- Frontend 测试：视频加载、当前字幕联动、编辑保存、时间校验和导出。
- 端到端 smoke test：上传视频 → 完成任务 → 打开编辑器 → 修改 → 保存 → 下载 final.srt。

## 9. 实施优先级

### P0：先完成稳定闭环

- 任务隔离、视频探测、底部 ROI OCR、结构化事件、SRT/JSON。
- Express 上传/任务/SRT API、MongoDB VideoTask。
- React 播放器、字幕列表、基础时间轴编辑和保存下载。
- 最小单元/集成/E2E 测试与真实硬字幕标注。

### P1：提高正确率与可诊断性

- top-k 时序轨迹、多预处理投票、变化检测与批 OCR。
- 实际 Whisper 推理、全局单调对齐、needs-review。
- 任务级指标、失败片段调试包、取消/重试。

### P2：在闭环稳定后扩展

- YOLO 字幕区域检测、GPU 调度、多语言、批处理、协作与云端部署。

## 10. 最终判断

旧项目已经证明以下路线可行：OpenCV 能稳定读取测试视频，PaddleOCR 能在多数帧看见真实硬字幕，视觉时间可以用于 SRT，ASR 文本也能在部分短语上修正 OCR。但旧结果同时证明，**整帧启发式 top-1、冲突文本拼接、固定像素阈值和贪心词对齐不适合作为新产品内核**。

新项目应把旧代码当作“失败案例库 + 解析/调试参考”，从清晰的数据契约、任务隔离、可测试的小模块和人工可编辑闭环重新开始。第一版的成功标准不是让代理 WER 看起来更低，而是：任务可靠完成、每条字幕可追溯、错误可编辑、SRT 可正确导出、指标能够真实反映问题所在。
