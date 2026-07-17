export const MAX_PROGRESS_THUMBNAILS = 5
export const MAX_FRAME_CANDIDATES = 50

export const STAGE_LABELS = {
  probing: '探测视频信息',
  coarse_ocr: 'PaddleOCR 抽帧识别',
  short_event_discovery: '短字幕事件发现',
  event_aggregation: '字幕事件聚合',
  boundary_refinement: '字幕边界精修',
  whisper_correction: 'Whisper 受限校字',
  artifact_generation: '生成字幕产物',
}

function ownValue(source, keys) {
  if (!source || typeof source !== 'object') return undefined
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      return source[key]
    }
  }
  return undefined
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function nonNegativeInteger(value) {
  const number = finiteNumber(value)
  return number !== null && number >= 0 ? Math.floor(number) : null
}

function boundedProgress(value) {
  const number = finiteNumber(value)
  if (number === null) return null
  return Math.max(0, Math.min(100, number))
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function createEmptyAnalysisProgress() {
  return {
    runId: '',
    lastSeq: 0,
    stage: '',
    stageLabel: '等待分析事件',
    message: '',
    overallProgress: 0,
    stageProgress: null,
    processed: 0,
    total: null,
    detectedCueCount: 0,
    frame: null,
    previewFrame: null,
    thumbnails: [],
    terminal: null,
    failureMessage: '',
  }
}

export function getAnalysisSnapshot(task) {
  if (!task || typeof task !== 'object') return null
  const summary = ownValue(task, [
    'progress_snapshot',
    'progressSnapshot',
    'analysis_progress',
    'analysisProgress',
  ]) || {}
  const latestEvent = parseMaybeJson(
    ownValue(summary, ['latest_event', 'latestEvent'])
      ?? ownValue(task, ['latest_event', 'latestEvent']),
  )
  let latestFrameEvent = parseMaybeJson(
    ownValue(summary, ['latest_frame_event', 'latestFrameEvent'])
      ?? ownValue(task, ['latest_frame_event', 'latestFrameEvent']),
  )
  if (!latestFrameEvent) {
    const latestFrame = parseMaybeJson(
      ownValue(summary, ['latest_frame', 'latestFrame'])
        ?? ownValue(task, ['latest_frame', 'latestFrame']),
    )
    if (latestFrame && typeof latestFrame === 'object') {
      latestFrameEvent = latestFrame.type
        ? latestFrame
        : { type: 'frame.analyzed', payload: latestFrame }
    }
  }
  const latestPreviewEvent = parseMaybeJson(
    ownValue(summary, ['latest_preview_event', 'latestPreviewEvent'])
      ?? ownValue(task, ['latest_preview_event', 'latestPreviewEvent']),
  )
  return {
    summary,
    latestEvent: latestEvent && typeof latestEvent === 'object' ? latestEvent : null,
    latestFrameEvent: latestFrameEvent && typeof latestFrameEvent === 'object'
      ? latestFrameEvent
      : null,
    latestPreviewEvent: latestPreviewEvent && typeof latestPreviewEvent === 'object'
      ? latestPreviewEvent
      : null,
    runId: String(
      ownValue(summary, ['run_id', 'runId'])
        ?? ownValue(task, ['run_id', 'runId'])
        ?? latestEvent?.run_id
        ?? latestEvent?.runId
        ?? latestFrameEvent?.run_id
        ?? latestFrameEvent?.runId
        ?? latestPreviewEvent?.run_id
        ?? latestPreviewEvent?.runId
        ?? '',
    ),
    latestSeq: nonNegativeInteger(
      ownValue(summary, ['latest_seq', 'latestSeq'])
        ?? ownValue(task, ['latest_seq', 'latestSeq'])
        ?? latestEvent?.seq
        ?? latestFrameEvent?.seq
        ?? latestPreviewEvent?.seq,
    ) || 0,
  }
}

function normalizeRoi(value) {
  if (!value || typeof value !== 'object') return null
  const x = finiteNumber(value.x)
  const y = finiteNumber(value.y)
  const width = finiteNumber(value.width ?? value.w)
  const height = finiteNumber(value.height ?? value.h)
  if ([x, y, width, height].some((number) => number === null)) return null
  return { x, y, width, height }
}

function normalizeCandidate(candidate, fallbackCoordinateSpace) {
  if (!candidate || typeof candidate !== 'object') return null
  const confidence = finiteNumber(candidate.confidence ?? candidate.score)
  return {
    text: String(candidate.text ?? candidate.value ?? ''),
    confidence,
    position: candidate.position ?? candidate.box ?? candidate.bbox ?? null,
    coordinateSpace: String(
      candidate.coordinate_space
        ?? candidate.coordinateSpace
        ?? fallbackCoordinateSpace
        ?? 'video',
    ),
  }
}

function normalizeFrame(payload, event) {
  const preview = payload.preview || payload.previews || {}
  const framePreview = preview.frame || preview.original || preview.annotated || {}
  const roiPreview = preview.roi || {}
  const coordinateSpace = payload.coordinate_space || payload.coordinateSpace || 'video'
  const candidates = (Array.isArray(payload.candidates) ? payload.candidates : [])
    .slice(0, MAX_FRAME_CANDIDATES)
    .map((candidate) => normalizeCandidate(candidate, coordinateSpace))
    .filter(Boolean)
  const previewId = String(
    payload.preview_id
      ?? payload.previewId
      ?? payload.frame_preview_id
      ?? payload.framePreviewId
      ?? framePreview.id
      ?? framePreview.preview_id
      ?? '',
  )
  const roiPreviewId = String(
    payload.roi_preview_id
      ?? payload.roiPreviewId
      ?? roiPreview.id
      ?? roiPreview.preview_id
      ?? '',
  )

  return {
    frameIndex: nonNegativeInteger(payload.frame_index ?? payload.frameIndex),
    pts: finiteNumber(payload.pts),
    timeBaseNum: finiteNumber(payload.time_base_num ?? payload.timeBaseNum),
    timeBaseDen: finiteNumber(payload.time_base_den ?? payload.timeBaseDen),
    mediaTime: finiteNumber(payload.media_time ?? payload.mediaTime),
    processed: nonNegativeInteger(payload.processed),
    total: nonNegativeInteger(payload.total),
    detectedCueCount: nonNegativeInteger(
      payload.detected_cue_count ?? payload.detectedCueCount ?? payload.cue_count,
    ),
    roi: normalizeRoi(payload.roi),
    candidates,
    coordinateSpace: String(coordinateSpace),
    previewId,
    roiPreviewId,
    frameWidth: nonNegativeInteger(
      payload.video_width
        ?? payload.videoWidth
        ?? payload.frame_width
        ?? payload.frameWidth
        ?? framePreview.source_width
        ?? framePreview.sourceWidth,
    ),
    frameHeight: nonNegativeInteger(
      payload.video_height
        ?? payload.videoHeight
        ?? payload.frame_height
        ?? payload.frameHeight
        ?? framePreview.source_height
        ?? framePreview.sourceHeight,
    ),
    previewWidth: nonNegativeInteger(framePreview.width),
    previewHeight: nonNegativeInteger(framePreview.height),
    roiPreviewWidth: nonNegativeInteger(roiPreview.width),
    roiPreviewHeight: nonNegativeInteger(roiPreview.height),
    seq: nonNegativeInteger(event.seq),
    runId: String(event.run_id ?? event.runId ?? ''),
    occurredAt: String(event.occurred_at ?? event.occurredAt ?? ''),
  }
}

function resetForRun(runId) {
  return { ...createEmptyAnalysisProgress(), runId }
}

function applyTaskTerminalSummary(current, task) {
  if (task?.status === 'completed') {
    if (current.terminal === 'completed' && current.overallProgress === 100) return current
    return { ...current, terminal: 'completed', overallProgress: 100 }
  }
  if (task?.status === 'failed') {
    const failureMessage = String(
      task.error || task.message || current.failureMessage || '视频分析失败。',
    )
    if (current.terminal === 'failed' && current.failureMessage === failureMessage) return current
    return { ...current, terminal: 'failed', failureMessage }
  }
  return current
}

export function reduceAnalysisEvent(current, rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') return current
  const payload = rawEvent.payload && typeof rawEvent.payload === 'object'
    ? rawEvent.payload
    : rawEvent
  const type = String(rawEvent.type ?? rawEvent.event ?? '')
  const incomingRunId = String(rawEvent.run_id ?? rawEvent.runId ?? current.runId ?? '')
  const incomingSeq = nonNegativeInteger(rawEvent.seq) || 0

  if (incomingRunId && incomingRunId === current.runId && incomingSeq > 0 && incomingSeq <= current.lastSeq) {
    return current
  }

  let next = incomingRunId && incomingRunId !== current.runId
    ? resetForRun(incomingRunId)
    : { ...current }
  if (!next.runId && incomingRunId) next.runId = incomingRunId
  if (incomingSeq > 0) next.lastSeq = incomingSeq

  const stage = ownValue(payload, ['stage'])
  if (stage !== undefined && stage !== null) next.stage = String(stage)
  const stageLabel = ownValue(payload, ['stage_label', 'stageLabel'])
  if (stageLabel !== undefined && stageLabel !== null) next.stageLabel = String(stageLabel)
  else if (next.stage && STAGE_LABELS[next.stage]) next.stageLabel = STAGE_LABELS[next.stage]
  const message = ownValue(payload, ['message'])
  if (message !== undefined && message !== null) next.message = String(message)

  const overallProgress = boundedProgress(
    ownValue(payload, ['overall_progress', 'overallProgress', 'progress']),
  )
  if (overallProgress !== null) next.overallProgress = overallProgress
  const stageProgress = boundedProgress(ownValue(payload, ['stage_progress', 'stageProgress']))
  if (stageProgress !== null) next.stageProgress = stageProgress
  const processed = nonNegativeInteger(ownValue(payload, ['processed']))
  const total = nonNegativeInteger(ownValue(payload, ['total']))
  const cueCount = nonNegativeInteger(
    ownValue(payload, [
      'detected_cue_count',
      'detectedCueCount',
      'cue_count',
      'cueCount',
      'subtitle_count',
      'subtitleCount',
    ]),
  )
  if (processed !== null) next.processed = processed
  if (total !== null) next.total = total
  if (cueCount !== null) next.detectedCueCount = cueCount

  if (type === 'frame.analyzed') {
    const frame = normalizeFrame(payload, rawEvent)
    next.frame = frame
    if (frame.processed !== null) next.processed = frame.processed
    if (frame.total !== null) next.total = frame.total
    if (frame.detectedCueCount !== null) next.detectedCueCount = frame.detectedCueCount
    if (frame.previewId) {
      next.previewFrame = frame
      const thumbnail = {
        key: `${next.runId}:${incomingSeq}:${frame.previewId}`,
        runId: next.runId,
        seq: incomingSeq,
        previewId: frame.previewId,
        frameIndex: frame.frameIndex,
        mediaTime: frame.mediaTime,
      }
      next.thumbnails = [
        ...next.thumbnails.filter((item) => item.previewId !== frame.previewId),
        thumbnail,
      ].slice(-MAX_PROGRESS_THUMBNAILS)
    }
  }

  if (type === 'job.completed') {
    next.terminal = 'completed'
    next.overallProgress = 100
    next.stageLabel = stageLabel ? String(stageLabel) : '分析完成'
  } else if (type === 'job.failed') {
    next.terminal = 'failed'
    next.failureMessage = String(
      ownValue(payload, ['error', 'message', 'detail']) || 'AI 服务处理视频时遇到问题。',
    )
    next.stageLabel = stageLabel ? String(stageLabel) : '分析失败'
  }

  return next
}

export function hydrateAnalysisSnapshot(current, task) {
  const snapshot = getAnalysisSnapshot(task)
  if (!snapshot) return current
  if (
    snapshot.runId
    && snapshot.runId === current.runId
    && snapshot.latestSeq > 0
    && snapshot.latestSeq <= current.lastSeq
  ) return applyTaskTerminalSummary(current, task)

  let next = current
  if (snapshot.runId && snapshot.runId !== current.runId) next = resetForRun(snapshot.runId)
  if (snapshot.latestPreviewEvent) {
    const previewEvent = {
      ...snapshot.latestPreviewEvent,
      type: 'frame.analyzed',
      run_id: snapshot.latestPreviewEvent.run_id
        ?? snapshot.latestPreviewEvent.runId
        ?? snapshot.runId,
    }
    const preservedCursor = next.lastSeq
    next = reduceAnalysisEvent({ ...next, lastSeq: 0 }, previewEvent)
    if (next.lastSeq < preservedCursor) next = { ...next, lastSeq: preservedCursor }
  }
  if (snapshot.latestFrameEvent) {
    const frameEvent = {
      ...snapshot.latestFrameEvent,
      type: 'frame.analyzed',
      run_id: snapshot.latestFrameEvent.run_id
        ?? snapshot.latestFrameEvent.runId
        ?? snapshot.runId,
    }
    const preservedCursor = next.lastSeq
    const frameBase = finiteNumber(frameEvent.seq) < preservedCursor
      ? { ...next, lastSeq: 0 }
      : next
    next = reduceAnalysisEvent(frameBase, frameEvent)
    if (next.lastSeq < preservedCursor) next = { ...next, lastSeq: preservedCursor }
  }
  if (snapshot.latestEvent) {
    const event = {
      ...snapshot.latestEvent,
      run_id: snapshot.latestEvent.run_id ?? snapshot.latestEvent.runId ?? snapshot.runId,
      seq: snapshot.latestEvent.seq ?? snapshot.latestSeq,
    }
    next = reduceAnalysisEvent(next, event)
  }

  const summary = snapshot.summary || {}
  const snapshotProgress = boundedProgress(
    ownValue(summary, ['overall_progress', 'overallProgress', 'progress'])
      ?? ownValue(task, ['progress']),
  )
  const snapshotMessage = ownValue(summary, ['message']) ?? ownValue(task, ['message'])
  const snapshotStage = ownValue(summary, ['stage'])
  const snapshotStageLabel = ownValue(summary, ['stage_label', 'stageLabel'])
  const processed = nonNegativeInteger(ownValue(summary, ['processed']))
  const total = nonNegativeInteger(ownValue(summary, ['total']))
  const cueCount = nonNegativeInteger(
    ownValue(summary, ['detected_cue_count', 'detectedCueCount', 'cue_count', 'cueCount'])
      ?? (task?.status === 'completed'
        ? ownValue(task, ['subtitle_count', 'subtitleCount'])
        : undefined),
  )
  next = { ...next }
  if (snapshot.latestSeq > next.lastSeq) next.lastSeq = snapshot.latestSeq
  if (snapshotProgress !== null) next.overallProgress = snapshotProgress
  if (snapshotMessage !== undefined && snapshotMessage !== null) next.message = String(snapshotMessage)
  if (snapshotStage !== undefined && snapshotStage !== null) next.stage = String(snapshotStage)
  if (snapshotStageLabel !== undefined && snapshotStageLabel !== null) {
    next.stageLabel = String(snapshotStageLabel)
  } else if (next.stage && STAGE_LABELS[next.stage]) {
    next.stageLabel = STAGE_LABELS[next.stage]
  }
  if (processed !== null) next.processed = processed
  if (total !== null) next.total = total
  if (cueCount !== null) next.detectedCueCount = cueCount

  next = applyTaskTerminalSummary(next, task)
  const unchanged = [
    'runId',
    'lastSeq',
    'stage',
    'stageLabel',
    'message',
    'overallProgress',
    'stageProgress',
    'processed',
    'total',
    'detectedCueCount',
    'frame',
    'previewFrame',
    'thumbnails',
    'terminal',
    'failureMessage',
  ].every((key) => next[key] === current[key])
  return unchanged ? current : next
}
