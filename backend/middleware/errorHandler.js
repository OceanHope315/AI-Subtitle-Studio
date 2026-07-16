import multer from "multer";
import { AppError } from "../utils/errors.js";

export function notFoundHandler(req, _res, next) {
  next(new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`, "ROUTE_NOT_FOUND"));
}

export function errorHandler(error, _req, res, _next) {
  let status = error.status || error.statusCode || 500;
  let code = error.code || "INTERNAL_ERROR";
  let message = error.message || "Internal server error";
  let details = error.details;

  if (error instanceof multer.MulterError) {
    status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    code = error.code;
    message = error.code === "LIMIT_FILE_SIZE"
      ? "Uploaded video exceeds the configured size limit"
      : `Invalid multipart upload: ${error.message}`;
  } else if (error instanceof SyntaxError && error.type === "entity.parse.failed") {
    status = 400;
    code = "INVALID_JSON";
    message = "Request body contains invalid JSON";
  } else if (error.name === "ValidationError") {
    status = 400;
    code = "VALIDATION_ERROR";
    details = Object.values(error.errors || {}).map((item) => item.message);
  }

  if (status >= 500) {
    console.error(error);
    if (process.env.NODE_ENV === "production") message = "Internal server error";
  }

  const payload = { message, error: { code, message } };
  if (details !== undefined) payload.error.details = details;
  res.status(status).json(payload);
}
