import { config } from '../config/env.js';
import { database } from '../db/database.js';
import { runpodClient } from './runpod-client.js';

/**
 * Auto-shutdown service for idle resources
 */
class AutoShutdown {
    constructor() {
        this.shutdownLogs = [];
        this.wsClients = new Set();
        this.enabled = true;
        this.checkInterval = null;
    }

    /**
     * Register WebSocket client for notifications
     */
    registerClient(ws) {
        this.wsClients.add(ws);
        ws.on('close', () => this.wsClients.delete(ws));
    }

    /**
     * Broadcast notification
     */
    broadcast(event, data) {
        const message = JSON.stringify({ event, data, timestamp: Date.now() });
        this.wsClients.forEach(ws => {
            if (ws.readyState === 1) {
                ws.send(message);
            }
        });
    }

    /**
     * Start monitoring for idle pods
     */
    start() {
        if (this.checkInterval) return;

        // Check every minute
        this.checkInterval = setInterval(() => {
            this.checkIdlePods();
        }, 60 * 1000);

        console.log(`Auto-shutdown enabled: ${config.autoShutdownMinutes} minutes of inactivity`);
    }

    /**
     * Stop monitoring
     */
    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }

    /**
     * Enable/disable auto-shutdown
     */
    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) {
            this.stop();
        } else if (!this.checkInterval) {
            this.start();
        }
        return this.enabled;
    }

    /**
     * Update pod activity timestamp
     */
    recordActivity(podId) {
        database.updatePodActivity(podId);
    }

    /**
     * Check for idle pods and stop them
     */
    async checkIdlePods() {
        if (!this.enabled) return;

        try {
            // Check spending limits first
            await this.checkSpendingLimits();

            // Then check for idle pods
            const inactivePods = database.getInactivePods(config.autoShutdownMinutes);

            for (const pod of inactivePods) {
                await this.shutdownPod(pod, 'inactivity');
            }
        } catch (error) {
            console.error('Auto-shutdown check error:', error.message);
        }
    }

    /**
     * Check pods that have exceeded their spending limits
     */
    async checkSpendingLimits() {
        try {
            const trackedPods = database.getTrackedPods();

            for (const pod of trackedPods) {
                // Skip pods without spending limits or not running
                if (!pod.spending_limit || pod.status !== 'RUNNING') continue;

                // Calculate time running in hours
                const createdAt = new Date(pod.created_at || pod.lastActivity);
                const hoursRunning = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);
                const costPerHour = pod.cost_per_hour || 0;
                const totalSpent = hoursRunning * costPerHour;

                // Update total spent in DB
                database.updatePodSpending(pod.id, totalSpent);

                // Check if limit exceeded
                if (totalSpent >= pod.spending_limit) {
                    console.log(`💰 Pod ${pod.name} exceeded spending limit: $${totalSpent.toFixed(2)} >= $${pod.spending_limit}`);
                    await this.shutdownAndTerminatePod(pod, totalSpent);
                }
            }
        } catch (error) {
            console.error('Spending limit check error:', error.message);
        }
    }

    /**
     * Shutdown AND terminate a pod due to spending limit
     */
    async shutdownAndTerminatePod(pod, totalSpent) {
        try {
            console.log(`🛑 Terminating pod due to spending limit: ${pod.name} (${pod.id})`);

            // First stop, then terminate
            try {
                await runpodClient.stopPod(pod.id);
            } catch (e) {
                // Pod might already be stopped
            }

            await runpodClient.terminatePod(pod.id);

            const log = {
                podId: pod.id,
                podName: pod.name,
                gpuType: pod.gpu_type,
                reason: 'spending_limit',
                timestamp: new Date().toISOString(),
                spendingLimit: pod.spending_limit,
                totalSpent: totalSpent.toFixed(2)
            };

            this.shutdownLogs.push(log);

            // Update tracked pod status
            database.trackPod({
                id: pod.id,
                status: 'TERMINATED'
            });

            this.broadcast('pod:spending-limit-exceeded', log);

            console.log(`✅ Pod ${pod.name} terminated. Total spent: $${totalSpent.toFixed(2)}/$${pod.spending_limit}`);

            return log;

        } catch (error) {
            console.error(`Failed to terminate pod ${pod.id}:`, error.message);
            this.broadcast('pod:terminate-failed', { podId: pod.id, error: error.message });
        }
    }

    /**
     * Shutdown a pod and log it
     */
    async shutdownPod(pod) {
        try {
            console.log(`Auto-stopping idle pod: ${pod.name} (${pod.id})`);

            await runpodClient.stopPod(pod.id);

            const log = {
                podId: pod.id,
                podName: pod.name,
                gpuType: pod.gpu_type,
                reason: 'inactivity',
                timestamp: new Date().toISOString(),
                idleMinutes: config.autoShutdownMinutes
            };

            this.shutdownLogs.push(log);

            // Update tracked pod status
            database.trackPod({
                id: pod.id,
                name: pod.name,
                gpuType: pod.gpu_type,
                costPerHour: pod.cost_per_hour,
                status: 'STOPPED'
            });

            this.broadcast('pod:auto-stopped', log);

            return log;

        } catch (error) {
            console.error(`Failed to auto-stop pod ${pod.id}:`, error.message);
            this.broadcast('pod:auto-stop-failed', { podId: pod.id, error: error.message });
        }
    }

    /**
     * Get shutdown logs
     */
    getLogs(limit = 50) {
        return this.shutdownLogs.slice(-limit);
    }

    /**
     * Get current status
     */
    getStatus() {
        return {
            enabled: this.enabled,
            idleThresholdMinutes: config.autoShutdownMinutes,
            recentShutdowns: this.shutdownLogs.slice(-10)
        };
    }
}

export const autoShutdown = new AutoShutdown();
export default AutoShutdown;
