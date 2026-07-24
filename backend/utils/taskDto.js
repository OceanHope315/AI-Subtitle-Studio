function sharedTaskFields(task) {
  if (!task) return null;
  const id = task.id;
  const videoUrl = `/api/tasks/${encodeURIComponent(id)}/video`;
  const subtitlesUrl = `/api/tasks/${encodeURIComponent(id)}/subtitles`;
  const visualSubtitlesUrl = `/api/tasks/${encodeURIComponent(id)}/visual-subtitles`;
  const audioSubtitlesUrl = `/api/tasks/${encodeURIComponent(id)}/audio-subtitles`;
  const exportUrl = `/api/tasks/${encodeURIComponent(id)}/export`;
  const sourceStatus = (source) => {
    const value = task[`${source}Status`];
    if (["pending", "queued", "processing", "completed", "failed"].includes(value)) return value;
    if (source === "visual" && ["queued", "processing", "completed", "failed"].includes(task.status)) {
      return task.status;
    }
    return "pending";
  };
  const sourceProgress = (source) => {
    const value = Number(task[`${source}Progress`]);
    if (Number.isFinite(value)) return Math.min(100, Math.max(0, value));
    if (source === "visual") return Number.isFinite(Number(task.progress)) ? Number(task.progress) : 0;
    return 0;
  };
  return {
    id,
    taskId: id,
    task_id: id,
    filename: task.filename,
    status: task.status,
    roi: task.roi || null,
    progress: task.progress,
    message: task.message || null,
    metadata: task.metadata || {},
    subtitle_count: Number.isInteger(task.subtitleCount) ? task.subtitleCount : (task.subtitles?.length || 0),
    visual_status: sourceStatus("visual"),
    audio_status: sourceStatus("audio"),
    visual_progress: sourceProgress("visual"),
    audio_progress: sourceProgress("audio"),
    visual_error: task.visualError || null,
    audio_error: task.audioError || null,
    visual_subtitle_count: Number.isInteger(task.visualSubtitleCount)
      ? task.visualSubtitleCount
      : (task.visualSubtitles?.length || 0),
    audio_subtitle_count: Number.isInteger(task.audioSubtitleCount)
      ? task.audioSubtitleCount
      : (task.audioSubtitles?.length || 0),
    revision: Number.isInteger(task.revision) ? task.revision : 0,
    archived_at: task.archivedAt || null,
    error: task.error || null,
    artifacts: {
      subtitles_url: subtitlesUrl,
      visual_subtitles_url: visualSubtitlesUrl,
      audio_subtitles_url: audioSubtitlesUrl,
      final_srt_url: exportUrl,
    },
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    video_url: videoUrl,
    subtitles_url: subtitlesUrl,
    visual_subtitles_url: visualSubtitlesUrl,
    audio_subtitles_url: audioSubtitlesUrl,
    export_url: exportUrl,
  };
}

export function taskToDto(task) {
  const shared = sharedTaskFields(task);
  if (!shared) return null;
  const progressSnapshot = task.progressSnapshot && typeof task.progressSnapshot === "object"
    ? {
      run_id: task.progressSnapshot.run_id || null,
      latest_seq: Number.isSafeInteger(task.progressSnapshot.latest_seq)
        ? task.progressSnapshot.latest_seq
        : 0,
      latest_event: task.progressSnapshot.latest_event || null,
      latest_frame_event: task.progressSnapshot.latest_frame_event || null,
      latest_preview_event: task.progressSnapshot.latest_preview_event || null,
    }
    : null;
  return {
    ...shared,
    subtitles: task.subtitles || [],
    progress_snapshot: progressSnapshot,
    run_id: progressSnapshot?.run_id || null,
    latest_seq: progressSnapshot?.latest_seq || 0,
    latest_event: progressSnapshot?.latest_event || null,
    latest_frame_event: progressSnapshot?.latest_frame_event || null,
    latest_preview_event: progressSnapshot?.latest_preview_event || null,
    events_url: `/api/tasks/${encodeURIComponent(task.id)}/events`,
  };
}

export function taskToSummaryDto(task) {
  return sharedTaskFields(task);
}
