const RUN_ID_PATTERN = /^[a-f0-9]{32}$/;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

function nonNegativeSafeInteger(value, fallback = null) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeEnvelope(value, taskId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI service returned an invalid event response");
  }
  const responseTaskId = String(value.task_id || "");
  const latestSeq = nonNegativeSafeInteger(value.latest_seq);
  if (responseTaskId !== taskId || latestSeq === null) {
    throw new Error("AI service returned an invalid event cursor");
  }
  if (!Array.isArray(value.events)) {
    throw new Error("AI service returned an invalid event list");
  }
  // Legacy queued job snapshots can briefly have no run yet. This is a valid
  // empty state, not a malformed cursor; keep polling until processing assigns
  // the run without producing noisy warnings or closing browser SSE streams.
  if (value.run_id === null && latestSeq === 0 && value.events.length === 0) {
    return { taskId, runId: null, latestSeq: 0, events: [], hasMore: false };
  }
  const runId = String(value.run_id || "");
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error("AI service returned an invalid event cursor");
  }

  const unique = new Map();
  for (const event of value.events) {
    const seq = nonNegativeSafeInteger(event?.seq);
    const eventTaskId = String(event?.task_id || "");
    const eventRunId = String(event?.run_id || "");
    const type = String(event?.type || "");
    if (
      seq === null
      || seq === 0
      || seq > latestSeq
      || eventTaskId !== taskId
      || eventRunId !== runId
      || !EVENT_TYPE_PATTERN.test(type)
    ) {
      continue;
    }
    const key = `${eventRunId}:${seq}`;
    if (!unique.has(key)) unique.set(key, { ...event, seq, task_id: taskId, run_id: runId, type });
  }
  const events = [...unique.values()].sort((left, right) => left.seq - right.seq);
  return { taskId, runId, latestSeq, events, hasMore: value.has_more === true };
}

export class ProgressEventHub {
  constructor({ aiClient, pollIntervalMs = 500, logger = console }) {
    if (!aiClient || typeof aiClient.getEvents !== "function") {
      throw new TypeError("ProgressEventHub requires an AI client with getEvents()");
    }
    this.aiClient = aiClient;
    this.pollIntervalMs = Math.max(10, Number(pollIntervalMs) || 500);
    this.logger = logger;
    this.channels = new Map();
    this.closed = false;
  }

  subscribe(taskId, {
    afterSeq = 0,
    runId = null,
    onEvent,
    onPollError,
    onClose,
  } = {}) {
    if (this.closed) throw new Error("ProgressEventHub is closed");
    if (typeof onEvent !== "function") throw new TypeError("onEvent must be a function");
    let channel = this.channels.get(taskId);
    if (!channel) {
      channel = {
        taskId,
        runId: null,
        subscribers: new Set(),
        timer: null,
        polling: false,
        abortController: null,
        lastLoggedError: null,
      };
      this.channels.set(taskId, channel);
    }

    const subscriber = {
      runId,
      seq: nonNegativeSafeInteger(afterSeq, 0),
      seen: new Set(),
      seenOrder: [],
      onEvent,
      onPollError,
      onClose,
    };
    channel.subscribers.add(subscriber);
    this.schedule(channel, 0);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      channel.subscribers.delete(subscriber);
      if (channel.subscribers.size === 0) this.disposeChannel(channel);
    };
  }

  schedule(channel, delay = this.pollIntervalMs) {
    if (this.closed || channel.subscribers.size === 0 || channel.timer || channel.polling) return;
    channel.timer = setTimeout(() => {
      channel.timer = null;
      void this.poll(channel);
    }, Math.max(0, delay));
    channel.timer.unref?.();
  }

  pollAfter(channel) {
    let afterSeq = Number.MAX_SAFE_INTEGER;
    for (const subscriber of channel.subscribers) {
      if (channel.runId && subscriber.runId && subscriber.runId !== channel.runId) return 0;
      afterSeq = Math.min(afterSeq, subscriber.seq);
    }
    return afterSeq === Number.MAX_SAFE_INTEGER ? 0 : afterSeq;
  }

  async poll(channel) {
    if (
      this.closed
      || channel.polling
      || channel.subscribers.size === 0
      || this.channels.get(channel.taskId) !== channel
    ) return;

    channel.polling = true;
    const requestedAfter = this.pollAfter(channel);
    const controller = new AbortController();
    channel.abortController = controller;
    let replayImmediately = false;
    try {
      const value = await this.aiClient.getEvents(channel.taskId, requestedAfter, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || channel.subscribers.size === 0) return;
      const envelope = normalizeEnvelope(value, channel.taskId);
      channel.lastLoggedError = null;
      if (envelope.runId === null) return;
      channel.runId = envelope.runId;

      let cursorReset = false;
      for (const subscriber of channel.subscribers) {
        if (subscriber.runId && subscriber.runId !== envelope.runId) {
          subscriber.runId = envelope.runId;
          subscriber.seq = 0;
          subscriber.seen.clear();
          subscriber.seenOrder.length = 0;
          cursorReset = true;
        } else if (!subscriber.runId) {
          subscriber.runId = envelope.runId;
          if (subscriber.seq > envelope.latestSeq) {
            subscriber.seq = 0;
            cursorReset = true;
          }
        } else if (subscriber.seq > envelope.latestSeq) {
          // A persisted/browser cursor can be ahead after crash-tail repair or
          // restoring a stale snapshot. The same run must not poll forever at
          // an impossible sequence.
          subscriber.seq = 0;
          subscriber.seen.clear();
          subscriber.seenOrder.length = 0;
          cursorReset = true;
        }
      }

      // A cursor from a previous run can be numerically ahead of the new run.
      // Probe once to learn the run, then replay from zero before broadcasting so
      // the receiving client never observes the new run out of order.
      if (cursorReset && requestedAfter > 0) {
        replayImmediately = true;
        return;
      }

      for (const event of envelope.events) {
        const key = `${event.run_id}:${event.seq}`;
        for (const subscriber of [...channel.subscribers]) {
          if (subscriber.runId !== event.run_id || event.seq <= subscriber.seq || subscriber.seen.has(key)) {
            continue;
          }
          try {
            subscriber.onEvent(event);
            subscriber.seq = event.seq;
            subscriber.seen.add(key);
            subscriber.seenOrder.push(key);
            if (subscriber.seenOrder.length > 256) {
              subscriber.seen.delete(subscriber.seenOrder.shift());
            }
          } catch (error) {
            subscriber.onPollError?.(error);
          }
        }
      }
      if (envelope.hasMore) replayImmediately = true;
    } catch (error) {
      if (!controller.signal.aborted) {
        for (const subscriber of [...channel.subscribers]) subscriber.onPollError?.(error);
        const signature = `${error?.code || error?.name || "Error"}:${error?.message || error}`;
        if (channel.lastLoggedError !== signature) {
          channel.lastLoggedError = signature;
          this.logger.warn?.(`AI progress event poll failed for ${channel.taskId}: ${error?.message || error}`);
        }
      }
    } finally {
      channel.polling = false;
      if (channel.abortController === controller) channel.abortController = null;
      if (channel.subscribers.size > 0 && this.channels.get(channel.taskId) === channel) {
        this.schedule(channel, replayImmediately ? 0 : this.pollIntervalMs);
      }
    }
  }

  disposeChannel(channel) {
    if (channel.timer) clearTimeout(channel.timer);
    channel.timer = null;
    channel.abortController?.abort();
    channel.abortController = null;
    this.channels.delete(channel.taskId);
  }

  subscriberCount(taskId) {
    return this.channels.get(taskId)?.subscribers.size || 0;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const closeCallbacks = [];
    for (const channel of this.channels.values()) {
      for (const subscriber of channel.subscribers) {
        if (typeof subscriber.onClose === "function") closeCallbacks.push(subscriber.onClose);
      }
      channel.subscribers.clear();
      this.disposeChannel(channel);
    }
    this.channels.clear();
    for (const callback of closeCallbacks) {
      try {
        callback();
      } catch {
        // Closing one HTTP client must not prevent the remaining clients from
        // being released during application shutdown.
      }
    }
  }
}

export { EVENT_TYPE_PATTERN, RUN_ID_PATTERN, normalizeEnvelope };
