import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { config } from '../config/env.js';
import { database } from '../db/database.js';
import { serverlessClient } from './serverless-client.js';

/**
 * Queue Manager with deduplication, rate limiting, and retry logic
 */
class QueueManager {
    constructor() {
        this.isProcessing = false;
        this.activeJobs = new Map();
        this.rateLimitTokens = config.rateLimitPerSecond;
        this.lastTokenRefill = Date.now();
        this.wsClients = new Set();

        // Start the processing loop
        this.startProcessingLoop();
        this.startTokenRefillLoop();
    }

    /**
     * Register a WebSocket client for real-time updates
     */
    registerClient(ws) {
        this.wsClients.add(ws);
        ws.on('close', () => this.wsClients.delete(ws));
    }

    /**
     * Broadcast update to all connected clients
     */
    broadcast(event, data) {
        const message = JSON.stringify({ event, data, timestamp: Date.now() });
        this.wsClients.forEach(ws => {
            if (ws.readyState === 1) { // OPEN
                ws.send(message);
            }
        });
    }

    /**
     * Generate hash for input deduplication
     */
    hashInput(input) {
        const normalized = JSON.stringify(input, Object.keys(input).sort());
        return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
    }

    /**
     * Submit a job to the queue
     */
    async submitJob(endpointId, input, options = {}) {
        const { skipDeduplication = false } = options;

        const inputHash = this.hashInput(input);

        // Check for duplicates
        if (!skipDeduplication) {
            const existing = database.getJobByHash(inputHash);
            if (existing) {
                return {
                    ...existing,
                    deduplicated: true,
                    message: 'Job with identical input already exists'
                };
            }
        }

        // Check budget
        const todaySpend = database.getTodaySpend();
        if (todaySpend >= config.budgetLimitDaily) {
            throw new Error(`Daily budget limit ($${config.budgetLimitDaily}) exceeded. Current spend: $${todaySpend.toFixed(2)}`);
        }

        // Create job record
        const jobId = uuidv4();
        const job = {
            id: jobId,
            endpointId,
            inputHash,
            input,
            status: 'PENDING',
            attempts: 0,
            createdAt: new Date().toISOString()
        };

        database.createJob(job);
        this.broadcast('job:created', { id: jobId, status: 'PENDING' });

        return {
            id: jobId,
            status: 'PENDING',
            message: 'Job queued successfully'
        };
    }

    /**
     * Token bucket rate limiting
     */
    async acquireRateLimitToken() {
        while (this.rateLimitTokens < 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        this.rateLimitTokens--;
        return true;
    }

    /**
     * Refill rate limit tokens
     */
    startTokenRefillLoop() {
        setInterval(() => {
            this.rateLimitTokens = Math.min(
                config.rateLimitPerSecond,
                this.rateLimitTokens + config.rateLimitPerSecond
            );
        }, 1000);
    }

    /**
     * Calculate exponential backoff delay
     */
    getBackoffDelay(attempts) {
        const baseDelay = 1000; // 1 second
        const maxDelay = 32000; // 32 seconds
        const delay = Math.min(baseDelay * Math.pow(2, attempts), maxDelay);
        // Add jitter
        return delay + Math.random() * 1000;
    }

    /**
     * Process a single job
     */
    async processJob(job) {
        const startTime = Date.now();

        try {
            // Update status to RUNNING
            database.updateJob(job.id, {
                status: 'RUNNING',
                started_at: new Date().toISOString(),
                attempts: job.attempts + 1
            });
            this.broadcast('job:running', { id: job.id });

            // Wait for rate limit token
            await this.acquireRateLimitToken();

            // Send job to RunPod
            const result = await serverlessClient.runJob(job.endpoint_id, job.input);

            // Update with RunPod job ID
            database.updateJob(job.id, {
                runpod_job_id: result.id,
                status: 'IN_QUEUE'
            });
            this.broadcast('job:queued', { id: job.id, runpodJobId: result.id });

            // Track this job for status polling
            this.activeJobs.set(job.id, {
                runpodJobId: result.id,
                endpointId: job.endpoint_id,
                startTime
            });

            return result;

        } catch (error) {
            const attempts = (job.attempts || 0) + 1;

            if (attempts >= config.maxRetryAttempts) {
                // Move to dead letter queue
                database.updateJob(job.id, {
                    status: 'FAILED',
                    error: error.message,
                    attempts
                });
                database.addToDeadLetter(job, error.message);
                this.broadcast('job:failed', { id: job.id, error: error.message, deadLettered: true });
            } else {
                // Schedule retry with backoff
                const delay = this.getBackoffDelay(attempts);
                database.updateJob(job.id, {
                    status: 'PENDING',
                    error: error.message,
                    attempts
                });
                this.broadcast('job:retry', { id: job.id, attempt: attempts, retryIn: delay });
            }

            throw error;
        }
    }

    /**
     * Poll status for active jobs
     */
    async pollActiveJobs() {
        for (const [jobId, info] of this.activeJobs.entries()) {
            try {
                const status = await serverlessClient.getJobStatus(info.endpointId, info.runpodJobId);

                if (status.status === 'COMPLETED') {
                    const duration = Date.now() - info.startTime;
                    database.updateJob(jobId, {
                        status: 'COMPLETED',
                        output: status.output,
                        duration_ms: duration,
                        completed_at: new Date().toISOString()
                    });
                    this.activeJobs.delete(jobId);
                    this.broadcast('job:completed', { id: jobId, output: status.output, duration });

                } else if (status.status === 'FAILED') {
                    database.updateJob(jobId, {
                        status: 'FAILED',
                        error: status.error || 'Job failed',
                        completed_at: new Date().toISOString()
                    });
                    this.activeJobs.delete(jobId);
                    this.broadcast('job:failed', { id: jobId, error: status.error });
                }
                // For IN_PROGRESS, IN_QUEUE - keep polling

            } catch (error) {
                console.error(`Error polling job ${jobId}:`, error.message);
            }
        }
    }

    /**
     * Main processing loop
     */
    async startProcessingLoop() {
        const processInterval = 1000; // 1 second

        const process = async () => {
            if (this.isProcessing) return;
            this.isProcessing = true;

            try {
                // Get pending jobs
                const pendingJobs = database.getPendingJobs(config.maxConcurrentJobs - this.activeJobs.size);

                // Process jobs concurrently (up to limit)
                await Promise.allSettled(
                    pendingJobs.map(job => this.processJob(job))
                );

                // Poll active jobs
                await this.pollActiveJobs();

            } catch (error) {
                console.error('Queue processing error:', error);
            } finally {
                this.isProcessing = false;
            }
        };

        // Start loop
        setInterval(process, processInterval);
        process(); // Run immediately
    }

    /**
     * Get queue statistics
     */
    getStats() {
        const dbStats = database.getJobStats();
        return {
            ...dbStats,
            activeJobs: this.activeJobs.size,
            rateLimitTokens: this.rateLimitTokens,
            connectedClients: this.wsClients.size
        };
    }

    /**
     * Cancel a job
     */
    async cancelJob(jobId) {
        const job = database.getJob(jobId);
        if (!job) throw new Error('Job not found');

        if (job.runpod_job_id && this.activeJobs.has(jobId)) {
            await serverlessClient.cancelJob(job.endpoint_id, job.runpod_job_id);
            this.activeJobs.delete(jobId);
        }

        database.updateJob(jobId, { status: 'CANCELLED' });
        this.broadcast('job:cancelled', { id: jobId });

        return { success: true };
    }

    /**
     * Retry a dead-lettered job
     */
    async retryDeadLetter(dlqId) {
        const dlqJobs = database.getDeadLetterJobs();
        const dlqJob = dlqJobs.find(j => j.id === dlqId);

        if (!dlqJob) throw new Error('Dead letter job not found');

        const jobData = dlqJob.job_data;
        return this.submitJob(jobData.endpointId, jobData.input, { skipDeduplication: true });
    }
}

export const queueManager = new QueueManager();
export default QueueManager;
