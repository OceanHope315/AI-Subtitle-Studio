import mongoose from "mongoose";
import { audioSubtitleSchema } from "./AudioSubtitle.js";
import { visualSubtitleSchema } from "./VisualSubtitle.js";

const sourceStatusValues = ["pending", "queued", "processing", "completed", "failed"];

const subtitleSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    text: { type: String, default: "" },
    start_time: { type: Number, required: true, min: 0 },
    end_time: { type: Number, required: true, min: 0 },
    confidence: { type: Number, min: 0, max: 1, default: null },
    position: { type: mongoose.Schema.Types.Mixed, default: null },
    source: { type: String, default: null },
    start_frame: { type: Number, min: 0, default: null },
    end_frame_exclusive: { type: Number, min: 1, default: null },
    start_pts: { type: Number, default: null },
    end_pts: { type: Number, default: null },
    time_base: { type: String, default: null },
  },
  { _id: false },
);

const roiSchema = new mongoose.Schema(
  {
    x: { type: Number, required: true, min: 0, max: 1 },
    y: { type: Number, required: true, min: 0, max: 1 },
    width: { type: Number, required: true, min: 0.01, max: 1 },
    height: { type: Number, required: true, min: 0.01, max: 1 },
  },
  { _id: false },
);

export const videoTaskSchema = new mongoose.Schema(
  {
    taskId: { type: String, required: true, unique: true, index: true },
    filename: { type: String, required: true },
    storedFilename: { type: String, required: true },
    videoPath: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ["awaiting_roi", "queued", "processing", "completed", "failed"],
      default: "awaiting_roi",
      index: true,
    },
    roi: { type: roiSchema, default: null },
    progress: { type: Number, min: 0, max: 100, default: 0 },
    message: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    subtitles: { type: [subtitleSchema], default: [] },
    visualSubtitles: { type: [visualSubtitleSchema], default: [] },
    audioSubtitles: { type: [audioSubtitleSchema], default: [] },
    visualStatus: { type: String, enum: sourceStatusValues, default: "pending", index: true },
    audioStatus: { type: String, enum: sourceStatusValues, default: "pending", index: true },
    visualProgress: { type: Number, min: 0, max: 100, default: 0 },
    audioProgress: { type: Number, min: 0, max: 100, default: 0 },
    visualError: { type: String, default: null },
    audioError: { type: String, default: null },
    visualJobId: { type: String, default: null },
    audioJobId: { type: String, default: null },
    revision: { type: Number, min: 0, default: 0 },
    archivedAt: { type: Date, default: null, index: true },
    error: { type: String, default: null },
    artifacts: { type: mongoose.Schema.Types.Mixed, default: {} },
    aiJobId: { type: String, default: null },
    progressSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  {
    timestamps: true,
    minimize: false,
    versionKey: false,
  },
);

export function getVideoTaskModel(connection) {
  return connection.models.VideoTask || connection.model("VideoTask", videoTaskSchema);
}
