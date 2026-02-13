# 🚀 GPU Orchestrator - RunPod Control Panel

Panel de control centralizado para gestionar infraestructura GPU en RunPod, optimizado para generación masiva de imágenes y vídeo.

![Node.js](https://img.shields.io/badge/Node.js-18+-green)
![License](https://img.shields.io/badge/License-MIT-blue)

## ✨ Características

- **Gestión de Pods Multi-Tarea**: Soporte para **Image Gen (ComfyUI)** y **Music Gen (HeartMuLa)**
- **Panel de Conexión**: URLs dinámicas de acceso (ComfyUI, Gradio, Jupyter) con botones Copiar/Abrir
- **Protección de Costes**: Límites de gasto por pod (auto-kill) y presupuesto global
- **Endpoints Serverless**: Despliegue sin servidor con escalado automático
- **Sistema de Cola**: Deduplicación, rate limiting, reintentos con backoff exponencial
- **Auto-Shutdown**: Apagado automático de recursos inactivos
- **Benchmarks**: Comparativa de GPUs y filtrado por VRAM (16GB+ para música)
- **Interfaz Moderna**: Dark mode, glassmorphism, animaciones de estado, actualizaciones en tiempo real
- **Ayuda Integrada**: Guías paso a paso y glosario en la app

## 📋 Requisitos

- [Node.js](https://nodejs.org/) v18 o superior
- API Key de [RunPod](https://runpod.io/)

## 🚀 Instalación

1. **Clonar o descargar el repositorio**

2. **Instalar dependencias**
   ```bash
   npm install
   ```

3. **Configurar variables de entorno**
   
   Edita el archivo `.env` con tu API key de RunPod:
   ```env
   RUNPOD_API_KEY=tu_api_key_aqui
   BUDGET_LIMIT_DAILY=50
   BUDGET_LIMIT_MONTHLY=500
   AUTO_SHUTDOWN_MINUTES=30
   ```

4. **Iniciar el servidor**
   ```bash
   npm start
   ```

5. **Abrir en el navegador**
   ```
   http://localhost:3000
   ```

## 🎮 Uso

### Dashboard
- Vista general de pods activos, endpoints, trabajos en cola y gastos
- Estadísticas de presupuesto en tiempo real
- Acciones rápidas: crear pod, enviar trabajo, detener todo

### Pods
- **Crear Pod**: Selecciona template (ComfyUI, HeartMuLa, etc.), GPU y recursos
- **Gestionar**: Iniciar, detener o eliminar pods existentes
- **Panel de Conexión**: Cuando un pod está RUNNING, muestra URLs de acceso:
  - `🎨 ComfyUI` → Puerto 8188
  - `🎵 Gradio / HeartMuLa` → Puerto 7860
  - `📓 Jupyter Lab` → Puerto 8888
- Formato URL: `https://<POD_ID>-<PUERTO>.proxy.runpod.net`
- Botones de **Copiar URL** y **Abrir en nueva pestaña** por cada servicio

### Serverless
- Ideal para cargas de trabajo con picos
- Zero cost cuando no hay trabajos
- Escalado automático según demanda

### Jobs (Trabajos)
- Envía trabajos a endpoints serverless
- Deduplicación automática de trabajos idénticos
- Cola con prioridad y reintentos automáticos
- Dead Letter Queue para trabajos fallidos

### Costes
- Seguimiento de gastos en tiempo real
- Límites de presupuesto configurables
- Alertas cuando se acerca al límite

## 🔧 Configuración

| Variable | Descripción | Default |
|----------|-------------|---------|
| `RUNPOD_API_KEY` | Tu API key de RunPod | - |
| `PORT` | Puerto del servidor | 3000 |
| `BUDGET_LIMIT_DAILY` | Límite diario en USD | 50 |
| `BUDGET_LIMIT_MONTHLY` | Límite mensual en USD | 500 |
| `AUTO_SHUTDOWN_MINUTES` | Minutos de inactividad | 30 |
| `MAX_CONCURRENT_JOBS` | Trabajos simultáneos | 5 |
| `RATE_LIMIT_PER_SECOND` | Límite de rate | 2 |
| `MAX_RETRY_ATTEMPTS` | Reintentos máximos | 5 |

## 📁 Estructura del Proyecto

```
runpod-gpu-orchestrator/
├── server.js              # Servidor Express principal
├── package.json           # Dependencias
├── .env                   # Variables de entorno
├── config/
│   └── env.js             # Gestión de configuración
├── services/
│   ├── runpod-client.js   # Cliente GraphQL para pods
│   ├── serverless-client.js # Cliente REST para serverless
│   ├── queue-manager.js   # Gestor de cola de trabajos
│   ├── cost-tracker.js    # Seguimiento de costes
│   └── auto-shutdown.js   # Apagado automático
├── db/
│   └── database.js        # SQLite para persistencia
├── utils/
│   └── sanitizer.js       # Sanitización de inputs
└── public/
    ├── index.html         # Interfaz web
    ├── css/styles.css     # Estilos
    └── js/app.js          # Lógica frontend
```

## 🔒 Seguridad

- La API key se almacena únicamente en variables de entorno
- Todos los inputs son sanitizados antes de procesarse
- El frontend no tiene acceso directo a credenciales
- Límites de presupuesto para evitar gastos inesperados

## 📝 API Endpoints

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/gpus` | Lista de GPUs disponibles |
| GET | `/api/pods` | Lista de pods |
| POST | `/api/pods` | Crear nuevo pod |
| POST | `/api/pods/:id/stop` | Detener pod |
| DELETE | `/api/pods/:id` | Eliminar pod |
| GET | `/api/endpoints` | Lista de endpoints |
| POST | `/api/jobs` | Enviar trabajo |
| GET | `/api/jobs` | Lista de trabajos |
| GET | `/api/costs` | Resumen de costes |

## 🤝 Contribuir

1. Fork el repositorio
2. Crea una rama (`git checkout -b feature/nueva-funcionalidad`)
3. Commit tus cambios (`git commit -am 'Add nueva funcionalidad'`)
4. Push a la rama (`git push origin feature/nueva-funcionalidad`)
5. Abre un Pull Request

## 📄 Licencia

MIT License - ver [LICENSE](LICENSE) para más detalles.

## 🙏 Agradecimientos

- [RunPod](https://runpod.io/) por su excelente API
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) por el frontend de Stable Diffusion
