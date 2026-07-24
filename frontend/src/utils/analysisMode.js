export const ANALYSIS_MODES = Object.freeze({
  AUDIO: 'audio',
  AUDIO_VISUAL: 'audio_visual',
})

export function normalizeAnalysisMode(value) {
  return value === ANALYSIS_MODES.AUDIO
    ? ANALYSIS_MODES.AUDIO
    : ANALYSIS_MODES.AUDIO_VISUAL
}

export function getTaskAnalysisMode(task) {
  return normalizeAnalysisMode(task?.analysis_mode ?? task?.analysisMode)
}

export function isAudioOnlyMode(value) {
  return normalizeAnalysisMode(value) === ANALYSIS_MODES.AUDIO
}
