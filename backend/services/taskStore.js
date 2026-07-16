import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { getVideoTaskModel } from "../models/VideoTask.js";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function normalizeDates(task) {
  if (!task) return null;
  return {
    ...task,
    createdAt: task.createdAt instanceof Date ? task.createdAt.toISOString() : task.createdAt,
    updatedAt: task.updatedAt instanceof Date ? task.updatedAt.toISOString() : task.updatedAt,
  };
}

export class FileTaskStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.tasks = new Map();
    this.writeQueue = Promise.resolve();
    this.mode = "file";
  }

  async initialize() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const tasks = Array.isArray(parsed) ? parsed : parsed.tasks;
      if (!Array.isArray(tasks)) throw new Error("tasks must be an array");
      for (const task of tasks) {
        if (!task?.id) throw new Error("every persisted task must have an id");
        this.tasks.set(task.id, task);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new Error(`Cannot read JSON task database at ${this.filePath}: ${error.message}`, { cause: error });
      }
      await this.persist();
    }
    return this;
  }

  async persist() {
    const payload = `${JSON.stringify({ version: 1, tasks: [...this.tasks.values()] }, null, 2)}\n`;
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, payload, "utf8");
    await fs.rename(temporaryPath, this.filePath);
  }

  enqueueWrite(operation) {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.catch(() => {});
    return result;
  }

  async create(task) {
    return this.enqueueWrite(async () => {
      if (this.tasks.has(task.id)) throw new Error(`Task ${task.id} already exists`);
      const now = new Date().toISOString();
      const next = normalizeDates({ ...clone(task), createdAt: task.createdAt || now, updatedAt: now });
      this.tasks.set(next.id, next);
      try {
        await this.persist();
      } catch (error) {
        this.tasks.delete(next.id);
        throw error;
      }
      return clone(next);
    });
  }

  async list() {
    return [...this.tasks.values()]
      .map(clone)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  async findById(taskId) {
    return clone(this.tasks.get(taskId) || null);
  }

  async update(taskId, patch) {
    return this.enqueueWrite(async () => {
      const current = this.tasks.get(taskId);
      if (!current) return null;
      const previous = clone(current);
      const next = normalizeDates({
        ...current,
        ...clone(patch),
        id: current.id,
        updatedAt: new Date().toISOString(),
      });
      this.tasks.set(taskId, next);
      try {
        await this.persist();
      } catch (error) {
        this.tasks.set(taskId, previous);
        throw error;
      }
      return clone(next);
    });
  }

  async startTask(taskId, roi) {
    return this.enqueueWrite(async () => {
      const current = this.tasks.get(taskId);
      if (!current || current.status !== "awaiting_roi") return null;
      const previous = clone(current);
      const next = normalizeDates({
        ...current,
        status: "queued",
        roi: clone(roi),
        progress: 0,
        message: "Waiting for AI processing",
        error: null,
        updatedAt: new Date().toISOString(),
      });
      this.tasks.set(taskId, next);
      try {
        await this.persist();
      } catch (error) {
        this.tasks.set(taskId, previous);
        throw error;
      }
      return clone(next);
    });
  }

  async close() {
    await this.writeQueue;
  }
}

function mongooseTaskToPlain(document) {
  if (!document) return null;
  const value = document.toObject ? document.toObject() : document;
  const { _id, taskId, ...rest } = value;
  return normalizeDates({ id: taskId, ...rest });
}

export class MongooseTaskStore {
  constructor(connection) {
    this.connection = connection;
    this.model = getVideoTaskModel(connection);
    this.mode = "mongodb";
  }

  static async connect(uri, { dbName, timeoutMs = 3000 } = {}) {
    const connection = mongoose.createConnection(uri, {
      dbName,
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
      maxPoolSize: 10,
    });
    try {
      await connection.asPromise();
      return new MongooseTaskStore(connection);
    } catch (error) {
      await connection.close().catch(() => {});
      throw error;
    }
  }

  async initialize() {
    await this.model.init();
    return this;
  }

  async create(task) {
    const { id, ...fields } = clone(task);
    const document = await this.model.create({ taskId: id, ...fields });
    return mongooseTaskToPlain(document);
  }

  async list() {
    const documents = await this.model.find({}).sort({ createdAt: -1 });
    return documents.map(mongooseTaskToPlain);
  }

  async findById(taskId) {
    return mongooseTaskToPlain(await this.model.findOne({ taskId }));
  }

  async update(taskId, patch) {
    const safePatch = clone(patch);
    delete safePatch.id;
    delete safePatch.taskId;
    delete safePatch.createdAt;
    safePatch.updatedAt = new Date();
    const document = await this.model.findOneAndUpdate(
      { taskId },
      { $set: safePatch },
      { new: true, runValidators: true },
    );
    return mongooseTaskToPlain(document);
  }

  async startTask(taskId, roi) {
    const document = await this.model.findOneAndUpdate(
      { taskId, status: "awaiting_roi" },
      {
        $set: {
          status: "queued",
          roi: clone(roi),
          progress: 0,
          message: "Waiting for AI processing",
          error: null,
          updatedAt: new Date(),
        },
      },
      { new: true, runValidators: true },
    );
    return mongooseTaskToPlain(document);
  }

  async close() {
    await this.connection.close();
  }
}

export async function createTaskStore(config, logger = console) {
  if (config.mongodbUri) {
    let mongoStore;
    try {
      mongoStore = await MongooseTaskStore.connect(config.mongodbUri, {
        dbName: config.mongodbDbName,
        timeoutMs: config.mongodbConnectTimeoutMs,
      });
      await mongoStore.initialize();
      logger.info?.("Task persistence: MongoDB");
      return mongoStore;
    } catch (error) {
      await mongoStore?.close().catch(() => {});
      if (!config.mongodbFallbackToFile) throw error;
      logger.warn?.(`MongoDB unavailable (${error.message}); falling back to JSON file persistence.`);
    }
  } else {
    logger.info?.("MONGODB_URI is not configured; using JSON file persistence.");
  }

  const fileStore = new FileTaskStore(config.fileDbPath);
  await fileStore.initialize();
  logger.info?.(`Task persistence: JSON file (${fileStore.filePath})`);
  return fileStore;
}
