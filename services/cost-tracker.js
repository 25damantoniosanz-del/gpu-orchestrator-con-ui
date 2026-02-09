import { config } from '../config/env.js';
import { database } from '../db/database.js';
import { runpodClient } from './runpod-client.js';

/**
 * Cost Tracker for monitoring spending and enforcing budgets
 */
class CostTracker {
    constructor() {
        this.gpuPrices = new Map();
        this.startCostPolling();
    }

    /**
     * Load GPU prices from RunPod
     */
    async loadGpuPrices() {
        try {
            const gpuTypes = await runpodClient.getGpuTypes();
            gpuTypes.forEach(gpu => {
                this.gpuPrices.set(gpu.id, {
                    name: gpu.displayName,
                    securePrice: gpu.securePrice,
                    communityPrice: gpu.communityPrice
                });
            });
        } catch (error) {
            console.error('Failed to load GPU prices:', error.message);
        }
    }

    /**
     * Get estimated cost for a job
     */
    estimateCost(gpuType, estimatedSeconds) {
        const gpu = this.gpuPrices.get(gpuType);
        if (!gpu) return null;

        const hourlyRate = gpu.communityPrice || gpu.securePrice || 0;
        return (hourlyRate / 3600) * estimatedSeconds;
    }

    /**
     * Log cost for a completed resource usage
     */
    logResourceCost(resource) {
        const { id, type, name, durationSeconds, gpuType, costPerHour } = resource;

        const costUsd = (costPerHour / 3600) * durationSeconds;

        database.logCost({
            resourceId: id,
            resourceType: type,
            resourceName: name,
            costUsd,
            durationSeconds,
            gpuType
        });

        return costUsd;
    }

    /**
     * Get current spending status
     */
    getSpendingStatus() {
        const todaySpend = database.getTodaySpend();
        const monthSpend = database.getMonthSpend();

        return {
            today: {
                spent: todaySpend,
                limit: config.budgetLimitDaily,
                remaining: Math.max(0, config.budgetLimitDaily - todaySpend),
                percentUsed: (todaySpend / config.budgetLimitDaily) * 100
            },
            month: {
                spent: monthSpend,
                limit: config.budgetLimitMonthly,
                remaining: Math.max(0, config.budgetLimitMonthly - monthSpend),
                percentUsed: (monthSpend / config.budgetLimitMonthly) * 100
            },
            alerts: this.getAlerts(todaySpend, monthSpend)
        };
    }

    /**
     * Generate spending alerts
     */
    getAlerts(todaySpend, monthSpend) {
        const alerts = [];

        const todayPercent = (todaySpend / config.budgetLimitDaily) * 100;
        const monthPercent = (monthSpend / config.budgetLimitMonthly) * 100;

        if (todayPercent >= 100) {
            alerts.push({ level: 'critical', message: 'Daily budget exceeded!' });
        } else if (todayPercent >= 80) {
            alerts.push({ level: 'warning', message: `Daily budget at ${todayPercent.toFixed(0)}%` });
        } else if (todayPercent >= 50) {
            alerts.push({ level: 'info', message: `Daily budget at ${todayPercent.toFixed(0)}%` });
        }

        if (monthPercent >= 100) {
            alerts.push({ level: 'critical', message: 'Monthly budget exceeded!' });
        } else if (monthPercent >= 80) {
            alerts.push({ level: 'warning', message: `Monthly budget at ${monthPercent.toFixed(0)}%` });
        }

        return alerts;
    }

    /**
     * Check if budget allows new spending
     */
    canSpend(estimatedCost = 0) {
        const todaySpend = database.getTodaySpend();
        return (todaySpend + estimatedCost) <= config.budgetLimitDaily;
    }

    /**
     * Get cost history for charts
     */
    getCostHistory(days = 30) {
        return database.getCostHistory(days);
    }

    /**
     * Get spending by GPU type
     */
    getSpendingByGpu() {
        // This would need a more complex query in production
        const history = database.getCostHistory(30);
        return history;
    }

    /**
     * Poll active pods and log their costs
     */
    async startCostPolling() {
        // Load prices initially
        await this.loadGpuPrices();

        // Refresh prices and log costs every 5 minutes
        setInterval(async () => {
            try {
                await this.loadGpuPrices();
                await this.logActivePodsCost();
            } catch (error) {
                console.error('Cost polling error:', error.message);
            }
        }, 5 * 60 * 1000);
    }

    /**
     * Log costs for currently active pods
     */
    async logActivePodsCost() {
        try {
            const pods = await runpodClient.getPods();

            for (const pod of pods) {
                if (pod.desiredStatus === 'RUNNING' && pod.runtime) {
                    // Log 5 minutes of usage (polling interval)
                    this.logResourceCost({
                        id: pod.id,
                        type: 'pod',
                        name: pod.name,
                        durationSeconds: 300, // 5 minutes
                        gpuType: pod.machine?.gpuDisplayName,
                        costPerHour: pod.costPerHr
                    });
                }
            }
        } catch (error) {
            console.error('Failed to log pod costs:', error.message);
        }
    }
}

export const costTracker = new CostTracker();
export default CostTracker;
