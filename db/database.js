import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbPath = join(__dirname, 'orchestrator.db');
const db = new Database(dbPath);

// Initialize database schema
db.exec(`
  -- Jobs table
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    runpod_job_id TEXT,
    endpoint_id TEXT,
    status TEXT DEFAULT 'PENDING',
    input_hash TEXT,
    input JSON,
    output JSON,
    gpu_used TEXT,
    duration_ms INTEGER,
    cost_usd REAL,
    attempts INTEGER DEFAULT 0,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    completed_at DATETIME
  );

  -- Cost tracking
  CREATE TABLE IF NOT EXISTS cost_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id TEXT,
    resource_type TEXT,
    resource_name TEXT,
    cost_usd REAL,
    duration_seconds INTEGER,
    gpu_type TEXT,
    logged_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Dead letter queue
  CREATE TABLE IF NOT EXISTS dead_letter_queue (
    id TEXT PRIMARY KEY,
    original_job_id TEXT,
    endpoint_id TEXT,
    job_data JSON,
    error TEXT,
    attempts INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Active pods tracking
  CREATE TABLE IF NOT EXISTS active_pods (
    id TEXT PRIMARY KEY,
    name TEXT,
    gpu_type TEXT,
    cost_per_hour REAL,
    status TEXT,
    task_type TEXT,
    port INTEGER,
    spending_limit REAL,
    total_spent REAL DEFAULT 0,
    last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Budget tracking
  CREATE TABLE IF NOT EXISTS daily_spend (
    date TEXT PRIMARY KEY,
    total_usd REAL DEFAULT 0
  );

  -- Configuration
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- Indexes for performance
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_hash ON jobs(input_hash);
  CREATE INDEX IF NOT EXISTS idx_cost_log_date ON cost_log(logged_at);
  CREATE INDEX IF NOT EXISTS idx_pods_activity ON active_pods(last_activity);
`);

// Run migrations for new columns (if table exists but column doesn't)
try {
  db.exec(`ALTER TABLE active_pods ADD COLUMN spending_limit REAL`);
} catch (e) { /* Column might already exist */ }

try {
  db.exec(`ALTER TABLE active_pods ADD COLUMN total_spent REAL DEFAULT 0`);
} catch (e) { /* Column might already exist */ }

try {
  db.exec(`ALTER TABLE active_pods ADD COLUMN task_type TEXT`);
} catch (e) { /* Column might already exist */ }

try {
  db.exec(`ALTER TABLE active_pods ADD COLUMN port INTEGER`);
} catch (e) { /* Column might already exist */ }

// Database wrapper functions
export const database = {
  // Jobs
  createJob(job) {
    const stmt = db.prepare(`
      INSERT INTO jobs (id, endpoint_id, status, input_hash, input)
      VALUES (?, ?, 'PENDING', ?, ?)
    `);
    return stmt.run(job.id, job.endpointId, job.inputHash, JSON.stringify(job.input));
  },

  updateJob(id, updates) {
    const fields = Object.keys(updates)
      .map(k => `${k} = ?`)
      .join(', ');
    const values = Object.values(updates).map(v =>
      typeof v === 'object' ? JSON.stringify(v) : v
    );
    const stmt = db.prepare(`UPDATE jobs SET ${fields} WHERE id = ?`);
    return stmt.run(...values, id);
  },

  getJob(id) {
    const stmt = db.prepare('SELECT * FROM jobs WHERE id = ?');
    const job = stmt.get(id);
    if (job) {
      job.input = JSON.parse(job.input || '{}');
      job.output = JSON.parse(job.output || 'null');
    }
    return job;
  },

  getJobByHash(inputHash) {
    const stmt = db.prepare(`
      SELECT * FROM jobs 
      WHERE input_hash = ? AND status IN ('COMPLETED', 'RUNNING', 'PENDING', 'IN_QUEUE')
      ORDER BY created_at DESC LIMIT 1
    `);
    return stmt.get(inputHash);
  },

  getJobs(limit = 100, status = null) {
    let query = 'SELECT * FROM jobs';
    const params = [];

    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const stmt = db.prepare(query);
    return stmt.all(...params).map(job => ({
      ...job,
      input: JSON.parse(job.input || '{}'),
      output: JSON.parse(job.output || 'null')
    }));
  },

  getPendingJobs(limit = 10) {
    const stmt = db.prepare(`
      SELECT * FROM jobs 
      WHERE status = 'PENDING' 
      ORDER BY created_at ASC 
      LIMIT ?
    `);
    return stmt.all(limit).map(job => ({
      ...job,
      input: JSON.parse(job.input || '{}')
    }));
  },

  // Dead Letter Queue
  addToDeadLetter(job, error) {
    const stmt = db.prepare(`
      INSERT INTO dead_letter_queue (id, original_job_id, endpoint_id, job_data, error, attempts)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(
      `dlq_${Date.now()}`,
      job.id,
      job.endpointId,
      JSON.stringify(job),
      error,
      job.attempts
    );
  },

  getDeadLetterJobs() {
    const stmt = db.prepare('SELECT * FROM dead_letter_queue ORDER BY created_at DESC');
    return stmt.all().map(job => ({
      ...job,
      job_data: JSON.parse(job.job_data || '{}')
    }));
  },

  // Cost tracking
  logCost(entry) {
    const stmt = db.prepare(`
      INSERT INTO cost_log (resource_id, resource_type, resource_name, cost_usd, duration_seconds, gpu_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(
      entry.resourceId,
      entry.resourceType,
      entry.resourceName,
      entry.costUsd,
      entry.durationSeconds,
      entry.gpuType
    );
  },

  getTodaySpend() {
    const today = new Date().toISOString().split('T')[0];
    const stmt = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total
      FROM cost_log 
      WHERE DATE(logged_at) = ?
    `);
    return stmt.get(today)?.total || 0;
  },

  getMonthSpend() {
    const firstOfMonth = new Date();
    firstOfMonth.setDate(1);
    const stmt = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total
      FROM cost_log 
      WHERE logged_at >= ?
    `);
    return stmt.get(firstOfMonth.toISOString())?.total || 0;
  },

  getCostHistory(days = 30) {
    const stmt = db.prepare(`
      SELECT DATE(logged_at) as date, SUM(cost_usd) as total
      FROM cost_log
      WHERE logged_at >= datetime('now', '-${days} days')
      GROUP BY DATE(logged_at)
      ORDER BY date DESC
    `);
    return stmt.all();
  },

  // Pods
  trackPod(pod) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO active_pods (id, name, gpu_type, cost_per_hour, status, task_type, port, spending_limit, total_spent, last_activity, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT total_spent FROM active_pods WHERE id = ?), 0), CURRENT_TIMESTAMP, COALESCE((SELECT created_at FROM active_pods WHERE id = ?), CURRENT_TIMESTAMP))
    `);
    return stmt.run(
      pod.id,
      pod.name,
      pod.gpuType,
      pod.costPerHour,
      pod.status,
      pod.taskType || null,
      pod.port || null,
      pod.spendingLimit || null,
      pod.id,
      pod.id
    );
  },

  updatePodActivity(podId) {
    const stmt = db.prepare(`
      UPDATE active_pods SET last_activity = CURRENT_TIMESTAMP WHERE id = ?
    `);
    return stmt.run(podId);
  },

  updatePodSpending(podId, totalSpent) {
    const stmt = db.prepare(`
      UPDATE active_pods SET total_spent = ? WHERE id = ?
    `);
    return stmt.run(totalSpent, podId);
  },

  getTrackedPods() {
    const stmt = db.prepare('SELECT * FROM active_pods');
    return stmt.all();
  },

  removePod(podId) {
    const stmt = db.prepare('DELETE FROM active_pods WHERE id = ?');
    return stmt.run(podId);
  },

  getInactivePods(minutesThreshold) {
    const stmt = db.prepare(`
      SELECT * FROM active_pods 
      WHERE datetime(last_activity, '+${minutesThreshold} minutes') < datetime('now')
      AND status = 'RUNNING'
    `);
    return stmt.all();
  },

  // Config
  setConfig(key, value) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)
    `);
    return stmt.run(key, JSON.stringify(value));
  },

  getConfig(key) {
    const stmt = db.prepare('SELECT value FROM config WHERE key = ?');
    const row = stmt.get(key);
    return row ? JSON.parse(row.value) : null;
  },

  // Stats
  getJobStats() {
    const stmt = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END) as running,
        AVG(duration_ms) as avg_duration,
        SUM(cost_usd) as total_cost
      FROM jobs
    `);
    return stmt.get();
  }
};

export default database;
