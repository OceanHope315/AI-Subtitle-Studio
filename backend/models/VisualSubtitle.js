import mongoose from "mongoose";

export const visualSubtitleSchema = new mongoose.Schema(
  {
    taskId: { type: String, required: true },
    text: { type: String, default: "" },
    start: { type: Number, required: true, min: 0 },
    end: { type: Number, required: true, min: 0 },
    bbox: { type: [mongoose.Schema.Types.Mixed], default: [] },
    confidence: { type: Number, min: 0, max: 1, default: null },
  },
  { _id: false, minimize: false },
);
