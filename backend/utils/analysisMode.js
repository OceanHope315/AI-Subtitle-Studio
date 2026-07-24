export const ANALYSIS_MODES = Object.freeze({
  AUDIO: "audio",
  AUDIO_VISUAL: "audio_visual",
});

export const ANALYSIS_MODE_VALUES = Object.freeze(Object.values(ANALYSIS_MODES));
export const DEFAULT_ANALYSIS_MODE = ANALYSIS_MODES.AUDIO_VISUAL;

export function analysisModeOf(task) {
  return ANALYSIS_MODE_VALUES.includes(task?.analysisMode)
    ? task.analysisMode
    : DEFAULT_ANALYSIS_MODE;
}

export function isAudioOnlyTask(task) {
  return analysisModeOf(task) === ANALYSIS_MODES.AUDIO;
}
