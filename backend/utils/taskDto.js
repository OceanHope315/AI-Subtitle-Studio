function sharedTaskFields(task) {
  if (!task) return null;
  const id = task.id;
  const videoUrl = `/api/tasks/${encodeURIComponent(id)}/video`;
  const subtitlesUrl = `/api/tasks/${encodeURIComponent(id)}/subtitles`;
  const exportUrl = `/api/tasks/${encodeURIComponent(id)}/export`;
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
    revision: Number.isInteger(task.revision) ? task.revision : 0,
    archived_at: task.archivedAt || null,
    error: task.error || null,
    artifacts: {
      subtitles_url: subtitlesUrl,
      final_srt_url: exportUrl,
    },
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    video_url: videoUrl,
    subtitles_url: subtitlesUrl,
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
