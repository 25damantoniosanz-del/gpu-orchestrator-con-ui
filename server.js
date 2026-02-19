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
import { workflowEngine } from './services/workflow-engine.js';

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
        cloudType: input.cloudType || 'ALL',
        env: []
    };

    // Use templateId if provided (for Music Gen), otherwise use imageName
    if (input.templateId) {
        podOptions.templateId = input.templateId;
    } else if (input.imageName) {
        podOptions.imageName = input.imageName;
    }

    // Set ports and env based on task type
    if (input.taskType === 'musicGen') {
        podOptions.ports = '7860/http,22/tcp';
    } else if (input.taskType === 'imageGenA1111') {
        // Automatic1111 WebUI — uses port 3000, proven approach from companion project
        podOptions.ports = '3000/http,8888/http,22/tcp';
        podOptions.env.push({ key: 'COMMANDLINE_ARGS', value: '--api --listen 0.0.0.0 --port 3000 --xformers --no-half-vae' });
    } else {
        // ComfyUI (default imageGen)
        podOptions.ports = '8188/http,8888/http,3000/http,22/tcp';
        podOptions.env.push({ key: 'CLI_ARGS', value: '--listen 0.0.0.0 --port 8188' });
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

// ==================== Workflows API ====================
app.get('/api/workflows', asyncHandler(async (req, res) => {
    const workflows = workflowEngine.listWorkflows();
    res.json(workflows);
}));

app.post('/api/workflows/upload', asyncHandler(async (req, res) => {
    const { name, workflow } = req.body;
    if (!name || !workflow) {
        return res.status(400).json({ error: 'Name and workflow JSON are required' });
    }
    const result = workflowEngine.saveCustomWorkflow(name, workflow);
    res.status(201).json(result);
}));

// ==================== Image/Video Generation (via Pod) ====================

// Helper: determine which engine a pod is running (a1111 or comfyui)
function getPodEngine(podId) {
    const trackedPods = database.getTrackedPods();
    const trackedPod = trackedPods.find(p => p.id === podId);
    if (trackedPod?.taskType === 'imageGenA1111') return 'a1111';
    if (trackedPod?.taskType === 'musicGen') return 'musicGen';
    return 'comfyui';
}

// Helper: resolve the base URL for a pod's generation service (FAST — no health check)
async function resolvePodUrl(podId) {
    const pod = await runpodClient.getPod(podId);
    if (!pod) throw { status: 404, message: 'Pod not found' };
    if (pod.desiredStatus !== 'RUNNING') throw { status: 400, message: 'Pod is not running' };

    if (!pod.runtime || (!pod.runtime.ports && pod.runtime.uptimeInSeconds === 0)) {
        throw {
            status: 400,
            message: 'Pod is still initializing. The GPU is being assigned and the container is starting. This typically takes 2-5 minutes. Please wait and try again.'
        };
    }

    const engine = getPodEngine(podId);
    const portMap = { a1111: 3000, comfyui: 8188, musicGen: 7860 };
    const targetPort = portMap[engine] || 8188;

    // Always use RunPod proxy URL (direct IPs are internal and unreachable from local)
    const serviceUrl = `https://${podId}-${targetPort}.proxy.runpod.net`;

    console.log(`[${engine}] URL for pod ${podId}: ${serviceUrl}`);
    return { pod, serviceUrl, engine };
}

// Helper: query available checkpoints from ComfyUI
async function getAvailableCheckpoints(comfyUrl) {
    try {
        const response = await fetch(`${comfyUrl}/object_info/CheckpointLoaderSimple`, {
            signal: AbortSignal.timeout(10000)
        });
        if (response.ok) {
            const data = await response.json();
            const ckpts = data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
            console.log(`Available checkpoints on pod: ${JSON.stringify(ckpts)}`);
            return ckpts;
        }
    } catch (e) {
        console.warn('Could not query checkpoints:', e.message);
    }
    return [];
}

// Helper: fix checkpoint name in a workflow to match what's installed
function fixCheckpointInWorkflow(workflow, availableCheckpoints) {
    if (!availableCheckpoints || availableCheckpoints.length === 0) return workflow;

    for (const [nodeId, node] of Object.entries(workflow)) {
        if (node.class_type === 'CheckpointLoaderSimple') {
            const requestedCkpt = node.inputs?.ckpt_name;
            if (requestedCkpt && !availableCheckpoints.includes(requestedCkpt)) {
                // Try exact substring match first (e.g. 'turbo', 'sdxl', etc.)
                const keywords = requestedCkpt.toLowerCase().replace(/[._-]/g, ' ').split(' ').filter(w => w.length > 3);
                let bestMatch = availableCheckpoints.find(c => keywords.some(k => c.toLowerCase().includes(k)));

                // Fallback: try common model type keywords
                if (!bestMatch) {
                    bestMatch = availableCheckpoints.find(c =>
                        c.toLowerCase().includes('turbo') ||
                        c.toLowerCase().includes('sdxl') ||
                        c.toLowerCase().includes('sd_xl') ||
                        c.toLowerCase().includes('stable')
                    );
                }

                const fallback = bestMatch || availableCheckpoints[0];
                console.log(`Checkpoint fix: "${requestedCkpt}" → "${fallback}" (available: ${availableCheckpoints.join(', ')})`);
                node.inputs.ckpt_name = fallback;
            }
        }
    }
    return workflow;
}

// Helper: send a workflow to ComfyUI and poll for results
async function executeWorkflowOnPod(comfyUrl, workflow, timeoutMs = 180000) {
    console.log(`Sending workflow to ComfyUI at: ${comfyUrl}/prompt`);
    console.log(`Workflow nodes: ${Object.keys(workflow).length}, classes: ${[...new Set(Object.values(workflow).map(n => n.class_type))].join(', ')}`);

    let queueResponse;
    try {
        queueResponse = await fetch(`${comfyUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: workflow }),
            signal: AbortSignal.timeout(30000)
        });
    } catch (fetchErr) {
        console.error(`[ComfyUI] Connection failed to ${comfyUrl}:`, fetchErr.message);
        throw new Error(
            `No se pudo conectar a ComfyUI en ${comfyUrl}. ` +
            `Esto puede pasar porque: (1) ComfyUI aún no ha terminado de cargar — espera 2-3 minutos, ` +
            `(2) El servicio no está corriendo en el pod — revisa los logs en RunPod. ` +
            `Error: ${fetchErr.message}`
        );
    }

    if (!queueResponse.ok) {
        let errDetail = '';
        try {
            const errJson = await queueResponse.json();
            console.error('ComfyUI error response:', JSON.stringify(errJson, null, 2));
            // ComfyUI returns structured errors with node_errors
            if (errJson.error) {
                errDetail = errJson.error.message || JSON.stringify(errJson.error);
            }
            if (errJson.node_errors) {
                const nodeErrs = Object.values(errJson.node_errors)
                    .map(ne => ne.errors?.map(e => e.message).join(', ') || JSON.stringify(ne))
                    .join('; ');
                errDetail += (errDetail ? ' | ' : '') + 'Node errors: ' + nodeErrs;
            }
        } catch {
            errDetail = await queueResponse.text().catch(() => `HTTP ${queueResponse.status}`);
        }
        throw new Error(`ComfyUI rejected the workflow: ${errDetail || 'Unknown error (HTTP ' + queueResponse.status + ')'}`);
    }

    const queueResult = await queueResponse.json();
    const promptId = queueResult.prompt_id;

    // Poll for completion
    let completed = false;
    let results = { images: [], gifs: [] };
    const startTime = Date.now();

    while (!completed && (Date.now() - startTime) < timeoutMs) {
        await new Promise(r => setTimeout(r, 2000));

        const historyResponse = await fetch(`${comfyUrl}/history/${promptId}`);
        if (historyResponse.ok) {
            const history = await historyResponse.json();
            if (history[promptId] && history[promptId].outputs) {
                completed = true;
                for (const nodeId in history[promptId].outputs) {
                    const output = history[promptId].outputs[nodeId];
                    if (output.images) {
                        for (const img of output.images) {
                            results.images.push({
                                url: `${comfyUrl}/view?filename=${img.filename}&subfolder=${img.subfolder || ''}&type=${img.type || 'output'}`,
                                filename: img.filename
                            });
                        }
                    }
                    if (output.gifs) {
                        for (const gif of output.gifs) {
                            results.gifs.push({
                                url: `${comfyUrl}/view?filename=${gif.filename}&subfolder=${gif.subfolder || ''}&type=${gif.type || 'output'}`,
                                filename: gif.filename
                            });
                        }
                    }
                }
            }
        }
    }

    return { completed, promptId, results };
}

// ---- Automatic1111 generation helper ----
async function generateViaA1111(serviceUrl, params) {
    const payload = {
        prompt: params.prompt || '',
        negative_prompt: params.negative_prompt || '',
        width: params.width || 512,
        height: params.height || 512,
        steps: params.steps || 20,
        cfg_scale: params.cfg_scale || 7,
        sampler_name: params.sampler || 'DPM++ 2M',
        seed: params.seed || -1,
        batch_size: params.batch_size || 1,
        save_images: true
    };

    console.log(`[A1111] Sending txt2img to ${serviceUrl}/sdapi/v1/txt2img`);
    console.log(`[A1111] Payload: prompt="${payload.prompt.substring(0, 80)}" ${payload.width}x${payload.height} steps=${payload.steps}`);

    const response = await fetch(`${serviceUrl}/sdapi/v1/txt2img`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(180000) // 3 min timeout
    });

    if (!response.ok) {
        let errDetail = `HTTP ${response.status}`;
        try { errDetail = (await response.json()).detail || errDetail; } catch { }
        throw new Error(`Automatic1111 rejected the request: ${errDetail}`);
    }

    const result = await response.json();

    if (!result.images || result.images.length === 0) {
        throw new Error('Automatic1111 returned no images');
    }

    // Convert base64 images to data URIs the frontend can display directly
    const images = result.images.map((b64, i) => ({
        url: `data:image/png;base64,${b64}`,
        filename: `a1111_${Date.now()}_${i}.png`
    }));

    console.log(`[A1111] Generated ${images.length} image(s) successfully`);
    return { status: 'completed', images, gifs: [] };
}

// Smart generate endpoint — auto-detects engine (A1111 or ComfyUI)
app.post('/api/pods/:id/generate', asyncHandler(async (req, res) => {
    const podId = req.params.id;
    const params = req.body;

    try {
        const { serviceUrl, engine } = await resolvePodUrl(podId);

        // ---- Automatic1111 path (proven approach from companion project) ----
        if (engine === 'a1111') {
            const result = await generateViaA1111(serviceUrl, params);
            database.updatePodActivity(podId);
            return res.json(result);
        }

        // ---- ComfyUI path (original workflow-based approach) ----
        let workflow;
        let isVideo = false;

        if (params.rawWorkflow && typeof params.rawWorkflow === 'object') {
            // User uploaded a workflow_api.json directly — use it as-is
            workflow = JSON.parse(JSON.stringify(params.rawWorkflow));
            // Detect if video by checking node types
            const classTypes = Object.values(workflow).map(n => n.class_type || '');
            isVideo = classTypes.some(c => c.includes('AnimateDiff') || c === 'VHS_VideoCombine');
            console.log(`[ComfyUI] Using user-uploaded raw workflow (${Object.keys(workflow).length} nodes, video=${isVideo})`);

            // Inject prompt into CLIP text encode nodes if user provided one
            if (params.prompt) {
                for (const [nodeId, node] of Object.entries(workflow)) {
                    if (node.class_type === 'CLIPTextEncode' || node.class_type === 'CLIPTextEncodeLumina2') {
                        const title = (node._meta?.title || '').toLowerCase();
                        if (!title.includes('negativ')) {
                            const field = node.class_type === 'CLIPTextEncodeLumina2' ? 'user_prompt' : 'text';
                            if (node.inputs && (node.inputs[field] === '' || node.inputs[field])) {
                                node.inputs[field] = params.prompt;
                                console.log(`[ComfyUI] Injected prompt into node ${nodeId} (${node.class_type})`);
                            }
                        } else if (params.negative_prompt) {
                            const field = node.class_type === 'CLIPTextEncodeLumina2' ? 'user_prompt' : 'text';
                            node.inputs[field] = params.negative_prompt;
                        }
                    }
                }
            }
        } else {
            // Use built-in workflow template
            const workflowId = params.workflowId || 'image_sdxl_default';
            workflow = workflowEngine.buildPrompt(workflowId, params);
            isVideo = workflowEngine.getWorkflow(workflowId)?.category === 'video' ||
                workflowEngine.getWorkflow(workflowId)?.hasVideo;
        }

        // Always try to get checkpoints and auto-fix names (handles 'Value not in list' errors)
        const checkpoints = await getAvailableCheckpoints(serviceUrl);
        console.log(`[ComfyUI] Available checkpoints: ${checkpoints.length > 0 ? checkpoints.join(', ') : 'none detected'}`);

        if (!params.rawWorkflow) {
            // Built-in template: block if no models at all
            if (checkpoints.length === 0) {
                const comfyUiUrl = `https://${podId}-8188.proxy.runpod.net`;
                return res.status(400).json({
                    error: 'NO_CHECKPOINTS',
                    message: `⚠️ ComfyUI no tiene ningún modelo descargado todavía. Para generar imágenes necesitas:\n\n` +
                        `1️⃣ Abre ComfyUI directamente: ${comfyUiUrl}\n` +
                        `2️⃣ Usa el Manager para descargar un modelo (ej: SDXL, Stable Diffusion 1.5)\n` +
                        `3️⃣ Configura un workflow en ComfyUI y verifica que funciona\n` +
                        `4️⃣ Vuelve aquí y genera desde la app\n\n` +
                        `💡 TIP: Si prefieres generar sin configuración, crea un pod tipo "Image Gen (A1111)" que viene con modelos preinstalados.`,
                    comfyUiUrl
                });
            }
        }

        // Fix checkpoint names in workflow regardless of source (avoids 'Value not in list')
        if (checkpoints.length > 0) {
            workflow = fixCheckpointInWorkflow(workflow, checkpoints);
        }

        const { completed, promptId, results } = await executeWorkflowOnPod(
            serviceUrl, workflow, isVideo ? 300000 : 120000
        );

        if (!completed) {
            return res.json({
                status: 'pending',
                promptId,
                message: 'Generation still in progress. Check the pod directly.'
            });
        }

        database.updatePodActivity(podId);

        res.json({
            status: 'completed',
            images: results.images,
            gifs: results.gifs,
            promptId
        });
    } catch (error) {
        if (error.status) {
            return res.status(error.status).json({ error: error.message });
        }
        console.error('Generation error:', error);
        res.status(500).json({ error: error.message });
    }
}));

// Check if a pod's generation service is ready and has models
app.get('/api/pods/:id/check-ready', asyncHandler(async (req, res) => {
    const podId = req.params.id;
    try {
        const { serviceUrl, engine } = await resolvePodUrl(podId);
        const comfyUiUrl = `https://${podId}-8188.proxy.runpod.net`;

        // For ComfyUI, just return ready with the URL — the user tests via workflow upload
        // Don't try to query checkpoints here (it's slow and unreliable via proxy)
        if (engine === 'comfyui') {
            return res.json({ ready: true, engine, comfyUiUrl, serviceUrl });
        }

        if (engine === 'a1111') {
            try {
                const resp = await fetch(`${serviceUrl}/sdapi/v1/sd-models`, {
                    signal: AbortSignal.timeout(8000)
                });
                if (resp.ok) {
                    const models = await resp.json();
                    return res.json({ ready: true, engine, models: models.length, serviceUrl });
                }
            } catch (e) { /* fall through */ }
            return res.json({
                ready: false, engine, models: 0, serviceUrl,
                message: 'Automatic1111 todavía está cargando. Espera unos minutos.'
            });
        }

        // Default: assume ready
        return res.json({ ready: true, engine, serviceUrl });
    } catch (error) {
        res.json({
            ready: false, engine: 'unknown', models: 0,
            message: error.message || 'No se pudo conectar al pod.'
        });
    }
}));

// ==================== Batch Generation (via Pod) ====================
app.post('/api/pods/:id/batch', asyncHandler(async (req, res) => {
    const podId = req.params.id;
    const { prompts, workflowId = 'image_sdxl_default', params = {} } = req.body;

    if (!prompts || !Array.isArray(prompts) || prompts.length === 0) {
        return res.status(400).json({ error: 'An array of prompts is required' });
    }

    if (prompts.length > 100) {
        return res.status(400).json({ error: 'Maximum 100 prompts per batch' });
    }

    try {
        const { serviceUrl, engine } = await resolvePodUrl(podId);

        // A1111 batch: just loop generateViaA1111
        if (engine === 'a1111') {
            res.json({
                status: 'batch_started',
                total: prompts.length,
                workflowId,
                message: `Batch of ${prompts.length} prompts queued (A1111). Progress via WebSocket.`
            });

            const allResults = [];
            for (let i = 0; i < prompts.length; i++) {
                const promptText = prompts[i].trim();
                if (!promptText) continue;
                queueManager.broadcast('batch:progress', {
                    podId, current: i + 1, total: prompts.length,
                    prompt: promptText.substring(0, 80), status: 'generating'
                });
                try {
                    const r = await generateViaA1111(serviceUrl, { ...params, prompt: promptText });
                    allResults.push({ index: i, prompt: promptText.substring(0, 80), status: 'completed', images: r.images, gifs: [] });
                } catch (err) {
                    allResults.push({ index: i, prompt: promptText.substring(0, 80), status: 'error', error: err.message });
                }
                database.updatePodActivity(podId);
            }
            queueManager.broadcast('batch:complete', {
                podId, total: prompts.length,
                completed: allResults.filter(r => r.status === 'completed').length,
                failed: allResults.filter(r => r.status === 'error').length,
                results: allResults
            });
            return;
        }

        const comfyUrl = serviceUrl;
        const wf = workflowEngine.getWorkflow(workflowId);
        const isVideo = wf?.category === 'video' || wf?.hasVideo;

        // Auto-detect checkpoints once for the whole batch
        const checkpoints = await getAvailableCheckpoints(comfyUrl);

        // Start batch in the background — send a start response immediately
        res.json({
            status: 'batch_started',
            total: prompts.length,
            workflowId,
            message: `Batch of ${prompts.length} prompts queued. Progress via WebSocket.`
        });

        // Process sequentially in background and broadcast progress via WebSocket
        const allResults = [];
        for (let i = 0; i < prompts.length; i++) {
            const promptText = prompts[i].trim();
            if (!promptText) continue;

            // Broadcast progress
            queueManager.broadcast('batch:progress', {
                podId,
                current: i + 1,
                total: prompts.length,
                prompt: promptText.substring(0, 80),
                status: 'generating'
            });

            try {
                let workflow = workflowEngine.buildPrompt(workflowId, {
                    ...params,
                    prompt: promptText
                });
                if (checkpoints.length > 0) {
                    workflow = fixCheckpointInWorkflow(workflow, checkpoints);
                }
                const { completed, results } = await executeWorkflowOnPod(
                    comfyUrl, workflow, isVideo ? 300000 : 120000
                );
                allResults.push({
                    index: i,
                    prompt: promptText.substring(0, 80),
                    status: completed ? 'completed' : 'timeout',
                    images: results.images,
                    gifs: results.gifs
                });
            } catch (err) {
                allResults.push({
                    index: i,
                    prompt: promptText.substring(0, 80),
                    status: 'error',
                    error: err.message
                });
            }

            database.updatePodActivity(podId);
        }

        // Broadcast batch complete
        queueManager.broadcast('batch:complete', {
            podId,
            total: prompts.length,
            completed: allResults.filter(r => r.status === 'completed').length,
            failed: allResults.filter(r => r.status === 'error').length,
            results: allResults
        });

    } catch (error) {
        if (error.status) {
            // Already sent response, broadcast error via WebSocket
            queueManager.broadcast('batch:error', {
                podId,
                error: error.message
            });
            return;
        }
        console.error('Batch error:', error);
    }
}))

// ==================== Pod Workspace Backup ====================
app.post('/api/pods/:id/backup', asyncHandler(async (req, res) => {
    const podId = req.params.id;

    // Get pod details
    const pods = await runpodClient.getPods();
    const pod = pods.find(p => p.id === podId);

    if (!pod) {
        return res.status(404).json({ error: 'Pod no encontrado' });
    }

    if (pod.desiredStatus !== 'RUNNING') {
        return res.status(400).json({ error: 'El pod debe estar en ejecución (RUNNING) para crear un backup' });
    }

    // Check runtime is ready (has ports)
    if (!pod.runtime || !pod.runtime.ports) {
        return res.status(400).json({ error: 'El pod aún se está iniciando. Espera unos momentos.' });
    }

    // Determine output directory based on task type
    const trackedPods = database.getTrackedPods();
    const trackedPod = trackedPods.find(p => p.id === podId);
    const taskType = trackedPod?.taskType || 'imageGen';
    let outputDir;
    if (taskType === 'musicGen') {
        outputDir = '/workspace/output';
    } else if (taskType === 'imageGenA1111') {
        outputDir = '/workspace/stable-diffusion-webui/outputs/txt2img-images';
    } else {
        outputDir = '/workspace/ComfyUI/output';
    }

    // Use the proxy URL to access Jupyter file API (port 8888)
    const jupyterUrl = `https://${podId}-8888.proxy.runpod.net`;

    try {
        // List files via Jupyter contents API
        const listUrl = `${jupyterUrl}/api/contents${outputDir}?type=directory&_=${Date.now()}`;
        const listResponse = await fetch(listUrl, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(15000)
        });

        if (!listResponse.ok) {
            if (listResponse.status === 404) {
                return res.status(200).json({ error: 'No se encontró el directorio de output. Puede que aún no haya archivos generados.' });
            }
            throw new Error(`Error al acceder al pod: ${listResponse.status}`);
        }

        const listing = await listResponse.json();
        const files = (listing.content || []).filter(item => item.type === 'file');

        if (files.length === 0) {
            return res.status(200).json({ error: 'No hay archivos de output para descargar.' });
        }

        // Set ZIP headers
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="pod-backup-${podId.slice(0, 8)}.zip"`);

        // Build a simple ZIP in memory using Node's built-in facilities
        // Since we don't have archiver, we'll stream files individually as a tar.gz
        // Actually let's download files and create a proper response
        const fileBuffers = [];

        for (const file of files.slice(0, 50)) { // Limit to 50 files
            try {
                const fileUrl = `${jupyterUrl}/files${outputDir}/${encodeURIComponent(file.name)}`;
                const fileResponse = await fetch(fileUrl, {
                    signal: AbortSignal.timeout(30000)
                });
                if (fileResponse.ok) {
                    const buffer = await fileResponse.arrayBuffer();
                    fileBuffers.push({
                        name: file.name,
                        data: Buffer.from(buffer)
                    });
                }
            } catch (fileError) {
                console.warn(`Failed to download file ${file.name}:`, fileError.message);
            }
        }

        if (fileBuffers.length === 0) {
            res.removeHeader('Content-Type');
            res.removeHeader('Content-Disposition');
            return res.status(200).json({ error: 'No se pudieron descargar los archivos.' });
        }

        // Create a minimal ZIP file
        const zipBuffer = createMinimalZip(fileBuffers);
        res.end(zipBuffer);

    } catch (error) {
        console.error('Backup error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: `Error al crear backup: ${error.message}` });
        }
    }
}));

// Minimal ZIP file creator (no external dependencies)
function createMinimalZip(files) {
    const localHeaders = [];
    const centralHeaders = [];
    let offset = 0;

    for (const file of files) {
        const nameBuffer = Buffer.from(file.name, 'utf8');
        const data = file.data;

        // Local file header (30 bytes + name + data)
        const local = Buffer.alloc(30 + nameBuffer.length);
        local.writeUInt32LE(0x04034b50, 0); // Signature
        local.writeUInt16LE(20, 4);          // Version needed
        local.writeUInt16LE(0, 6);           // Flags
        local.writeUInt16LE(0, 8);           // Compression method (none)
        local.writeUInt16LE(0, 10);          // Mod time
        local.writeUInt16LE(0, 12);          // Mod date
        // CRC-32
        const crc = crc32(data);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18); // Compressed size
        local.writeUInt32LE(data.length, 22); // Uncompressed size
        local.writeUInt16LE(nameBuffer.length, 26); // Name length
        local.writeUInt16LE(0, 28);           // Extra field length
        nameBuffer.copy(local, 30);

        localHeaders.push(Buffer.concat([local, data]));

        // Central directory header (46 bytes + name)
        const central = Buffer.alloc(46 + nameBuffer.length);
        central.writeUInt32LE(0x02014b50, 0); // Signature
        central.writeUInt16LE(20, 4);          // Version made by
        central.writeUInt16LE(20, 6);          // Version needed
        central.writeUInt16LE(0, 8);           // Flags
        central.writeUInt16LE(0, 10);          // Compression
        central.writeUInt16LE(0, 12);          // Mod time
        central.writeUInt16LE(0, 14);          // Mod date
        central.writeUInt32LE(crc, 16);        // CRC-32
        central.writeUInt32LE(data.length, 20); // Compressed size
        central.writeUInt32LE(data.length, 24); // Uncompressed size
        central.writeUInt16LE(nameBuffer.length, 28); // Name length
        central.writeUInt16LE(0, 30);           // Extra field length
        central.writeUInt16LE(0, 32);           // Comment length
        central.writeUInt16LE(0, 34);           // Disk number
        central.writeUInt16LE(0, 36);           // Internal attributes
        central.writeUInt32LE(0, 38);           // External attributes
        central.writeUInt32LE(offset, 42);      // Offset of local header
        nameBuffer.copy(central, 46);

        centralHeaders.push(central);

        offset += local.length + data.length;
    }

    const centralDir = Buffer.concat(centralHeaders);
    const centralDirSize = centralDir.length;

    // End of central directory
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);           // Signature
    eocd.writeUInt16LE(0, 4);                     // Disk number
    eocd.writeUInt16LE(0, 6);                     // Start disk
    eocd.writeUInt16LE(files.length, 8);          // Entries on disk
    eocd.writeUInt16LE(files.length, 10);         // Total entries
    eocd.writeUInt32LE(centralDirSize, 12);       // Central dir size
    eocd.writeUInt32LE(offset, 16);               // Central dir offset
    eocd.writeUInt16LE(0, 20);                    // Comment length

    return Buffer.concat([...localHeaders, centralDir, eocd]);
}

// Simple CRC-32 implementation
function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
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
            id: 'comfyui-official',
            name: 'ComfyUI (RunPod Official)',
            imageName: 'runpod/comfyui:latest',
            isPublic: true,
            description: 'Official RunPod ComfyUI template - Stable and maintained'
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
