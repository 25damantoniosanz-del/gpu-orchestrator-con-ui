import express from 'express';
import expressWs from 'express-ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { config, isConfigured } from './config/env.js';
import { runpodClient } from './services/runpod-client.js';
import { serverlessClient } from './services/serverless-client.js';
import { queueManager } from './services/queue-manager.js';
import { costTracker } from './services/cost-tracker.js';
import { autoShutdown } from './services/auto-shutdown.js';
import { database } from './db/database.js';
import { sanitizer } from './utils/sanitizer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
expressWs(app);

// Middleware
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// CORS for development
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    next();
});

// Error handler middleware
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// ==================== WebSocket ====================
app.ws('/ws', (ws, req) => {
    console.log('WebSocket client connected');
    queueManager.registerClient(ws);
    autoShutdown.registerClient(ws);

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
            }
        } catch (e) {
            // Ignore invalid messages
        }
    });
});

// ==================== Status ====================
app.get('/api/status', asyncHandler(async (req, res) => {
    res.json({
        configured: isConfigured(),
        timestamp: new Date().toISOString()
    });
}));

// ==================== Account ====================
app.get('/api/account', asyncHandler(async (req, res) => {
    const account = await runpodClient.getMyself();
    res.json(account);
}));

// ==================== GPUs ====================
app.get('/api/gpus', asyncHandler(async (req, res) => {
    const gpus = await runpodClient.getGpuTypes();

    // Sort by community price
    gpus.sort((a, b) => (a.communityPrice || 999) - (b.communityPrice || 999));

    res.json(gpus);
}));

// ==================== Pods ====================
app.get('/api/pods', asyncHandler(async (req, res) => {
    const pods = await runpodClient.getPods();
    res.json(pods);
}));

app.get('/api/pods/:id', asyncHandler(async (req, res) => {
    const pod = await runpodClient.getPod(req.params.id);
    if (!pod) {
        return res.status(404).json({ error: 'Pod not found' });
    }
    res.json(pod);
}));

app.post('/api/pods', asyncHandler(async (req, res) => {
    const input = sanitizer.sanitizeObject(req.body);
    const validation = sanitizer.validatePodInput(input);

    if (!validation.valid) {
        return res.status(400).json({ errors: validation.errors });
    }

    // Check budget
    if (!costTracker.canSpend()) {
        return res.status(403).json({ error: 'Budget limit exceeded' });
    }

    // Build pod options based on task type
    const podOptions = {
        name: input.name,
        gpuTypeId: input.gpuTypeId,
        volumeInGb: input.volumeInGb || 0,
        containerDiskInGb: input.containerDiskInGb || null,
        cloudType: input.cloudType || 'ALL'
    };

    // Use templateId if provided (for Music Gen), otherwise use imageName
    if (input.templateId) {
        podOptions.templateId = input.templateId;
    } else if (input.imageName) {
        podOptions.imageName = input.imageName;
    }

    // Set ports based on task type
    if (input.taskType === 'musicGen') {
        podOptions.ports = '7860/http,22/tcp';
    } else {
        podOptions.ports = '8188/http,8888/http,3000/http,22/tcp';
    }

    const pod = await runpodClient.createPod(podOptions);

    // Track pod with task type info and spending limit
    database.trackPod({
        id: pod.id,
        name: pod.name,
        gpuType: pod.machine?.gpuDisplayName,
        costPerHour: pod.costPerHr,
        status: 'RUNNING',
        taskType: input.taskType || 'imageGen',
        port: input.port || 8188,
        spendingLimit: input.spendingLimit || null,
        totalSpent: 0,
        createdAt: new Date().toISOString()
    });

    res.status(201).json(pod);
}));

app.post('/api/pods/:id/stop', asyncHandler(async (req, res) => {
    const result = await runpodClient.stopPod(req.params.id);
    database.trackPod({
        id: req.params.id,
        status: 'STOPPED'
    });
    res.json(result);
}));

app.post('/api/pods/:id/start', asyncHandler(async (req, res) => {
    const gpuCount = req.body.gpuCount || 1;
    const result = await runpodClient.resumePod(req.params.id, gpuCount);
    database.updatePodActivity(req.params.id);
    res.json(result);
}));

app.delete('/api/pods/:id', asyncHandler(async (req, res) => {
    await runpodClient.terminatePod(req.params.id);
    database.removePod(req.params.id);
    res.json({ success: true });
}));

// ==================== Image Generation (via Pod) ====================
app.post('/api/pods/:id/generate', asyncHandler(async (req, res) => {
    const podId = req.params.id;
    const params = req.body;

    // Get pod details to find ComfyUI endpoint
    const pod = await runpodClient.getPod(podId);
    if (!pod) {
        return res.status(404).json({ error: 'Pod not found' });
    }

    if (pod.desiredStatus !== 'RUNNING') {
        return res.status(400).json({ error: 'Pod is not running' });
    }

    // Find ComfyUI port (usually 8188)
    let comfyUrl = null;
    if (pod.runtime && pod.runtime.ports) {
        const httpPort = pod.runtime.ports.find(p => p.privatePort === 8188 || p.privatePort === 3000);
        if (httpPort && httpPort.ip) {
            comfyUrl = `http://${httpPort.ip}:${httpPort.publicPort}`;
        }
    }

    if (!comfyUrl) {
        return res.status(400).json({
            error: 'ComfyUI endpoint not found. Pod may still be starting up.',
            podStatus: pod.desiredStatus,
            ports: pod.runtime?.ports || []
        });
    }

    // Build ComfyUI workflow
    const workflow = buildComfyWorkflow(params);

    try {
        // Queue the prompt
        const queueResponse = await fetch(`${comfyUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: workflow })
        });

        if (!queueResponse.ok) {
            throw new Error('Failed to queue prompt in ComfyUI');
        }

        const queueResult = await queueResponse.json();
        const promptId = queueResult.prompt_id;

        // Poll for completion (max 2 minutes)
        let completed = false;
        let images = [];
        const startTime = Date.now();
        const timeout = 120000; // 2 minutes

        while (!completed && (Date.now() - startTime) < timeout) {
            await new Promise(r => setTimeout(r, 2000)); // Wait 2 seconds

            const historyResponse = await fetch(`${comfyUrl}/history/${promptId}`);
            if (historyResponse.ok) {
                const history = await historyResponse.json();
                if (history[promptId] && history[promptId].outputs) {
                    completed = true;
                    // Extract images from outputs
                    for (const nodeId in history[promptId].outputs) {
                        const output = history[promptId].outputs[nodeId];
                        if (output.images) {
                            for (const img of output.images) {
                                images.push({
                                    url: `${comfyUrl}/view?filename=${img.filename}&subfolder=${img.subfolder || ''}&type=${img.type || 'output'}`,
                                    filename: img.filename
                                });
                            }
                        }
                    }
                }
            }
        }

        if (!completed) {
            return res.json({
                status: 'pending',
                promptId,
                message: 'Generation still in progress. Check the pod directly.'
            });
        }

        // Update pod activity
        database.updatePodActivity(podId);

        res.json({
            status: 'completed',
            images,
            promptId
        });

    } catch (error) {
        console.error('Generation error:', error);
        res.status(500).json({ error: error.message });
    }
}));

// Helper function to build ComfyUI workflow
function buildComfyWorkflow(params) {
    const {
        prompt = '',
        negative_prompt = '',
        width = 1024,
        height = 1024,
        steps = 20,
        cfg_scale = 7,
        sampler = 'euler',
        batch_size = 1
    } = params;

    // Basic SDXL workflow
    return {
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "cfg": cfg_scale,
                "denoise": 1,
                "latent_image": ["5", 0],
                "model": ["4", 0],
                "negative": ["7", 0],
                "positive": ["6", 0],
                "sampler_name": sampler,
                "scheduler": "normal",
                "seed": Math.floor(Math.random() * 1000000000),
                "steps": steps
            }
        },
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {
                "ckpt_name": "sd_xl_base_1.0.safetensors"
            }
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {
                "batch_size": batch_size,
                "height": height,
                "width": width
            }
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "clip": ["4", 1],
                "text": prompt
            }
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "clip": ["4", 1],
                "text": negative_prompt
            }
        },
        "8": {
            "class_type": "VAEDecode",
            "inputs": {
                "samples": ["3", 0],
                "vae": ["4", 2]
            }
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {
                "filename_prefix": "ComfyUI",
                "images": ["8", 0]
            }
        }
    };
}

// ==================== Serverless Endpoints ====================
app.get('/api/endpoints', asyncHandler(async (req, res) => {
    const endpoints = await serverlessClient.getEndpoints();
    res.json(endpoints);
}));

app.post('/api/endpoints', asyncHandler(async (req, res) => {
    const input = sanitizer.sanitizeObject(req.body);
    const endpoint = await serverlessClient.createEndpoint(input);
    res.status(201).json(endpoint);
}));

app.delete('/api/endpoints/:id', asyncHandler(async (req, res) => {
    await serverlessClient.deleteEndpoint(req.params.id);
    res.json({ success: true });
}));

app.get('/api/endpoints/:id/health', asyncHandler(async (req, res) => {
    const health = await serverlessClient.getHealth(req.params.id);
    res.json(health);
}));

// ==================== Serverless Image Generation ====================
app.post('/api/endpoints/:id/generate', asyncHandler(async (req, res) => {
    const endpointId = req.params.id;
    const params = req.body;

    const {
        prompt = '',
        negative_prompt = '',
        width = 1024,
        height = 1024,
        steps = 20,
        cfg_scale = 7,
        sampler = 'euler',
        batch_size = 1
    } = params;

    // Build input for the serverless endpoint
    const input = {
        prompt,
        negative_prompt,
        width,
        height,
        num_inference_steps: steps,
        guidance_scale: cfg_scale,
        sampler_name: sampler,
        batch_size,
        // Standard RunPod serverless fields
        seed: Math.floor(Math.random() * 1000000000)
    };

    try {
        // Submit job to serverless endpoint (sync mode)
        const result = await serverlessClient.runJobSync(endpointId, input);

        // Check if it's a sync response with output
        if (result.output) {
            // Extract images from output
            let images = [];

            if (Array.isArray(result.output)) {
                images = result.output.map(img => {
                    if (typeof img === 'string') {
                        // Check if it's base64 or URL
                        if (img.startsWith('data:') || img.startsWith('http')) {
                            return { url: img };
                        }
                        // Assume it's base64 without prefix
                        return { url: `data:image/png;base64,${img}` };
                    }
                    return img;
                });
            } else if (result.output.images) {
                images = result.output.images.map(img => {
                    if (typeof img === 'string') {
                        if (img.startsWith('data:') || img.startsWith('http')) {
                            return { url: img };
                        }
                        return { url: `data:image/png;base64,${img}` };
                    }
                    return img;
                });
            } else if (result.output.image) {
                const img = result.output.image;
                if (typeof img === 'string') {
                    if (img.startsWith('data:') || img.startsWith('http')) {
                        images = [{ url: img }];
                    } else {
                        images = [{ url: `data:image/png;base64,${img}` }];
                    }
                }
            }

            res.json({
                status: 'completed',
                images,
                executionTime: result.executionTime,
                jobId: result.id
            });
        } else {
            // Async job - return job ID for polling
            res.json({
                status: 'in_queue',
                jobId: result.id,
                message: 'Job submitted. Use the Jobs tab to track progress.'
            });
        }
    } catch (error) {
        console.error('Serverless generation error:', error);
        res.status(500).json({ error: error.message });
    }
}));

// ==================== Jobs ====================
app.get('/api/jobs', asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const status = req.query.status || null;
    const jobs = database.getJobs(limit, status);
    res.json(jobs);
}));

app.get('/api/jobs/:id', asyncHandler(async (req, res) => {
    const job = database.getJob(req.params.id);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    res.json(job);
}));

app.post('/api/jobs', asyncHandler(async (req, res) => {
    const { endpointId, input, options } = req.body;

    const endpointValidation = sanitizer.validateEndpointId(endpointId);
    if (!endpointValidation.valid) {
        return res.status(400).json({ errors: endpointValidation.errors });
    }

    const sanitizedInput = sanitizer.sanitizeObject(input);
    const inputValidation = sanitizer.validateJobInput(sanitizedInput);
    if (!inputValidation.valid) {
        return res.status(400).json({ errors: inputValidation.errors });
    }

    const result = await queueManager.submitJob(endpointId, sanitizedInput, options);
    res.status(201).json(result);
}));

app.post('/api/jobs/:id/cancel', asyncHandler(async (req, res) => {
    const result = await queueManager.cancelJob(req.params.id);
    res.json(result);
}));

app.get('/api/jobs/stats', asyncHandler(async (req, res) => {
    const stats = queueManager.getStats();
    res.json(stats);
}));

// ==================== Dead Letter Queue ====================
app.get('/api/dlq', asyncHandler(async (req, res) => {
    const jobs = database.getDeadLetterJobs();
    res.json(jobs);
}));

app.post('/api/dlq/:id/retry', asyncHandler(async (req, res) => {
    const result = await queueManager.retryDeadLetter(req.params.id);
    res.json(result);
}));

// ==================== Costs ====================
app.get('/api/costs', asyncHandler(async (req, res) => {
    const spending = costTracker.getSpendingStatus();
    res.json(spending);
}));

app.get('/api/costs/history', asyncHandler(async (req, res) => {
    const days = parseInt(req.query.days) || 30;
    const history = costTracker.getCostHistory(days);
    res.json(history);
}));

// ==================== Auto-Shutdown ====================
app.get('/api/auto-shutdown', asyncHandler(async (req, res) => {
    const status = autoShutdown.getStatus();
    res.json(status);
}));

app.post('/api/auto-shutdown/toggle', asyncHandler(async (req, res) => {
    const enabled = req.body.enabled !== false;
    autoShutdown.setEnabled(enabled);
    res.json({ enabled: autoShutdown.enabled });
}));

// ==================== Templates ====================
app.get('/api/templates', asyncHandler(async (req, res) => {
    const templates = await runpodClient.getTemplates();

    // Add predefined community templates
    const communityTemplates = [
        {
            id: 'comfyui-sdxl',
            name: 'ComfyUI SDXL - All In One',
            imageName: 'hearmeman/comfyui-sdxl-template:v7',
            isPublic: true,
            description: 'One Click Install - ComfyUI SDXL with all models'
        },
        {
            id: 'automatic1111',
            name: 'Automatic1111 WebUI',
            imageName: 'runpod/stable-diffusion:web-ui-10.2.1',
            isPublic: true,
            description: 'Stable Diffusion WebUI by Automatic1111'
        },
        {
            id: 'kohya-ss',
            name: 'Kohya SS Training',
            imageName: 'runpod/kohya-ss:v1.0.0',
            isPublic: true,
            description: 'LoRA/DreamBooth training with Kohya'
        }
    ];

    res.json([...communityTemplates, ...templates]);
}));

// ==================== Benchmarks ====================
app.get('/api/benchmarks', asyncHandler(async (req, res) => {
    // Static benchmark data based on community tests
    const benchmarks = [
        {
            gpuId: 'NVIDIA GeForce RTX 4090',
            vram: 24,
            costPer100Images: 0.15,
            avgLatencyMs: 2500,
            coldStartMs: 8000,
            tier: 'premium',
            recommended: 'High quality, fast generation'
        },
        {
            gpuId: 'NVIDIA GeForce RTX 3090',
            vram: 24,
            costPer100Images: 0.12,
            avgLatencyMs: 3500,
            coldStartMs: 10000,
            tier: 'balanced',
            recommended: 'Good balance of cost and speed'
        },
        {
            gpuId: 'NVIDIA A100 80GB PCIe',
            vram: 80,
            costPer100Images: 0.35,
            avgLatencyMs: 2000,
            coldStartMs: 15000,
            tier: 'premium',
            recommended: 'Large models, batch processing'
        },
        {
            gpuId: 'NVIDIA GeForce RTX 4080',
            vram: 16,
            costPer100Images: 0.10,
            avgLatencyMs: 3000,
            coldStartMs: 8000,
            tier: 'balanced',
            recommended: 'Cost effective for SDXL'
        },
        {
            gpuId: 'NVIDIA GeForce RTX 3080',
            vram: 12,
            costPer100Images: 0.08,
            avgLatencyMs: 4000,
            coldStartMs: 9000,
            tier: 'budget',
            recommended: 'Budget option for SD 1.5'
        },
        {
            gpuId: 'NVIDIA L4',
            vram: 24,
            costPer100Images: 0.09,
            avgLatencyMs: 3200,
            coldStartMs: 12000,
            tier: 'balanced',
            recommended: 'Great for serverless'
        }
    ];

    res.json(benchmarks);
}));

// ==================== Config ====================
app.post('/api/config', asyncHandler(async (req, res) => {
    const { key, value } = req.body;

    // Only allow certain config keys
    const allowedKeys = ['budgetLimitDaily', 'budgetLimitMonthly', 'autoShutdownMinutes'];
    if (!allowedKeys.includes(key)) {
        return res.status(400).json({ error: 'Invalid config key' });
    }

    database.setConfig(key, value);
    res.json({ success: true });
}));

// ==================== Error Handler ====================
app.use((err, req, res, next) => {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
});

// ==================== Start Server ====================
const PORT = config.port;

app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🚀 GPU Orchestrator - RunPod Control Panel             ║
║                                                           ║
║   Server running at: http://localhost:${PORT}              ║
║   API configured: ${isConfigured() ? '✅ Yes' : '❌ No - Set RUNPOD_API_KEY'}              ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);

    // Start auto-shutdown monitoring
    autoShutdown.start();
});

export default app;
