/**
 * Workflow Engine - Manages ComfyUI workflow templates
 * 
 * Loads workflow JSON files from the /workflows directory,
 * detects injectable nodes, and injects user parameters.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKFLOWS_DIR = join(__dirname, '..', 'workflows');

// Metadata for known workflows (enriches auto-detected info)
const WORKFLOW_METADATA = {
    'image_sdxl_default': {
        name: '🎨 Imagen SDXL (Default)',
        description: 'Generación de imágenes con Stable Diffusion XL. Workflow integrado en la app.',
        category: 'image',
        builtIn: true
    },
    'image_lumina2': {
        name: '🎨 Imagen Lumina2',
        description: 'Generación de imágenes con modelo Lumina2 y VAE Tiled.',
        category: 'image'
    },
    'video_animatediff': {
        name: '🎬 Vídeo AnimateDiff',
        description: 'Generación de vídeo/GIF animado con AnimateDiff (16 frames, 8fps).',
        category: 'video'
    },
    'video_pose_controlnet': {
        name: '🕺 Vídeo Pose + ControlNet',
        description: 'Vídeo con control de pose corporal usando ControlNet OpenPose + AnimateDiff.',
        category: 'video'
    }
};

// Class types where we can inject prompts
const PROMPT_INJECTION_TYPES = [
    'CLIPTextEncode',
    'CLIPTextEncodeLumina2'
];

class WorkflowEngine {
    constructor() {
        this.workflows = new Map();
        this._loadAllWorkflows();
    }

    /**
     * Scan the workflows directory and load all .json files
     */
    _loadAllWorkflows() {
        if (!existsSync(WORKFLOWS_DIR)) {
            mkdirSync(WORKFLOWS_DIR, { recursive: true });
        }

        const files = readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.json'));

        for (const file of files) {
            const id = basename(file, '.json');
            try {
                const raw = readFileSync(join(WORKFLOWS_DIR, file), 'utf-8');
                const workflow = JSON.parse(raw);
                const analysis = this._analyzeWorkflow(workflow);
                const meta = WORKFLOW_METADATA[id] || {};

                this.workflows.set(id, {
                    id,
                    name: meta.name || id,
                    description: meta.description || `Workflow: ${id}`,
                    category: meta.category || this._guessCategory(workflow),
                    fileName: file,
                    nodeCount: Object.keys(workflow).length,
                    injectableNodes: analysis.injectableNodes,
                    hasVideo: analysis.hasVideo,
                    hasPose: analysis.hasPose,
                    raw: workflow
                });

                console.log(`  ✅ Workflow loaded: ${meta.name || id} (${Object.keys(workflow).length} nodes)`);
            } catch (err) {
                console.warn(`  ⚠️ Failed to load workflow ${file}: ${err.message}`);
            }
        }

        console.log(`📂 Workflow Engine: ${this.workflows.size} workflows loaded from ${WORKFLOWS_DIR}`);
    }

    /**
     * Analyze a workflow to find injectable nodes and capabilities
     */
    _analyzeWorkflow(workflow) {
        const injectableNodes = [];
        let hasVideo = false;
        let hasPose = false;

        for (const [nodeId, node] of Object.entries(workflow)) {
            const classType = node.class_type || '';

            // Detect prompt injection points (CLIP Text Encode nodes)
            if (PROMPT_INJECTION_TYPES.includes(classType)) {
                const title = node._meta?.title || '';
                const isNegative = title.toLowerCase().includes('negativ') ||
                    (node.inputs?.text === '' && injectableNodes.some(n => n.role === 'positive'));

                injectableNodes.push({
                    nodeId,
                    classType,
                    title,
                    role: isNegative ? 'negative' : 'positive',
                    inputField: classType === 'CLIPTextEncodeLumina2' ? 'user_prompt' : 'text'
                });
            }

            // Detect KSampler for seed/steps/cfg injection
            if (classType === 'KSampler') {
                injectableNodes.push({
                    nodeId,
                    classType: 'KSampler',
                    title: node._meta?.title || 'KSampler',
                    role: 'sampler',
                    inputField: null // multiple fields
                });
            }

            // Detect EmptyLatentImage for dimension injection
            if (classType === 'EmptyLatentImage') {
                injectableNodes.push({
                    nodeId,
                    classType: 'EmptyLatentImage',
                    title: node._meta?.title || 'Empty Latent',
                    role: 'dimensions',
                    inputField: null
                });
            }

            // Detect video-related nodes
            if (classType.includes('AnimateDiff') || classType === 'VHS_VideoCombine') {
                hasVideo = true;
            }

            // Detect pose control
            if (classType.includes('ControlNet') || classType === 'ControlNetLoader') {
                hasPose = true;
            }
        }

        return { injectableNodes, hasVideo, hasPose };
    }

    /**
     * Guess the category of a workflow based on its nodes
     */
    _guessCategory(workflow) {
        const classTypes = Object.values(workflow).map(n => n.class_type || '');
        if (classTypes.some(c => c.includes('AnimateDiff') || c === 'VHS_VideoCombine')) {
            return 'video';
        }
        return 'image';
    }

    /**
     * List all available workflows (for API response)
     */
    listWorkflows() {
        const list = [];

        // Add built-in SDXL workflow first
        const sdxlMeta = WORKFLOW_METADATA['image_sdxl_default'];
        list.push({
            id: 'image_sdxl_default',
            name: sdxlMeta.name,
            description: sdxlMeta.description,
            category: 'image',
            builtIn: true,
            hasVideo: false,
            hasPose: false,
            nodeCount: 7
        });

        // Add file-based workflows
        for (const [id, wf] of this.workflows) {
            list.push({
                id: wf.id,
                name: wf.name,
                description: wf.description,
                category: wf.category,
                builtIn: false,
                hasVideo: wf.hasVideo,
                hasPose: wf.hasPose,
                nodeCount: wf.nodeCount
            });
        }

        return list;
    }

    /**
     * Get a workflow by ID
     */
    getWorkflow(id) {
        if (id === 'image_sdxl_default') {
            return { id, builtIn: true, category: 'image' };
        }
        return this.workflows.get(id) || null;
    }

    /**
     * Build a ready-to-send ComfyUI prompt from a workflow template + user params
     */
    buildPrompt(workflowId, params) {
        const {
            prompt = '',
            negative_prompt = 'blurry, bad quality, low resolution',
            width = 1024,
            height = 1024,
            steps = 20,
            cfg_scale = 7,
            sampler = 'euler',
            seed = null,
            batch_size = 1,
            frames = 16,
            fps = 8
        } = params;

        // Built-in SDXL workflow: return the hardcoded version
        if (workflowId === 'image_sdxl_default') {
            return this._buildDefaultSDXL(params);
        }

        const wf = this.workflows.get(workflowId);
        if (!wf) {
            throw new Error(`Workflow not found: ${workflowId}`);
        }

        // Deep clone the workflow
        const workflow = JSON.parse(JSON.stringify(wf.raw));

        // Inject parameters into detected nodes
        for (const injectable of wf.injectableNodes) {
            const node = workflow[injectable.nodeId];
            if (!node) continue;

            switch (injectable.role) {
                case 'positive':
                    node.inputs[injectable.inputField] = prompt;
                    break;
                case 'negative':
                    node.inputs[injectable.inputField] = negative_prompt;
                    break;
                case 'sampler':
                    node.inputs.steps = steps;
                    node.inputs.cfg = cfg_scale;
                    node.inputs.sampler_name = sampler;
                    node.inputs.seed = seed || Math.floor(Math.random() * 999999999999);
                    break;
                case 'dimensions':
                    node.inputs.width = width;
                    node.inputs.height = height;
                    if (wf.hasVideo) {
                        node.inputs.batch_size = frames;
                    } else {
                        node.inputs.batch_size = batch_size;
                    }
                    break;
            }
        }

        // Inject video-specific params
        if (wf.hasVideo) {
            for (const [nodeId, node] of Object.entries(workflow)) {
                if (node.class_type === 'VHS_VideoCombine') {
                    node.inputs.frame_rate = fps;
                }
            }
        }

        return workflow;
    }

    /**
     * Built-in SDXL workflow (the one already in server.js)
     */
    _buildDefaultSDXL(params) {
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

    /**
     * Save a custom workflow uploaded by the user
     */
    saveCustomWorkflow(name, workflowJson) {
        const id = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        const filePath = join(WORKFLOWS_DIR, `${id}.json`);

        writeFileSync(filePath, JSON.stringify(workflowJson, null, 2), 'utf-8');

        // Re-analyze and add to cache
        const analysis = this._analyzeWorkflow(workflowJson);
        this.workflows.set(id, {
            id,
            name: `📄 ${name}`,
            description: `Custom workflow: ${name}`,
            category: this._guessCategory(workflowJson),
            fileName: `${id}.json`,
            nodeCount: Object.keys(workflowJson).length,
            injectableNodes: analysis.injectableNodes,
            hasVideo: analysis.hasVideo,
            hasPose: analysis.hasPose,
            raw: workflowJson
        });

        return { id, name };
    }
}

export const workflowEngine = new WorkflowEngine();
