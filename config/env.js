import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root
const envPath = resolve(__dirname, '..', '.env');
console.log('Loading .env from:', envPath);
dotenv.config({ path: envPath });
console.log('API Key loaded:', process.env.RUNPOD_API_KEY ? 'Yes (starts with ' + process.env.RUNPOD_API_KEY.slice(0, 8) + '...)' : 'NO - NOT FOUND!');

export const config = {
  // RunPod API
  runpodApiKey: process.env.RUNPOD_API_KEY || '',

  // Budget Control
  budgetLimitDaily: parseFloat(process.env.BUDGET_LIMIT_DAILY) || 50,
  budgetLimitMonthly: parseFloat(process.env.BUDGET_LIMIT_MONTHLY) || 500,

  // Auto-shutdown
  autoShutdownMinutes: parseInt(process.env.AUTO_SHUTDOWN_MINUTES) || 30,

  // Server
  port: parseInt(process.env.PORT) || 3000,

  // Queue
  maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS) || 5,
  rateLimitPerSecond: parseInt(process.env.RATE_LIMIT_PER_SECOND) || 2,
  maxRetryAttempts: parseInt(process.env.MAX_RETRY_ATTEMPTS) || 5,

  // RunPod URLs
  runpodGraphqlUrl: 'https://api.runpod.io/graphql',
  runpodRestUrl: 'https://api.runpod.ai/v2'
};

export function isConfigured() {
  return config.runpodApiKey && config.runpodApiKey !== 'your_api_key_here';
}
