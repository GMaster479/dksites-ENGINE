// In-memory job store for the polling model. /generate kicks off a background job and
// returns a jobId immediately; the front end polls /status/:jobId until it's done.
// In-memory is fine for a single always-on process; if we ever scale to multiple
// instances, this moves to Redis. Jobs self-expire so the map can't grow unbounded.

import { randomUUID } from 'node:crypto';

const jobs = new Map();
const TTL_MS = 1000 * 60 * 30; // keep finished jobs 30 min for polling

export function createJob() {
  const id = randomUUID();
  jobs.set(id, { id, status: 'queued', stage: 'Starting…', progress: 0, result: null, error: null, createdAt: Date.now() });
  return id;
}

export function updateJob(id, patch) {
  const job = jobs.get(id);
  if (job) Object.assign(job, patch);
}

export function getJob(id) {
  return jobs.get(id) || null;
}

// Sweep expired jobs occasionally.
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) if (now - job.createdAt > TTL_MS) jobs.delete(id);
}, 1000 * 60 * 5).unref();
