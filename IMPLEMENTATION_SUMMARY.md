"""
AI Subtitle Studio - WhisperX GPU 进程隔离实现总结
==================================================

项目：D:\AI-Subtitle-Studio
日期：2024年
目标：解决 PaddleOCR GPU 与 WhisperX GPU 在同一 Python 进程中的 cuDNN DLL 冲突

## 核心变更

### 1. 新增文件

#### ai_service/whisperx/worker.py (230 行)
- 独立 worker 进程，支持模块运行方式
- 使用 argparse 解析命令行参数：--request, --output
- 读取 request.json：{video_path, model_config}
- 执行 transcribe_audio()
- 生成结构化 output.json（成功或错误）
- 原子写入（tempfile + os.replace）
- GPU 清理：torch.cuda.empty_cache() + gc.collect()
- exit code: 0 成功, 非 0 失败

运行方式：
  python -m ai_service.whisperx.worker --request req.json --output out.json

#### ai_service/whisperx/runner.py (170 行)
- 主进程调用器，通过 subprocess 启动 worker
- 创建临时目录和 request.json
- subprocess.run() 启动 worker，不使用 shell=True
- 支持超时控制（timeout_seconds，默认 3600）
- 解析 output.json 结果
- 错误处理：超时、缺少文件、损坏 JSON
- 路径支持：空格、中文字符（使用 str() 转换）
- 清理：finally 块删除临时文件

导出类：
  - WhisperXWorkerError：worker 执行失败异常
  - run_whisperx_worker()：主入口函数

### 2. 修改文件

#### ai_service/config.py
- 添加 whisperx_worker_timeout_seconds 配置（默认 3600 秒）
- 从环境变量 WHISPERX_WORKER_TIMEOUT_SECONDS 读取

#### ai_service/.env.example
- 添加配置示例 WHISPERX_WORKER_TIMEOUT_SECONDS=3600

#### ai_service/main.py
- 导入变更：
  移除：transcribe_audio, WhisperXModelConfig
  添加：run_whisperx_worker, WhisperXWorkerError 从 runner
- _run_audio_job() 函数重构：
  从直接调用 transcribe_audio() 改为 run_whisperx_worker()
  构建 model_config 字典传入 runner
  进度更新优化（5→10→90→100）

#### ai_service/README.md
- 添加"进程隔离架构"章节
- 说明 worker/runner/adapter 的关系
- 配置说明

#### ai_service/tests/test_audio_job_api.py
- monkeypatch 改为 run_whisperx_worker 而非 transcribe_audio
- 测试函数签名：fake_run_worker(_path, config, *, timeout_seconds=None)

#### ai_service/tests/test_runner_worker.py (新增)
- 9 个单元测试覆盖 runner 和 worker
- 成功输出解析
- 错误处理
- 超时
- 文件操作

#### ai_service/tests/test_process_isolation.py (新增)
- 3 个测试验证进程隔离
- 确认主进程不导入 torch/whisperx
- 确认 runner 不导入 GPU 依赖

## 进程隔离验证

✓ 主进程导入测试
  python -c "import ai_service.main; assert 'torch' not in sys.modules"
  Result: PASS - torch 和 whisperx 未被导入

✓ 进程隔离单元测试
  - test_main_import_does_not_load_cuda_deps: PASS
  - test_runner_import_does_not_load_cuda: PASS
  - test_whisperx_installed_check_does_not_import: PASS

✓ API 兼容性测试
  - test_audio_job_is_independent_and_exposes_word_timestamps: PASS
  - test_unavailable_whisperx_fails_only_audio_job: PASS
  - test_legacy_job_record_defaults_new_track_fields: PASS

## 测试结果

总测试数：110
通过：110
失败：0
时间：6-7 秒

测试覆盖：
- 音频 job API（3 个）
- Runner 和 worker（9 个）
- 进程隔离（3 个）
- OCR 相关（28 个）
- 时序对齐（23 个）
- 其他（44 个）

## 架构图

FastAPI 主进程
├─ /health：检查 PaddleOCR、WhisperX 安装（不导入第三方库）
├─ /jobs：PaddleOCR 视觉字幕（使用 PaddleOCR GPU）
├─ /audio-jobs：WhisperX 音频字幕
│  ├─ 上传音视频 → audio_executor.submit(_run_audio_job)
│  └─ _run_audio_job()
│     └─ run_whisperx_worker() [runner.py]
│        ├─ 创建 request.json
│        └─ subprocess.run([python, -m, ai_service.whisperx.worker, ...])
│           └─ worker subprocess
│              ├─ from ai_service.whisperx.adapter import transcribe_audio
│              ├─ import torch, whisperx, pyannote (仅在 worker 内)
│              ├─ 执行 transcribe_audio()
│              └─ 写入 output.json
│        ├─ 读取 output.json
│        ├─ 解析字幕
│        └─ 更新 audio_job

GPU 内存隔离：
- PaddleOCR (cuDNN 9.5.1) ← 主进程 GPU 内存
- WhisperX (cuDNN 9.10.2) ← Worker 子进程 GPU 内存

## Worker 通信格式

Request JSON:
{
  "video_path": "D:\\path\\source.mp4",
  "model_config": {
    "model": "small",
    "device": "cuda",
    "compute_type": "float16",
    "batch_size": 2,
    "language": null
  }
}

Output JSON (成功):
{
  "ok": true,
  "subtitles": [
    {
      "text": "hello world",
      "start": 1.0,
      "end": 2.5,
      "words": [
        {
          "word": "hello",
          "start": 1.0,
          "end": 1.5,
          "confidence": 0.9
        }
      ],
      "confidence": 0.88
    }
  ]
}

Output JSON (失败):
{
  "ok": false,
  "error": "错误消息",
  "error_type": "RuntimeError"
}

## 向后兼容性

✓ API 端点不变：
  - POST /audio-jobs
  - GET /audio-jobs/:task_id
  - GET /audio-jobs/:task_id/subtitles

✓ 数据结构不变：
  - AudioSubtitle
  - AudioWord
  - JobRecord

✓ 配置保持兼容：
  - WHISPERX_DEVICE
  - WHISPERX_COMPUTE_TYPE
  - WHISPERX_BATCH_SIZE
  - WHISPERX_LANGUAGE
  - ENABLE_WHISPERX

✓ OCR 流程不变：
  - PaddleOCR 仍使用 OCR_DEVICE=gpu:0
  - 视觉字幕处理不受影响

## 故障隔离

- Worker 超时：audio job failed，OCR job 继续
- Worker 进程崩溃：audio job failed，OCR job 继续
- Worker 输出 JSON 损坏：audio job failed with 详细错误
- Worker 未安装 WhisperX：audio job failed with "WhisperX 未安装"
- PaddleOCR 失败：不影响 audio job

## 配置推荐（GPU 环境）

.env 文件：
```
OCR_DEVICE=gpu:0
WHISPERX_DEVICE=cuda
WHISPERX_COMPUTE_TYPE=float16
WHISPERX_MODEL=small
WHISPERX_BATCH_SIZE=2
WHISPERX_WORKER_TIMEOUT_SECONDS=3600
```

## 验证清单

✓ 1. Worker 可以作为独立模块运行
✓ 2. Runner 通过 subprocess 正确启动 worker
✓ 3. 主进程不导入 torch/whisperx/pyannote
✓ 4. 进程隔离测试通过
✓ 5. API 兼容性测试通过
✓ 6. 所有现有测试通过
✓ 7. Windows 路径处理正确
✓ 8. 超时控制有效
✓ 9. 错误处理完善
✓ 10. 临时文件清理正确

## 已知限制

- Worker 不支持进度流式传输（可来自通信文件）
- 暂未实现 OCR-ASR 融合（按需求）
- 语言自动检测基于 WhisperX，不强制对齐

## 后续优化方向

1. 进度文件通信：worker 可通过进度文件传递细粒度进度
2. GPU 共享：investigate GPU 内存重用（可能性低）
3. Worker 池：缓存 worker 进程以减少启动时间
4. IPC 优化：考虑使用 Unix socket（Windows 限制）
"""
