import mongoose from "mongoose";

export const audioWordSchema = new mongoose.Schema(
  {
    word: { type: String, required: true },
    start: { type: Number, min: 0, default: null },
    end: { type: Number, min: 0, default: null },
    confidence: { type: Number, min: 0, max: 1, default: null },
  },
  { _id: false },
);

export const audioSubtitleSchema = new mongoose.Schema(
  {
    taskId: { type: String, required: true },
    text: { type: String, default: "" },
    start: { type: Number, min: 0, default: null },
    end: { type: Number, min: 0, default: null },
    words: { type: [audioWordSchema], default: [] },
    confidence: { type: Number, min: 0, max: 1, default: null },
  },
  { _id: false, minimize: false },
);
