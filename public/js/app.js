/**
 * GPU Orchestrator - Main Application
 */

class GPUOrchestrator {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.pods = [];
    this.endpoints = [];
    this.jobs = [];
    this.gpus = [];
    this.benchmarks = [];
    this.activity = [];
    this.uiMode = localStorage.getItem('gpuOrchUIMode') || 'easy';
    this.easySelectedTool = 'imageGen';
    this.workflows = [];
    this.selectedWorkflowId = 'image_sdxl_default';
    this.generatedVideos = [];

    this.init();
  }

  // ==================== Initialization ====================
  async init() {
    this.applyUIMode(this.uiMode);
    this.setupWebSocket();
    this.setupNavigation();
    this.setupEventListeners();

    // Initial data load
    await this.refreshAll();

    // Periodic refresh
    setInterval(() => this.refreshAll(), 30000);
  }

  // ==================== UI Mode Toggle ====================
  applyUIMode(mode) {
    this.uiMode = mode;
    document.body.classList.remove('mode-easy', 'mode-advanced');
    document.body.classList.add(`mode-${mode}`);
    localStorage.setItem('gpuOrchUIMode', mode);
  }

  toggleUIMode() {
    const newMode = this.uiMode === 'easy' ? 'advanced' : 'easy';
    this.applyUIMode(newMode);
    const label = newMode === 'easy' ? '🟢 Modo Fácil activado' : '🔧 Modo Avanzado activado';
    this.showToast('Modo Cambiado', label, 'info');
    // If user was on a hidden tab in easy mode, redirect to dashboard
    if (newMode === 'easy') {
      const activeTab = document.querySelector('.nav-tab.active');
      if (activeTab && (activeTab.dataset.tab === 'serverless' || activeTab.dataset.tab === 'jobs')) {
        this.switchTab('dashboard');
      }
    }
    // Update payload preview if on generate tab
    this.updatePayloadPreview();
  }

  // ==================== Easy Mode: Tool Selection & Launch ====================
  selectEasyTool(tool) {
    this.easySelectedTool = tool;
    document.getElementById('easyToolImages')?.classList.toggle('selected', tool === 'imageGen');
    document.getElementById('easyToolMusic')?.classList.toggle('selected', tool === 'musicGen');
  }

  async easyLaunchPod() {
    const btn = document.getElementById('easyLaunchBtn');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '⏳ Buscando GPU disponible...';

    try {
      // Load GPUs if needed
      if (this.gpus.length === 0) {
        this.gpus = await this.api('GET', '/gpus');
      }

      const template = this.builtInTemplates[this.easySelectedTool];
      const minVram = template.minVram;

      // Auto-select best GPU: cheapest available with enough VRAM, prefer 24GB+
      const candidates = this.gpus
        .filter(g => (g.communityCloud || g.secureCloud) && g.displayName)
        .filter(g => (g.memoryInGb || 0) >= minVram)
        .sort((a, b) => {
          // Prefer 24GB+ GPUs, then sort by price
          const aGood = (a.memoryInGb || 0) >= 24 ? 0 : 1;
          const bGood = (b.memoryInGb || 0) >= 24 ? 0 : 1;
          if (aGood !== bGood) return aGood - bGood;
          return (a.communityPrice || a.securePrice || 999) - (b.communityPrice || b.securePrice || 999);
        });

      if (candidates.length === 0) {
        throw new Error('No hay GPUs disponibles con suficiente VRAM. Intenta más tarde.');
      }

      const bestGpu = candidates[0];
      const toolName = this.easySelectedTool === 'imageGen' ? 'Imágenes' : 'Música';
      const podName = `easy-${this.easySelectedTool === 'imageGen' ? 'img' : 'music'}-${Date.now().toString(36)}`;

      const data = {
        name: podName,
        gpuTypeId: bestGpu.id,
        volumeInGb: template.defaultVolume,
        containerDiskInGb: template.defaultContainerDisk,
        cloudType: 'ALL',
        taskType: this.easySelectedTool,
        port: template.port,
        spendingLimit: 2 // $2 safety limit for easy mode
      };

      if (template.templateId) {
        data.templateId = template.templateId;
      } else {
        data.imageName = template.imageName;
      }

      await this.api('POST', '/pods', data);
      const price = (bestGpu.communityPrice || bestGpu.securePrice || 0).toFixed(3);
      this.showToast('🚀 ¡Máquina Lanzada!',
        `${toolName} con ${bestGpu.displayName} ($${price}/hr). Límite: $2.00`,
        'success');
      await this.loadPods();
      this.switchTab('pods');
    } catch (error) {
      this.showToast('Error', error.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '🚀 ¡Lanzar Máquina!';
    }
  }

  setupWebSocket() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.connected = true;
      this.updateConnectionStatus('connected');
      this.addActivity('🔌', 'Connected to server');
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.updateConnectionStatus('disconnected');
      // Reconnect after 3 seconds
      setTimeout(() => this.setupWebSocket(), 3000);
    };

    this.ws.onerror = () => {
      this.updateConnectionStatus('disconnected');
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleWebSocketMessage(data);
      } catch (e) {
        console.error('WebSocket message parse error:', e);
      }
    };

    // Keepalive
    setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  }

  handleWebSocketMessage(data) {
    const { event, data: eventData } = data;

    switch (event) {
      case 'job:created':
        this.addActivity('📝', `Job created: ${eventData.id.slice(0, 8)}...`);
        this.loadJobs();
        break;
      case 'job:running':
        this.addActivity('▶️', `Job started: ${eventData.id.slice(0, 8)}...`);
        this.loadJobs();
        break;
      case 'job:completed':
        this.addActivity('✅', `Job completed: ${eventData.id.slice(0, 8)}...`);
        this.showToast('Job Completado', 'Un trabajo ha terminado correctamente', 'success');
        this.loadJobs();
        break;
      case 'job:failed':
        this.addActivity('❌', `Job failed: ${eventData.id.slice(0, 8)}...`);
        this.showToast('Job Fallido', eventData.error || 'Error desconocido', 'error');
        this.loadJobs();
        break;
      case 'pod:auto-stopped':
        this.addActivity('⏰', `Auto-stopped: ${eventData.podName}`);
        this.showToast('Pod Auto-Detenido', `${eventData.podName} parado por inactividad`, 'warning');
        this.loadPods();
        break;
      case 'pod:spending-limit-exceeded':
        this.addActivity('💰', `Límite excedido: ${eventData.podName} ($${eventData.totalSpent})`);
        this.showToast('⚠️ Límite de Gasto', `${eventData.podName} eliminado: gastó $${eventData.totalSpent}/$${eventData.spendingLimit}`, 'warning');
        this.loadPods();
        break;
      case 'pod:auto-stop-failed':
      case 'pod:terminate-failed':
        this.showToast('Error', `No se pudo detener el pod: ${eventData.error}`, 'error');
        break;
      case 'batch:progress':
        this.handleBatchProgress(eventData);
        break;
      case 'batch:complete':
        this.handleBatchComplete(eventData);
        break;
      case 'batch:error':
        this.showToast('Batch Error', eventData.error, 'error');
        this.hideBatchProgress();
        break;
    }
  }

  updateConnectionStatus(status) {
    const statusEl = document.getElementById('connectionStatus');
    const dot = statusEl.querySelector('.status-dot');
    const text = statusEl.querySelector('.status-text');

    dot.className = `status-dot ${status}`;
    text.textContent = status === 'connected' ? 'Connected' :
      status === 'disconnected' ? 'Disconnected' : 'Connecting...';
  }

  setupNavigation() {
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const tabId = tab.dataset.tab;
        this.switchTab(tabId);
      });
    });
  }

  switchTab(tabId) {
    // Update nav tabs
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`[data-tab="${tabId}"]`).classList.add('active');

    // Update content
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');
  }

  setupEventListeners() {
    // Benchmark tier tabs
    document.querySelectorAll('.bench-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.bench-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.filterBenchmarks(tab.dataset.tier);
      });
    });

    // Auto-shutdown toggle
    document.getElementById('autoShutdownToggle')?.addEventListener('change', (e) => {
      this.toggleAutoShutdown(e.target.checked);
    });
  }

  // ==================== API Calls ====================
  async api(method, path, body = null) {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`/api${path}`, options);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || data.errors?.join(', ') || 'Request failed');
    }

    return data;
  }

  // ==================== Refresh All Data ====================
  async refreshAll() {
    try {
      await Promise.all([
        this.loadAccount(),
        this.loadPods(),
        this.loadEndpoints(),
        this.loadJobs(),
        this.loadCosts(),
        this.loadBenchmarks(),
        this.loadAutoShutdownStatus()
      ]);
    } catch (error) {
      console.error('Error refreshing data:', error);
    }
  }

  // ==================== Account ====================
  async loadAccount() {
    try {
      const account = await this.api('GET', '/account');
      document.getElementById('balanceDisplay').querySelector('.balance-value').textContent =
        `$${(account.clientBalance || 0).toFixed(2)}`;
    } catch (error) {
      console.error('Error loading account:', error);
    }
  }

  // ==================== Pods ====================
  async loadPods() {
    try {
      this.pods = await this.api('GET', '/pods');
      this.renderPods();
      this.updateStats();
    } catch (error) {
      console.error('Error loading pods:', error);
      document.getElementById('podsGrid').innerHTML =
        `<div class="empty-state"><div class="empty-state-icon">⚠️</div><p>Error loading pods</p></div>`;
    }
  }

  renderPods() {
    const grid = document.getElementById('podsGrid');

    if (this.pods.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🖥️</div>
          <p class="empty-state-text">No hay pods activos</p>
          <button class="btn primary" onclick="app.showCreatePodModal()">Crear Primer Pod</button>
        </div>
      `;
      return;
    }

    grid.innerHTML = this.pods.map(pod => {
      const isRunning = pod.desiredStatus === 'RUNNING';
      const statusClass = this.getStatusClass(pod.desiredStatus);
      const connections = isRunning ? this.getPodConnectionUrls(pod.id) : [];

      return `
      <div class="resource-card ${statusClass}-card pod-card-animate">
        <div class="resource-header">
          <div class="resource-name-row">
            <div class="resource-name">${this.escapeHtml(pod.name)}</div>
          </div>
          <span class="resource-status ${statusClass}">
            <span class="status-indicator"></span>
            ${pod.desiredStatus}
          </span>
        </div>
        <div class="resource-details">
          <div class="resource-detail">
            <span class="resource-detail-label">GPU</span>
            <span class="resource-detail-value">${pod.machine?.gpuDisplayName || 'N/A'}</span>
          </div>
          <div class="resource-detail">
            <span class="resource-detail-label">Cost/hr</span>
            <span class="resource-detail-value cost-value">$${(pod.costPerHr || 0).toFixed(3)}</span>
          </div>
          <div class="resource-detail">
            <span class="resource-detail-label">Memory</span>
            <span class="resource-detail-value">${pod.memoryInGb || 0} GB</span>
          </div>
          <div class="resource-detail">
            <span class="resource-detail-label">Uptime</span>
            <span class="resource-detail-value">${this.formatDuration(pod.uptimeSeconds)}</span>
          </div>
        </div>

        ${isRunning ? `
        <div class="connection-panel">
          <div class="connection-panel-header">
            <span class="connection-title">🔗 Conexiones</span>
            <span class="connection-live-dot"></span>
          </div>
          ${connections.map(c => `
          <div class="connection-row">
            <div class="connection-info">
              <span class="connection-icon">${c.icon}</span>
              <div class="connection-meta">
                <span class="connection-label">${c.label}</span>
                <span class="connection-port">Puerto ${c.port}</span>
              </div>
            </div>
            <div class="connection-actions">
              <button class="btn-icon btn-copy" onclick="app.copyToClipboard('${c.url}')" title="Copiar URL">
                📋
              </button>
              <button class="btn-icon btn-open" onclick="window.open('${c.url}', '_blank')" title="Abrir en nueva pestaña">
                🔗
              </button>
            </div>
          </div>
          `).join('')}
        </div>
        ` : ''}

        <div class="resource-actions">
          ${isRunning ?
          `<button class="btn sm btn-backup" onclick="event.stopPropagation(); app.backupPodWorkspace('${pod.id}')" title="Descargar archivos generados">💾 Backup</button>
           <button class="btn sm warning" onclick="app.stopPod('${pod.id}')">⏹️ Stop</button>` :
          `<button class="btn sm primary" onclick="app.startPod('${pod.id}')">▶️ Start</button>`
        }
          <button class="btn sm danger" onclick="app.terminatePod('${pod.id}')">🗑️ Delete</button>
        </div>
      </div>
    `;
    }).join('');
  }

  getPodConnectionUrls(podId) {
    return [
      {
        icon: '🎨',
        label: 'ComfyUI (Imágenes)',
        port: 8188,
        url: `https://${podId}-8188.proxy.runpod.net`
      },
      {
        icon: '🎵',
        label: 'Gradio / HeartMuLa (Música)',
        port: 7860,
        url: `https://${podId}-7860.proxy.runpod.net`
      },
      {
        icon: '📓',
        label: 'Jupyter Lab (Archivos)',
        port: 8888,
        url: `https://${podId}-8888.proxy.runpod.net`
      }
    ];
  }

  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      this.showToast('URL Copiada', 'La URL se ha copiado al portapapeles', 'success');
    } catch (err) {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      this.showToast('URL Copiada', 'La URL se ha copiado al portapapeles', 'success');
    }
  }

  async stopPod(podId) {
    if (!confirm('Are you sure you want to stop this pod?')) return;

    try {
      await this.api('POST', `/pods/${podId}/stop`);
      this.showToast('Pod Stopped', 'Pod is now stopping', 'success');
      await this.loadPods();
    } catch (error) {
      this.showToast('Error', error.message, 'error');
    }
  }

  async startPod(podId) {
    try {
      await this.api('POST', `/pods/${podId}/start`);
      this.showToast('Pod Starting', 'Pod is now starting up', 'success');
      await this.loadPods();
    } catch (error) {
      this.showToast('Error', error.message, 'error');
    }
  }

  async terminatePod(podId) {
    if (!confirm('Are you sure you want to DELETE this pod? This action cannot be undone!')) return;

    try {
      await this.api('DELETE', `/pods/${podId}`);
      this.showToast('Pod Deleted', 'Pod has been terminated', 'success');
      await this.loadPods();
    } catch (error) {
      this.showToast('Error', error.message, 'error');
    }
  }

  async stopAllPods() {
    const runningPods = this.pods.filter(p => p.desiredStatus === 'RUNNING');
    if (runningPods.length === 0) {
      this.showToast('No Running Pods', 'There are no pods to stop', 'info');
      return;
    }

    if (!confirm(`Stop all ${runningPods.length} running pod(s)?`)) return;

    try {
      await Promise.all(runningPods.map(p => this.api('POST', `/pods/${p.id}/stop`)));
      this.showToast('All Pods Stopped', `Stopped ${runningPods.length} pod(s)`, 'success');
      await this.loadPods();
    } catch (error) {
      this.showToast('Error', error.message, 'error');
    }
  }

  // ==================== Create Pod Modal ====================
  // Built-in templates configuration
  builtInTemplates = {
    imageGen: {
      id: 'image-gen-comfyui',
      name: 'Image Gen (ComfyUI SDXL)',
      templateId: null, // Uses docker image directly
      imageName: 'hearmeman/comfyui-sdxl-template:v7',
      port: 8188,
      minVram: 8,
      icon: '🎨',
      description: 'Stable Diffusion XL con ComfyUI para generación de imágenes',
      defaultVolume: 20,
      defaultContainerDisk: 10
    },
    musicGen: {
      id: 'music-gen-heartmula',
      name: 'Music Gen (HeartMuLa Studio)',
      templateId: 'yxf2jxp1lu',
      imageName: null, // Uses template ID
      port: 7860,
      minVram: 16,
      icon: '🎵',
      description: 'Generación de música con IA - Requiere mínimo 16GB VRAM',
      defaultVolume: 50,
      defaultContainerDisk: 30,
      minVolume: 50,
      minContainerDisk: 30
    }
  };

  selectedTaskType = 'imageGen';

  async showCreatePodModal() {
    // Load GPUs if not loaded
    if (this.gpus.length === 0) {
      try {
        this.gpus = await this.api('GET', '/gpus');
      } catch (error) {
        this.showToast('Error', 'Failed to load GPU types', 'error');
        return;
      }
    }

    const modalBody = document.getElementById('modalBody');
    modalBody.innerHTML = `
      <form class="modal-form" onsubmit="app.createPod(event)">
        <!-- Task Type Selection -->
        <div class="form-group">
          <label>Tipo de Tarea *</label>
          <div class="task-type-selector">
            <div class="task-type-option active" data-type="imageGen" onclick="app.selectTaskType('imageGen')">
              <div class="task-type-icon">🎨</div>
              <div class="task-type-info">
                <div class="task-type-name">Image Gen</div>
                <div class="task-type-desc">ComfyUI SDXL</div>
              </div>
            </div>
            <div class="task-type-option" data-type="musicGen" onclick="app.selectTaskType('musicGen')">
              <div class="task-type-icon">🎵</div>
              <div class="task-type-info">
                <div class="task-type-name">Music Gen</div>
                <div class="task-type-desc">HeartMuLa Studio</div>
              </div>
            </div>
          </div>
        </div>

        <div id="taskTypeInfo" class="info-box">
          <strong>🎨 Image Gen:</strong> Generación de imágenes con Stable Diffusion XL y ComfyUI. 
          Funciona con GPUs de 8GB+.
        </div>

        <div class="form-group">
          <label for="podName">Nombre del Pod *</label>
          <input type="text" id="podName" required placeholder="mi-pod-ia" pattern="[a-zA-Z0-9-_]+" minlength="3" maxlength="50">
        </div>
        
        <div class="form-group">
          <label for="cloudType">Tipo de Cloud *</label>
          <select id="cloudType">
            <option value="COMMUNITY">🌐 Community Cloud (Más barato)</option>
            <option value="SECURE">🔒 Secure Cloud (Más fiable)</option>
            <option value="ALL" selected>🔄 Cualquier disponible</option>
          </select>
        </div>
        
        <div class="form-group">
          <label for="gpuType">GPU Type * <span id="gpuCount"></span></label>
          <select id="gpuType" required>
            <!-- GPUs will be populated dynamically -->
          </select>
          <div id="gpuWarning" class="warning-text" style="display: none;">
            ⚠️ Music Gen requiere mínimo 16GB VRAM
          </div>
        </div>
        
        <div class="form-group">
          <label for="volumeSize">Volumen (GB) - Almacenamiento persistente</label>
          <input type="number" id="volumeSize" value="20" min="0" max="1000">
        </div>
        
        <div class="form-group">
          <label for="containerDisk">Container Disk (GB) - Pon 0 para ninguno</label>
          <input type="number" id="containerDisk" value="10" min="0" max="500">
          <small style="color: var(--text-muted);">Almacenamiento temporal, se borra al reiniciar.</small>
        </div>

        <!-- Spending Limit -->
        <div class="form-group spending-limit-group">
          <label for="spendingLimit">
            💰 Límite de Gasto ($) 
            <span class="recommended-badge">⭐ Recomendado</span>
          </label>
          <input type="number" id="spendingLimit" value="1" min="0.1" max="100" step="0.1">
          <div class="limit-info-box">
            <span class="limit-icon">🛡️</span>
            <div class="limit-text">
              <strong>Protección anti-olvido:</strong> Si el pod gasta más de este límite, 
              se detendrá y eliminará automáticamente. ¡No más sustos en la factura!
            </div>
          </div>
          <small style="color: var(--text-muted);">Pon 0 para desactivar (no recomendado).</small>
        </div>
        
        <div class="modal-actions">
          <button type="button" class="btn" onclick="app.closeModal()">Cancelar</button>
          <button type="submit" class="btn primary" id="createPodBtn">Crear Pod</button>
        </div>
      </form>
    `;

    // Set initial task type and populate GPUs
    this.selectedTaskType = 'imageGen';
    this.updateGpuOptionsForTaskType();
    this.updateDiskDefaultsForTaskType();

    document.getElementById('modalTitle').textContent = 'Crear Nuevo Pod';
    document.getElementById('modalOverlay').classList.add('active');
  }

  selectTaskType(type) {
    this.selectedTaskType = type;
    const template = this.builtInTemplates[type];

    // Update UI selection
    document.querySelectorAll('.task-type-option').forEach(opt => {
      opt.classList.toggle('active', opt.dataset.type === type);
    });

    // Update info box
    const infoBox = document.getElementById('taskTypeInfo');
    if (type === 'imageGen') {
      infoBox.className = 'info-box';
      infoBox.innerHTML = `
        <strong>🎨 Image Gen:</strong> Generación de imágenes con Stable Diffusion XL y ComfyUI. 
        Funciona con GPUs de 8GB+.
      `;
    } else {
      infoBox.className = 'info-box warning';
      infoBox.innerHTML = `
        <strong>🎵 Music Gen:</strong> Generación de música con HeartMuLa Studio. 
        <strong>⚠️ Requiere mínimo 16GB VRAM</strong> (RTX 4090, A100, etc.)
      `;
    }

    // Update GPU options and disk defaults
    this.updateGpuOptionsForTaskType();
    this.updateDiskDefaultsForTaskType();
  }

  updateDiskDefaultsForTaskType() {
    const template = this.builtInTemplates[this.selectedTaskType];
    const volumeInput = document.getElementById('volumeSize');
    const containerInput = document.getElementById('containerDisk');

    // Set default values
    volumeInput.value = template.defaultVolume;
    containerInput.value = template.defaultContainerDisk;

    // Show/hide disk warning for music gen
    let diskWarning = document.getElementById('diskWarning');

    if (this.selectedTaskType === 'musicGen') {
      if (!diskWarning) {
        // Create warning element
        diskWarning = document.createElement('div');
        diskWarning.id = 'diskWarning';
        diskWarning.className = 'disk-warning-box';
        diskWarning.innerHTML = `
          <span class="disk-warning-icon">💾</span>
          <div class="disk-warning-text">
            <strong>Espacio recomendado para Music Gen:</strong><br>
            Volume: mínimo 50GB | Container: mínimo 30GB<br>
            <em>Menos espacio puede causar errores de instalación.</em>
          </div>
        `;
        containerInput.parentElement.after(diskWarning);
      }
      diskWarning.style.display = 'flex';

      // Set minimum values
      volumeInput.min = template.minVolume;
      containerInput.min = template.minContainerDisk;
    } else {
      if (diskWarning) {
        diskWarning.style.display = 'none';
      }
      volumeInput.min = 0;
      containerInput.min = 0;
    }
  }

  updateGpuOptionsForTaskType() {
    const template = this.builtInTemplates[this.selectedTaskType];
    const minVram = template.minVram;

    // Popular GPUs in order
    const popularGpuIds = [
      'NVIDIA GeForce RTX 4090',
      'NVIDIA GeForce RTX 3090',
      'NVIDIA RTX A5000',
      'NVIDIA RTX A4000',
      'NVIDIA GeForce RTX 4080',
      'NVIDIA GeForce RTX 3080',
      'NVIDIA RTX A6000',
      'NVIDIA L4',
      'NVIDIA A100 80GB PCIe',
      'NVIDIA A100-SXM4-80GB'
    ];

    // Filter GPUs by availability and VRAM requirement
    let availableGpus = this.gpus
      .filter(g => (g.communityCloud || g.secureCloud) && g.displayName)
      .filter(g => (g.memoryInGb || 0) >= minVram)
      .sort((a, b) => {
        const aPopular = popularGpuIds.indexOf(a.id);
        const bPopular = popularGpuIds.indexOf(b.id);
        if (aPopular !== -1 && bPopular === -1) return -1;
        if (aPopular === -1 && bPopular !== -1) return 1;
        if (aPopular !== -1 && bPopular !== -1) return aPopular - bPopular;
        return (a.communityPrice || a.securePrice || 0) - (b.communityPrice || b.securePrice || 0);
      });

    const gpuSelect = document.getElementById('gpuType');
    const gpuCount = document.getElementById('gpuCount');
    const gpuWarning = document.getElementById('gpuWarning');

    gpuCount.textContent = `(${availableGpus.length} disponibles)`;

    // Show warning for music gen
    gpuWarning.style.display = this.selectedTaskType === 'musicGen' ? 'block' : 'none';

    gpuSelect.innerHTML = availableGpus.map(g => {
      const price = (g.communityPrice || g.securePrice || 0).toFixed(3);
      const cloud = g.communityCloud ? '🌐' : '🔒';
      const vram = g.memoryInGb || '?';
      const recommended = vram >= 24 ? '⭐ ' : '';
      return `<option value="${g.id}">${recommended}${cloud} ${g.displayName || g.id} (${vram}GB) - $${price}/hr</option>`;
    }).join('');

    if (availableGpus.length === 0) {
      gpuSelect.innerHTML = '<option value="">No hay GPUs disponibles con suficiente VRAM</option>';
    }
  }

  onTemplateSelect(imageName) {
    // No longer used - task type selector handles templates
  }

  async createPod(event) {
    event.preventDefault();

    const containerDisk = parseInt(document.getElementById('containerDisk').value);
    const spendingLimit = parseFloat(document.getElementById('spendingLimit').value) || 0;
    const template = this.builtInTemplates[this.selectedTaskType];

    const data = {
      name: document.getElementById('podName').value,
      gpuTypeId: document.getElementById('gpuType').value,
      volumeInGb: parseInt(document.getElementById('volumeSize').value) || 0,
      containerDiskInGb: containerDisk > 0 ? containerDisk : null,
      cloudType: document.getElementById('cloudType').value,
      taskType: this.selectedTaskType,
      port: template.port,
      spendingLimit: spendingLimit > 0 ? spendingLimit : null
    };

    // Use template ID or docker image based on task type
    if (template.templateId) {
      data.templateId = template.templateId;
    } else {
      data.imageName = template.imageName;
    }

    try {
      await this.api('POST', '/pods', data);
      const limitMsg = spendingLimit > 0 ? ` (límite: $${spendingLimit})` : '';
      this.showToast('Pod Creado', `Tu pod de ${template.name} se está desplegando${limitMsg}`, 'success');
      this.closeModal();
      await this.loadPods();
    } catch (error) {
      this.showToast('Error', error.message, 'error');
    }
  }

  // ==================== Endpoints ====================
  async loadEndpoints() {
    try {
      this.endpoints = await this.api('GET', '/endpoints');
      this.renderEndpoints();
      this.updateStats();
    } catch (error) {
      console.error('Error loading endpoints:', error);
    }
  }

  renderEndpoints() {
    const grid = document.getElementById('endpointsGrid');

    if (this.endpoints.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">☁️</div>
          <p class="empty-state-text">No serverless endpoints</p>
          <button class="btn primary" onclick="app.showCreateEndpointModal()">Create First Endpoint</button>
        </div>
      `;
      return;
    }

    grid.innerHTML = this.endpoints.map(ep => `
      <div class="resource-card">
        <div class="resource-header">
          <div class="resource-name">${this.escapeHtml(ep.name)}</div>
          <span class="resource-status running">ACTIVE</span>
        </div>
        <div class="resource-details">
          <div class="resource-detail">
            <span class="resource-detail-label">Workers</span>
            <span class="resource-detail-value">${ep.workersMin} - ${ep.workersMax}</span>
          </div>
          <div class="resource-detail">
            <span class="resource-detail-label">Idle Timeout</span>
            <span class="resource-detail-value">${ep.idleTimeout}s</span>
          </div>
        </div>
        <div class="resource-actions">
          <button class="btn sm primary" onclick="app.showSubmitJobModal('${ep.id}')">📤 Submit Job</button>
          <button class="btn sm danger" onclick="app.deleteEndpoint('${ep.id}')">🗑️ Delete</button>
        </div>
      </div>
    `).join('');
  }

  async deleteEndpoint(endpointId) {
    if (!confirm('Delete this endpoint?')) return;

    try {
      await this.api('DELETE', `/endpoints/${endpointId}`);
      this.showToast('Endpoint Deleted', 'Serverless endpoint has been removed', 'success');
      await this.loadEndpoints();
    } catch (error) {
      this.showToast('Error', error.message, 'error');
    }
  }

  showCreateEndpointModal() {
    const modalBody = document.getElementById('modalBody');
    modalBody.innerHTML = `
      <div class="info-box">
        <strong>Note:</strong> Creating serverless endpoints requires a pre-built template in RunPod. 
        You can create templates from the RunPod console.
      </div>
      <form class="modal-form" onsubmit="app.createEndpoint(event)">
        <div class="form-group">
          <label for="endpointName">Endpoint Name *</label>
          <input type="text" id="endpointName" required placeholder="my-sd-endpoint">
        </div>
        
        <div class="form-group">
          <label for="templateId">Template ID *</label>
          <input type="text" id="templateId" required placeholder="abc123def456">
        </div>
        
        <div class="form-group">
          <label for="gpuIds">GPU IDs (comma-separated)</label>
          <input type="text" id="gpuIds" placeholder="NVIDIA GeForce RTX 4090">
        </div>
        
        <div class="form-group">
          <label for="workersMin">Min Workers</label>
          <input type="number" id="workersMin" value="0" min="0" max="10">
        </div>
        
        <div class="form-group">
          <label for="workersMax">Max Workers</label>
          <input type="number" id="workersMax" value="3" min="1" max="100">
        </div>
        
        <div class="modal-actions">
          <button type="button" class="btn" onclick="app.closeModal()">Cancel</button>
          <button type="submit" class="btn primary">Create Endpoint</button>
        </div>
      </form>
    `;

    document.getElementById('modalTitle').textContent = 'Create Serverless Endpoint';
    document.getElementById('modalOverlay').classList.add('active');
  }

  async createEndpoint(event) {
    event.preventDefault();

    const gpuIdsStr = document.getElementById('gpuIds').value;
    const gpuIds = gpuIdsStr ? gpuIdsStr.split(',').map(s => s.trim()) : [];

    const data = {
      name: document.getElementById('endpointName').value,
      templateId: document.getElementById('templateId').value,
      gpuIds,
      workersMin: parseInt(document.getElementById('workersMin').value) || 0,
      workersMax: parseInt(document.getElementById('workersMax').value) || 3
    };

    try {
      await this.api('POST', '/endpoints', data);
      this.showToast('Endpoint Created', 'Your serverless endpoint is ready', 'success');
      this.closeModal();
      await this.loadEndpoints();
    } catch (error) {
      this.showToast('Error', error.message, 'error');
    }
  }

  // ==================== Jobs ====================
  async loadJobs() {
    try {
      const status = document.getElementById('jobStatusFilter')?.value || '';
      const path = status ? `/jobs?status=${status}` : '/jobs';
      this.jobs = await this.api('GET', path);
      this.renderJobs();
      this.updateJobStats();
    } catch (error) {
      console.error('Error loading jobs:', error);
    }
  }

  filterJobs() {
    this.loadJobs();
  }

  renderJobs() {
    const tbody = document.getElementById('jobsTableBody');

    if (this.jobs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="loading-cell">No jobs found</td></tr>`;
      return;
    }

    tbody.innerHTML = this.jobs.map(job => `
      <tr>
        <td title="${job.id}">${job.id.slice(0, 8)}...</td>
        <td><span class="job-status ${job.status.toLowerCase()}">${job.status}</span></td>
        <td>${job.endpoint_id ? job.endpoint_id.slice(0, 8) + '...' : 'N/A'}</td>
        <td>${job.duration_ms ? this.formatDuration(job.duration_ms / 1000) : '-'}</td>
        <td>${job.cost_usd ? '$' + job.cost_usd.toFixed(4) : '-'}</td>
        <td>${this.formatDate(job.created_at)}</td>
        <td>
          ${job.status === 'PENDING' || job.status === 'RUNNING' ?
        `<button class="btn sm danger" onclick="app.cancelJob('${job.id}')">Cancel</button>` :
        job.status === 'COMPLETED' ?
          `<button class="btn sm" onclick="app.viewJobResult('${job.id}')">View</button>` :
          ''
      }
        </td>
      </tr>
    `).join('');
  }

  updateJobStats() {
    const stats = {
      pending: this.jobs.filter(j => j.status === 'PENDING').length,
      running: this.jobs.filter(j => j.status === 'RUNNING' || j.status === 'IN_QUEUE').length,
      completed: this.jobs.filter(j => j.status === 'COMPLETED').length,
      failed: this.jobs.filter(j => j.status === 'FAILED').length
    };

    document.getElementById('jobsPending').textContent = stats.pending;
    document.getElementById('jobsRunning').textContent = stats.running;
    document.getElementById('jobsCompleted').textContent = stats.completed;
    document.getElementById('jobsFailed').textContent = stats.failed;
    document.getElementById('queuedJobs').textContent = stats.pending + stats.running;
  }

  async cancelJob(jobId) {
    try {
      await this.api('POST', `/jobs/${jobId}/cancel`);
      this.showToast('Job Cancelled', 'The job has been cancelled', 'success');
      await this.loadJobs();
    } catch (error) {
      this.showToast('Error', error.message, 'error');
    }
  }

  viewJobResult(jobId) {
    const job = this.jobs.find(j => j.id === jobId);
    if (!job) return;

    const modalBody = document.getElementById('modalBody');
    modalBody.innerHTML = `
      <div class="job-details">
        <div class="form-group">
          <label>Job ID</label>
          <input type="text" readonly value="${job.id}">
        </div>
        <div class="form-group">
          <label>Status</label>
          <span class="job-status ${job.status.toLowerCase()}">${job.status}</span>
        </div>
        <div class="form-group">
          <label>Duration</label>
          <span>${job.duration_ms ? this.formatDuration(job.duration_ms / 1000) : 'N/A'}</span>
        </div>
        <div class="form-group">
          <label>Input</label>
          <pre style="background: var(--bg-glass); padding: 1rem; border-radius: 8px; overflow: auto; max-height: 150px;">
${JSON.stringify(job.input, null, 2)}
          </pre>
        </div>
        <div class="form-group">
          <label>Output</label>
          <pre style="background: var(--bg-glass); padding: 1rem; border-radius: 8px; overflow: auto; max-height: 200px;">
${JSON.stringify(job.output, null, 2)}
          </pre>
        </div>
      </div>
    `;

    document.getElementById('modalTitle').textContent = 'Job Details';
    document.getElementById('modalOverlay').classList.add('active');
  }

  showCreateJobModal(endpointId = '') {
    const modalBody = document.getElementById('modalBody');

    const endpointOptions = this.endpoints.map(ep =>
      `<option value="${ep.id}" ${ep.id === endpointId ? 'selected' : ''}>${this.escapeHtml(ep.name)}</option>`
    ).join('');

    modalBody.innerHTML = `
      <form class="modal-form" onsubmit="app.submitJob(event)">
        <div class="form-group">
          <label for="jobEndpoint">Endpoint *</label>
          <select id="jobEndpoint" required>
            <option value="">Select an endpoint</option>
            ${endpointOptions}
          </select>
        </div>
        
        <div class="form-group">
          <label for="jobInput">Input JSON *</label>
          <textarea id="jobInput" required rows="8" placeholder='{"prompt": "A beautiful sunset"}'>{
  "prompt": "A beautiful sunset over the ocean"
}</textarea>
        </div>
        
        <div class="form-group">
          <label>
            <input type="checkbox" id="skipDedup"> Skip deduplication
          </label>
        </div>
        
        <div class="modal-actions">
          <button type="button" class="btn" onclick="app.closeModal()">Cancel</button>
          <button type="submit" class="btn primary">Submit Job</button>
        </div>
      </form>
    `;

    document.getElementById('modalTitle').textContent = 'Submit New Job';
    document.getElementById('modalOverlay').classList.add('active');
  }

  showSubmitJobModal(endpointId) {
    this.showCreateJobModal(endpointId);
  }

  async submitJob(event) {
    event.preventDefault();

    let input;
    try {
      input = JSON.parse(document.getElementById('jobInput').value);
    } catch (e) {
      this.showToast('Invalid JSON', 'Please enter valid JSON input', 'error');
      return;
    }

    const data = {
      endpointId: document.getElementById('jobEndpoint').value,
      input,
      options: {
        skipDeduplication: document.getElementById('skipDedup').checked
      }
    };

    try {
      const result = await this.api('POST', '/jobs', data);
      if (result.deduplicated) {
        this.showToast('Duplicate Job', 'Job with identical input already exists', 'warning');
      } else {
        this.showToast('Job Submitted', 'Job has been added to the queue', 'success');
      }
      this.closeModal();
      await this.loadJobs();
    } catch (error) {
      this.showToast('Error', error.message, 'error');
    }
  }

  async showDeadLetterQueue() {
    try {
      const dlq = await this.api('GET', '/dlq');

      const modalBody = document.getElementById('modalBody');

      if (dlq.length === 0) {
        modalBody.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">✅</div>
            <p>No failed jobs in the dead letter queue</p>
          </div>
        `;
      } else {
        modalBody.innerHTML = `
          <p style="margin-bottom: 1rem; color: var(--text-secondary);">
            These jobs failed after multiple retry attempts.
          </p>
          <div class="dlq-list">
            ${dlq.map(job => `
              <div class="card" style="margin-bottom: 1rem;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                  <strong>${job.id.slice(0, 16)}...</strong>
                  <span style="color: var(--error);">${job.attempts} attempts</span>
                </div>
                <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.75rem;">
                  ${this.escapeHtml(job.error)}
                </p>
                <button class="btn sm primary" onclick="app.retryDeadLetter('${job.id}')">
                  🔄 Retry
                </button>
              </div>
            `).join('')}
          </div>
        `;
      }

      document.getElementById('modalTitle').textContent = 'Dead Letter Queue';
      document.getElementById('modalOverlay').classList.add('active');
    } catch (error) {
      this.showToast('Error', error.message, 'error');
    }
  }

  async retryDeadLetter(dlqId) {
    try {
      await this.api('POST', `/dlq/${dlqId}/retry`);
      this.showToast('Job Requeued', 'The job has been added back to the queue', 'success');
      this.closeModal();
      await this.loadJobs();
    } catch (error) {
      this.showToast('Error', error.message, 'error');
    }
  }

  // ==================== Costs ====================
  async loadCosts() {
    try {
      const costs = await this.api('GET', '/costs');

      // Update dashboard budget
      document.getElementById('dailyBudgetText').textContent =
        `$${costs.today.spent.toFixed(2)} / $${costs.today.limit}`;
      document.getElementById('monthlyBudgetText').textContent =
        `$${costs.month.spent.toFixed(2)} / $${costs.month.limit}`;

      const dailyProgress = document.getElementById('dailyProgress');
      dailyProgress.style.width = `${Math.min(costs.today.percentUsed, 100)}%`;
      if (costs.today.percentUsed >= 80) dailyProgress.classList.add('warning');

      const monthlyProgress = document.getElementById('monthlyProgress');
      monthlyProgress.style.width = `${Math.min(costs.month.percentUsed, 100)}%`;
      if (costs.month.percentUsed >= 80) monthlyProgress.classList.add('warning');

      // Alerts
      const alertsContainer = document.getElementById('budgetAlerts');
      alertsContainer.innerHTML = costs.alerts.map(a =>
        `<div class="alert ${a.level}">${a.message}</div>`
      ).join('');

      // Cost cards
      document.getElementById('todaySpend').textContent = `$${costs.today.spent.toFixed(2)}`;
      document.getElementById('costToday').textContent = `$${costs.today.spent.toFixed(2)}`;
      document.getElementById('costMonth').textContent = `$${costs.month.spent.toFixed(2)}`;
      document.getElementById('limitToday').textContent = `$${costs.today.limit}`;
      document.getElementById('limitMonth').textContent = `$${costs.month.limit}`;

      // Load history for chart
      await this.loadCostHistory();

    } catch (error) {
      console.error('Error loading costs:', error);
    }
  }

  async loadCostHistory() {
    try {
      const history = await this.api('GET', '/costs/history?days=7');

      const chartContainer = document.getElementById('costChart');

      if (history.length === 0) {
        chartContainer.innerHTML = '<div class="chart-placeholder">Aún no hay datos de coste</div>';
        return;
      }

      const maxCost = Math.max(...history.map(h => h.total), 1);
      const todayStr = new Date().toISOString().slice(0, 10);

      chartContainer.innerHTML = `
        <div style="display: flex; align-items: flex-end; gap: 0.5rem; height: 200px; width: 100%;">
          ${history.reverse().map(day => {
        const height = (day.total / maxCost) * 100;
        const isToday = day.date === todayStr;
        return `
              <div class="chart-bar-wrapper">
                <div class="chart-bar ${isToday ? 'today' : ''}" style="height: ${height}%; background: var(--accent-gradient);"></div>
                <div class="chart-date">${day.date.slice(5)}</div>
                <div class="chart-amount">$${day.total.toFixed(2)}</div>
              </div>
            `;
      }).join('')}
        </div>
      `;

      // Calculate week total
      const weekTotal = history.reduce((sum, day) => sum + day.total, 0);
      document.getElementById('costWeek').textContent = `$${weekTotal.toFixed(2)}`;

    } catch (error) {
      console.error('Error loading cost history:', error);
    }
  }

  async saveBudgetSettings() {
    const dailyLimit = parseFloat(document.getElementById('dailyLimit').value);
    const monthlyLimit = parseFloat(document.getElementById('monthlyLimit').value);

    try {
      await this.api('POST', '/config', { key: 'budgetLimitDaily', value: dailyLimit });
      await this.api('POST', '/config', { key: 'budgetLimitMonthly', value: monthlyLimit });
      this.showToast('Settings Saved', 'Budget limits have been updated', 'success');
      await this.loadCosts();
    } catch (error) {
      this.showToast('Error', error.message, 'error');
    }
  }

  exportCosts() {
    this.showToast('Export', 'Cost export feature coming soon', 'info');
  }

  // ==================== Benchmarks ====================
  async loadBenchmarks() {
    try {
      this.benchmarks = await this.api('GET', '/benchmarks');
      this.renderBenchmarks();
    } catch (error) {
      console.error('Error loading benchmarks:', error);
    }
  }

  renderBenchmarks(tier = 'all') {
    const table = document.getElementById('benchmarkTable');

    let filtered = this.benchmarks;
    if (tier !== 'all') {
      filtered = this.benchmarks.filter(b => b.tier === tier);
    }

    table.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>GPU</th>
            <th>VRAM</th>
            <th>Cost/100 imgs</th>
            <th>Latency</th>
            <th>Cold Start</th>
            <th>Tier</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(b => `
            <tr>
              <td>${b.gpuId}</td>
              <td>${b.vram} GB</td>
              <td>$${b.costPer100Images.toFixed(2)}</td>
              <td>${(b.avgLatencyMs / 1000).toFixed(1)}s</td>
              <td>${(b.coldStartMs / 1000).toFixed(1)}s</td>
              <td><span class="tier-badge ${b.tier}">${b.tier}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  filterBenchmarks(tier) {
    this.renderBenchmarks(tier);
  }

  // ==================== Auto-Shutdown ====================
  async loadAutoShutdownStatus() {
    try {
      const status = await this.api('GET', '/auto-shutdown');
      document.getElementById('autoShutdownToggle').checked = status.enabled;
      document.getElementById('idleMinutes').textContent = status.idleThresholdMinutes;

      const logsContainer = document.getElementById('shutdownLogs');
      if (status.recentShutdowns.length > 0) {
        logsContainer.innerHTML = status.recentShutdowns.map(log =>
          `<div class="shutdown-log">⏰ ${log.podName} - ${this.formatDate(log.timestamp)}</div>`
        ).join('');
      }
    } catch (error) {
      console.error('Error loading auto-shutdown status:', error);
    }
  }

  async toggleAutoShutdown(enabled) {
    try {
      await this.api('POST', '/auto-shutdown/toggle', { enabled });
      this.showToast(
        enabled ? 'Auto-Shutdown Enabled' : 'Auto-Shutdown Disabled',
        enabled ? 'Idle pods will be automatically stopped' : 'Pods will run until manually stopped',
        'success'
      );
    } catch (error) {
      this.showToast('Error', error.message, 'error');
    }
  }

  // ==================== Stats ====================
  updateStats() {
    document.getElementById('activePods').textContent =
      this.pods.filter(p => p.desiredStatus === 'RUNNING').length;
    document.getElementById('activeEndpoints').textContent = this.endpoints.length;
  }

  // ==================== Activity ====================
  addActivity(icon, text) {
    this.activity.unshift({
      icon,
      text,
      time: new Date()
    });

    // Keep only last 20 items
    this.activity = this.activity.slice(0, 20);

    this.renderActivity();
  }

  renderActivity() {
    const list = document.getElementById('activityList');

    if (this.activity.length === 0) {
      list.innerHTML = '<div class="activity-empty">No recent activity</div>';
      return;
    }

    list.innerHTML = this.activity.map(a => `
      <div class="activity-item">
        <span class="activity-icon">${a.icon}</span>
        <div class="activity-content">
          <div class="activity-text">${this.escapeHtml(a.text)}</div>
          <div class="activity-time">${this.formatTime(a.time)}</div>
        </div>
      </div>
    `).join('');
  }

  // ==================== Modal ====================
  closeModal() {
    document.getElementById('modalOverlay').classList.remove('active');
  }

  // ==================== Toast ====================
  showToast(title, message, type = 'info') {
    const container = document.getElementById('toastContainer');

    const icons = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️'
    };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <span class="toast-icon">${icons[type]}</span>
      <div class="toast-content">
        <div class="toast-title">${this.escapeHtml(title)}</div>
        <div class="toast-message">${this.escapeHtml(message)}</div>
      </div>
      <button class="toast-close" onclick="this.parentElement.remove()">✕</button>
      <div class="toast-progress">
        <div class="toast-progress-bar"></div>
      </div>
    `;

    container.appendChild(toast);

    // Remove after 5 seconds
    setTimeout(() => {
      toast.style.animation = 'toastSlide 0.3s ease reverse';
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }

  // ==================== Utilities ====================
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  formatDuration(seconds) {
    if (!seconds || seconds < 0) return '0s';

    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) return `${hours}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }

  formatDate(dateStr) {
    if (!dateStr) return 'N/A';
    const date = new Date(dateStr);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  formatTime(date) {
    const now = new Date();
    const diff = (now - date) / 1000;

    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return date.toLocaleDateString();
  }

  getStatusClass(status) {
    const map = {
      'RUNNING': 'running',
      'STOPPED': 'stopped',
      'EXITED': 'exited',
      'CREATED': 'deploying',
      'DEPLOYING': 'deploying',
      'TERMINATED': 'exited'
    };
    return map[status] || 'stopped';
  }

  // ==================== Image Generation ====================
  selectedPod = null;
  selectedEndpoint = null;
  generationSource = 'endpoint'; // 'endpoint' or 'pod'
  generatedImages = [];

  async refreshGenerateOptions() {
    await Promise.all([this.loadPods(), this.loadEndpoints(), this.loadWorkflows()]);
    this.updateGeneratePodSelect();
    this.updateGenerateEndpointSelect();
  }

  // ==================== Workflow Management ====================
  async loadWorkflows() {
    try {
      this.workflows = await this.api('GET', '/workflows');
      this.updateWorkflowSelect();
    } catch (error) {
      console.error('Error loading workflows:', error);
    }
  }

  updateWorkflowSelect() {
    const select = document.getElementById('workflowSelect');
    if (!select) return;

    select.innerHTML = this.workflows.map(wf => `
      <option value="${wf.id}" ${wf.id === this.selectedWorkflowId ? 'selected' : ''}>
        ${this.escapeHtml(wf.name)}
      </option>
    `).join('');
  }

  onWorkflowChange(workflowId) {
    this.selectedWorkflowId = workflowId;
    const wf = this.workflows.find(w => w.id === workflowId);

    // Update description
    const descEl = document.getElementById('workflowDescription');
    if (descEl && wf) descEl.textContent = wf.description;

    // Show/hide video fields
    const isVideo = wf?.category === 'video' || wf?.hasVideo;
    document.querySelectorAll('.video-only-field').forEach(el => {
      el.style.display = isVideo ? 'block' : 'none';
    });
    const batchGroup = document.getElementById('batchSizeGroup');
    if (batchGroup) batchGroup.style.display = isVideo ? 'none' : '';

    // Update generate button label
    const btn = document.getElementById('generateBtn');
    if (btn) {
      btn.innerHTML = isVideo ? '🎬 Generate Video' : '🎨 Generate Image';
    }

    this.updatePayloadPreview();
  }

  switchGenerateSource(source) {
    this.generationSource = source;

    // Update tabs
    document.querySelectorAll('.source-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.source === source);
    });

    // Show/hide panels
    document.getElementById('endpointSourcePanel').style.display = source === 'endpoint' ? 'block' : 'none';
    document.getElementById('podSourcePanel').style.display = source === 'pod' ? 'block' : 'none';

    // Reset selection
    this.selectedPod = null;
    this.selectedEndpoint = null;
    document.getElementById('generateInterface').style.display = 'none';
    document.getElementById('noSourceSelected').style.display = 'flex';
  }

  updateGenerateEndpointSelect() {
    const select = document.getElementById('generateEndpointSelect');
    if (!select) return;

    select.innerHTML = `
      <option value="">-- Select an endpoint (${this.endpoints.length} available) --</option>
      ${this.endpoints.map(ep => `
        <option value="${ep.id}">${this.escapeHtml(ep.name)} (Workers: ${ep.workersMin}-${ep.workersMax})</option>
      `).join('')}
    `;
  }

  updateGeneratePodSelect() {
    const select = document.getElementById('generatePodSelect');
    if (!select) return;

    const runningPods = this.pods.filter(p => p.desiredStatus === 'RUNNING');

    select.innerHTML = `
      <option value="">-- Select a running pod (${runningPods.length} available) --</option>
      ${runningPods.map(p => `
        <option value="${p.id}">${this.escapeHtml(p.name)} - ${p.machine?.gpuDisplayName || 'GPU'}</option>
      `).join('')}
    `;
  }

  async selectEndpointForGeneration(endpointId) {
    const statusEl = document.getElementById('endpointConnectionStatus');
    const interfaceEl = document.getElementById('generateInterface');
    const noSourceEl = document.getElementById('noSourceSelected');

    if (!endpointId) {
      this.selectedEndpoint = null;
      interfaceEl.style.display = 'none';
      noSourceEl.style.display = 'flex';
      statusEl.innerHTML = '';
      return;
    }

    statusEl.className = 'pod-connection-status connecting';
    statusEl.innerHTML = '🔄 Checking endpoint...';

    try {
      const endpoint = this.endpoints.find(ep => ep.id === endpointId);
      if (!endpoint) throw new Error('Endpoint not found');

      // Check endpoint health
      const health = await this.api('GET', `/endpoints/${endpointId}/health`);

      this.selectedEndpoint = { ...endpoint, health };

      statusEl.className = 'pod-connection-status connected';
      statusEl.innerHTML = `✅ Ready: <strong>${this.escapeHtml(endpoint.name)}</strong> (Workers: ${health.workers?.idle || 0} idle, ${health.workers?.running || 0} running)`;

      interfaceEl.style.display = 'grid';
      noSourceEl.style.display = 'none';

    } catch (error) {
      statusEl.className = 'pod-connection-status error';
      statusEl.innerHTML = `❌ Error: ${error.message}`;
      interfaceEl.style.display = 'none';
      noSourceEl.style.display = 'flex';
    }
  }

  async selectPodForGeneration(podId) {
    const statusEl = document.getElementById('podConnectionStatus');
    const interfaceEl = document.getElementById('generateInterface');
    const noSourceEl = document.getElementById('noSourceSelected');

    if (!podId) {
      this.selectedPod = null;
      interfaceEl.style.display = 'none';
      noSourceEl.style.display = 'flex';
      statusEl.innerHTML = '';
      return;
    }

    statusEl.className = 'pod-connection-status connecting';
    statusEl.innerHTML = '🔄 Connecting to pod...';

    try {
      const pod = await this.api('GET', `/pods/${podId}`);
      this.selectedPod = pod;

      if (pod.runtime && pod.runtime.ports) {
        const httpPort = pod.runtime.ports.find(p => p.privatePort === 8188 || p.privatePort === 3000);
        if (httpPort && httpPort.ip) {
          this.selectedPod.comfyUrl = `http://${httpPort.ip}:${httpPort.publicPort}`;
        }
      }

      statusEl.className = 'pod-connection-status connected';
      statusEl.innerHTML = `✅ Connected to <strong>${this.escapeHtml(pod.name)}</strong> (${pod.machine?.gpuDisplayName || 'GPU'})`;

      interfaceEl.style.display = 'grid';
      noSourceEl.style.display = 'none';

    } catch (error) {
      statusEl.className = 'pod-connection-status error';
      statusEl.innerHTML = `❌ Error: ${error.message}`;
      interfaceEl.style.display = 'none';
      noSourceEl.style.display = 'flex';
    }
  }

  async generateImage(event) {
    event.preventDefault();

    // Check if we have a source selected
    if (this.generationSource === 'endpoint' && !this.selectedEndpoint) {
      this.showToast('No Endpoint Selected', 'Please select an endpoint first', 'error');
      return;
    }
    if (this.generationSource === 'pod' && !this.selectedPod) {
      this.showToast('No Pod Selected', 'Please select a running pod first', 'error');
      return;
    }

    const btn = document.getElementById('generateBtn');
    const wf = this.workflows.find(w => w.id === this.selectedWorkflowId);
    const isVideo = wf?.category === 'video' || wf?.hasVideo;

    btn.disabled = true;
    btn.classList.add('loading');
    btn.innerHTML = isVideo ? '🔄 Generating Video...' : '🔄 Generating...';

    const params = {
      prompt: document.getElementById('promptInput').value,
      negative_prompt: document.getElementById('negativePrompt')?.value || '',
      width: parseInt(document.getElementById('genWidth').value),
      height: parseInt(document.getElementById('genHeight').value),
      steps: parseInt(document.getElementById('genSteps').value),
      cfg_scale: parseFloat(document.getElementById('genCfg').value),
      sampler: document.getElementById('genSampler').value,
      batch_size: parseInt(document.getElementById('genBatch').value),
      workflowId: this.selectedWorkflowId
    };

    // Add video-specific params
    if (isVideo) {
      params.frames = parseInt(document.getElementById('genFrames')?.value || 16);
      params.fps = parseInt(document.getElementById('genFps')?.value || 8);
    }

    try {
      let result;

      if (this.generationSource === 'endpoint') {
        result = await this.api('POST', `/endpoints/${this.selectedEndpoint.id}/generate`, params);
      } else {
        result = await this.api('POST', `/pods/${this.selectedPod.id}/generate`, params);
      }

      // Handle GIF/video results
      if (result.gifs && result.gifs.length > 0) {
        this.generatedVideos = [...result.gifs, ...this.generatedVideos];
        this.renderGeneratedVideos();
        this.showToast('Video Generated!', `${result.gifs.length} video(s) created`, 'success');
      }

      // Handle image results
      if (result.images && result.images.length > 0) {
        this.generatedImages = [...result.images, ...this.generatedImages];
        this.renderGeneratedImages();
        this.showToast('Images Generated!', `${result.images.length} image(s) created`, 'success');
      } else if (result.output) {
        const images = Array.isArray(result.output) ? result.output : [result.output];
        this.generatedImages = [...images.map(img => ({ url: img })), ...this.generatedImages];
        this.renderGeneratedImages();
        this.showToast('Images Generated!', `${images.length} image(s) created`, 'success');
      }

      if ((!result.images || result.images.length === 0) && (!result.gifs || result.gifs.length === 0) && !result.output) {
        this.showToast('Generation Complete', 'Check the output for results', 'info');
      }
    } catch (error) {
      this.showToast('Generation Failed', error.message, 'error');
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.innerHTML = isVideo ? '🎬 Generate Video' : '🎨 Generate Image';
    }
  }

  renderGeneratedImages() {
    const container = document.getElementById('generatedImages');

    if (this.generatedImages.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🎨</div>
          <p class="empty-state-text">Generated media will appear here</p>
        </div>
      `;
      return;
    }

    container.innerHTML = this.generatedImages.map((img, i) => `
      <div class="generated-image" onclick="app.viewImage('${img.url || img}')">
        <img src="${img.url || img}" alt="Generated image ${i + 1}" loading="lazy">
        <div class="generated-image-overlay">
          <button onclick="event.stopPropagation(); app.downloadImage('${img.url || img}', 'image_${i}.png')">💾</button>
          <button onclick="event.stopPropagation(); app.viewImage('${img.url || img}')">🔍</button>
        </div>
      </div>
    `).join('');
  }

  renderGeneratedVideos() {
    const container = document.getElementById('generatedVideos');
    const gallery = document.getElementById('videoGallery');
    if (!container || !gallery) return;

    if (this.generatedVideos.length === 0) {
      container.style.display = 'none';
      return;
    }

    container.style.display = 'block';
    gallery.innerHTML = this.generatedVideos.map((gif, i) => `
      <div class="generated-video-item">
        <img src="${gif.url || gif}" alt="Generated GIF ${i + 1}" loading="lazy">
        <div class="generated-image-overlay">
          <button onclick="app.downloadImage('${gif.url || gif}', 'video_${i}.gif')">💾</button>
          <button onclick="window.open('${gif.url || gif}', '_blank')">🔗</button>
        </div>
      </div>
    `).join('');
  }

  // ==================== Batch Processing ====================
  async startBatch() {
    const textarea = document.getElementById('batchPrompts');
    const promptsText = textarea?.value?.trim();
    if (!promptsText) {
      this.showToast('No Prompts', 'Escribe al menos un prompt para batch', 'error');
      return;
    }

    if (this.generationSource === 'pod' && !this.selectedPod) {
      this.showToast('No Pod Selected', 'Selecciona un pod primero', 'error');
      return;
    }

    if (this.generationSource === 'endpoint') {
      this.showToast('Not Supported', 'Batch processing solo funciona con pods (por ahora)', 'error');
      return;
    }

    const prompts = promptsText.split('\n').filter(p => p.trim());
    if (prompts.length === 0) return;

    const btn = document.getElementById('batchBtn');
    btn.disabled = true;
    btn.innerHTML = '⏳ Procesando...';

    // Show progress bar
    this.showBatchProgress(0, prompts.length, '');

    try {
      const params = {
        steps: parseInt(document.getElementById('genSteps')?.value || 20),
        cfg_scale: parseFloat(document.getElementById('genCfg')?.value || 7),
        width: parseInt(document.getElementById('genWidth')?.value || 1024),
        height: parseInt(document.getElementById('genHeight')?.value || 1024),
        sampler: document.getElementById('genSampler')?.value || 'euler',
        negative_prompt: document.getElementById('negativePrompt')?.value || ''
      };

      await this.api('POST', `/pods/${this.selectedPod.id}/batch`, {
        prompts,
        workflowId: this.selectedWorkflowId,
        params
      });

      this.showToast('Batch Iniciado', `${prompts.length} prompts en cola. Progreso via WebSocket.`, 'info');
    } catch (error) {
      this.showToast('Batch Error', error.message, 'error');
      this.hideBatchProgress();
    } finally {
      btn.disabled = false;
      btn.innerHTML = '🚀 Lanzar Batch';
    }
  }

  showBatchProgress(current, total, promptText) {
    const el = document.getElementById('batchProgress');
    if (!el) return;
    el.style.display = 'block';

    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    document.getElementById('batchProgressText').textContent = `Procesando ${current}/${total}...`;
    document.getElementById('batchProgressPercent').textContent = `${pct}%`;
    document.getElementById('batchProgressBar').style.width = `${pct}%`;
    document.getElementById('batchCurrentPrompt').textContent = promptText;
  }

  hideBatchProgress() {
    const el = document.getElementById('batchProgress');
    if (el) el.style.display = 'none';
  }

  handleBatchProgress(data) {
    this.showBatchProgress(data.current, data.total, data.prompt);
  }

  handleBatchComplete(data) {
    this.hideBatchProgress();
    this.showToast('Batch Completado',
      `✅ ${data.completed} completados, ❌ ${data.failed} fallidos de ${data.total}`,
      data.failed > 0 ? 'warning' : 'success');

    // Add results to gallery
    if (data.results) {
      for (const r of data.results) {
        if (r.images) this.generatedImages = [...r.images, ...this.generatedImages];
        if (r.gifs) this.generatedVideos = [...r.gifs, ...this.generatedVideos];
      }
      this.renderGeneratedImages();
      this.renderGeneratedVideos();
    }
  }

  viewImage(url) {
    const modalBody = document.getElementById('modalBody');
    modalBody.innerHTML = `
      <div style="text-align: center;">
        <img src="${url}" style="max-width: 100%; max-height: 70vh; border-radius: 8px;" alt="Generated image">
        <div style="margin-top: 1rem;">
          <button class="btn primary" onclick="app.downloadImage('${url}', 'generated_image.png')">
            💾 Download
          </button>
        </div>
      </div>
    `;
    document.getElementById('modalTitle').textContent = 'Generated Image';
    document.getElementById('modalOverlay').classList.add('active');
  }

  downloadImage(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.target = '_blank';
    a.click();
  }

  // ==================== Workspace Backup ====================
  async backupPodWorkspace(podId) {
    // Find the pod
    const pod = this.pods.find(p => p.id === podId);
    if (!pod) {
      this.showToast('Error', 'Pod no encontrado', 'error');
      return;
    }

    if (pod.desiredStatus !== 'RUNNING') {
      this.showToast('Error', 'El pod debe estar en ejecución para hacer backup', 'error');
      return;
    }

    // Find the backup button and show loading state
    const btns = document.querySelectorAll('.btn-backup');
    let targetBtn = null;
    btns.forEach(btn => {
      if (btn.onclick && btn.getAttribute('onclick')?.includes(podId)) {
        targetBtn = btn;
      }
    });
    if (targetBtn) {
      targetBtn.disabled = true;
      targetBtn.classList.add('loading');
      targetBtn.textContent = '⏳';
    }

    try {
      this.showToast('📦 Backup en progreso', 'Comprimiendo archivos del workspace...', 'info');

      const response = await fetch(`/api/pods/${podId}/backup`, {
        method: 'POST'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Error al crear backup');
      }

      // Download the ZIP
      const blob = await response.blob();
      if (blob.size < 100) {
        this.showToast('⚠️ Backup vacío', 'No se encontraron archivos de output en el workspace', 'warning');
        return;
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pod-backup-${podId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.showToast('✅ Backup completado', 'Los archivos se están descargando', 'success');
    } catch (error) {
      this.showToast('Error de Backup', error.message, 'error');
    } finally {
      if (targetBtn) {
        targetBtn.disabled = false;
        targetBtn.classList.remove('loading');
        targetBtn.textContent = '💾 Backup';
      }
    }
  }

  // ==================== Payload Preview ====================
  updatePayloadPreview() {
    const previewContent = document.getElementById('payloadPreviewContent');
    if (!previewContent) return;

    const params = {
      prompt: document.getElementById('promptInput')?.value || '',
      negative_prompt: document.getElementById('negativePrompt')?.value || '',
      width: parseInt(document.getElementById('genWidth')?.value) || 1024,
      height: parseInt(document.getElementById('genHeight')?.value) || 1024,
      steps: parseInt(document.getElementById('genSteps')?.value) || 20,
      cfg_scale: parseFloat(document.getElementById('genCfg')?.value) || 7,
      sampler: document.getElementById('genSampler')?.value || 'dpmpp_2m',
      batch_size: parseInt(document.getElementById('genBatch')?.value) || 1
    };

    previewContent.textContent = JSON.stringify(params, null, 2);
  }

  togglePayloadPreview() {
    const body = document.getElementById('payloadPreviewBody');
    const arrow = document.getElementById('payloadToggleArrow');
    if (!body || !arrow) return;

    body.classList.toggle('collapsed');
    arrow.textContent = body.classList.contains('collapsed') ? '▶' : '▼';
    this.updatePayloadPreview();
  }
}

// Initialize app
const app = new GPUOrchestrator();

// Close modal on overlay click
document.getElementById('modalOverlay')?.addEventListener('click', (e) => {
  if (e.target.id === 'modalOverlay') {
    app.closeModal();
  }
});

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    app.closeModal();
  }
});

// Update generate options when switching to generate tab
document.querySelector('[data-tab="generate"]')?.addEventListener('click', () => {
  app.refreshGenerateOptions();
});
