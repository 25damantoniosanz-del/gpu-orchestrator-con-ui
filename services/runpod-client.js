import { config } from '../config/env.js';

/**
 * RunPod GraphQL Client for Pod Management
 */
class RunPodClient {
  constructor() {
    this.graphqlUrl = config.runpodGraphqlUrl;
    this.apiKey = config.runpodApiKey;
  }

  /**
   * Execute a GraphQL query/mutation
   */
  async query(queryString, variables = {}) {
    const response = await fetch(this.graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        query: queryString,
        variables
      })
    });

    const result = await response.json();

    if (result.errors) {
      throw new Error(result.errors[0].message);
    }

    return result.data;
  }

  /**
   * Get all available GPU types with pricing
   */
  async getGpuTypes() {
    const query = `
      query gpuTypes {
        gpuTypes {
          id
          displayName
          manufacturer
          memoryInGb
          secureCloud
          communityCloud
          securePrice
          communityPrice
        }
      }
    `;
    const data = await this.query(query);
    return data.gpuTypes || [];
  }

  /**
   * Get current user information and balance
   */
  async getMyself() {
    const query = `
      query myself {
        myself {
          id
          email
          clientBalance
        }
      }
    `;
    const data = await this.query(query);
    return data.myself;
  }

  /**
   * Get all pods for the current user
   */
  async getPods() {
    const query = `
      query myPods {
        myself {
          pods {
            id
            name
            podType
            imageName
            desiredStatus
            costPerHr
            uptimeSeconds
            gpuCount
            vcpuCount
            memoryInGb
            containerDiskInGb
            volumeInGb
            runtime {
              uptimeInSeconds
              gpus {
                id
                gpuUtilPercent
                memoryUtilPercent
              }
            }
            machine {
              gpuDisplayName
            }
          }
        }
      }
    `;
    const data = await this.query(query);
    return data.myself?.pods || [];
  }

  /**
   * Get a specific pod by ID
   */
  async getPod(podId) {
    const query = `
      query pod($podId: String!) {
        pod(input: { podId: $podId }) {
          id
          name
          podType
          imageName
          desiredStatus
          costPerHr
          uptimeSeconds
          gpuCount
          vcpuCount
          memoryInGb
          containerDiskInGb
          volumeInGb
          runtime {
            uptimeInSeconds
            ports {
              ip
              isIpPublic
              privatePort
              publicPort
              type
            }
            gpus {
              id
              gpuUtilPercent
              memoryUtilPercent
            }
          }
          machine {
            gpuDisplayName
          }
        }
      }
    `;
    const data = await this.query(query, { podId });
    return data.pod;
  }

  /**
   * Create and deploy a new pod (on-demand)
   */
  async createPod(options) {
    const {
      name,
      imageName,
      templateId,
      gpuTypeId,
      gpuCount = 1,
      volumeInGb = 20,
      containerDiskInGb = null,
      volumeMountPath = '/workspace',
      ports = '8888/http,8188/http,3000/http',
      cloudType = 'ALL',
      env = []
    } = options;

    const mutation = `
      mutation podFindAndDeployOnDemand($input: PodFindAndDeployOnDemandInput) {
        podFindAndDeployOnDemand(input: $input) {
          id
          name
          imageName
          desiredStatus
          costPerHr
          machine {
            gpuDisplayName
          }
        }
      }
    `;

    const input = {
      name,
      gpuTypeId,
      gpuCount,
      volumeInGb,
      volumeMountPath,
      ports,
      env,
      cloudType: cloudType || 'ALL',
      startSsh: true,
      supportPublicIp: true
    };

    // Use templateId if provided (for RunPod templates like HeartMuLa)
    if (templateId) {
      input.templateId = templateId;
    } else if (imageName) {
      input.imageName = imageName;
    }

    // Only add containerDiskInGb if it's a valid positive number
    if (containerDiskInGb && containerDiskInGb > 0) {
      input.containerDiskInGb = containerDiskInGb;
    }

    const data = await this.query(mutation, { input });
    return data.podFindAndDeployOnDemand;
  }

  /**
   * Create a spot/interruptable pod (cheaper but can be interrupted)
   */
  async createSpotPod(options) {
    const {
      name,
      imageName,
      gpuTypeId,
      gpuCount = 1,
      volumeInGb = 20,
      containerDiskInGb = 20,
      volumeMountPath = '/workspace',
      ports = '8888/http',
      bidPerGpu,
      env = []
    } = options;

    const mutation = `
      mutation podRentInterruptable($input: PodRentInterruptableInput!) {
        podRentInterruptable(input: $input) {
          id
          name
          imageName
          desiredStatus
          costPerHr
          podType
          machine {
            gpuDisplayName
          }
        }
      }
    `;

    const input = {
      name,
      imageName,
      gpuTypeId,
      gpuCount,
      volumeInGb,
      containerDiskInGb,
      volumeMountPath,
      ports,
      bidPerGpu,
      env,
      cloudType: 'ALL',
      startSsh: true,
      supportPublicIp: true
    };

    const data = await this.query(mutation, { input });
    return data.podRentInterruptable;
  }

  /**
   * Stop a pod (keeps data, stops billing for GPU)
   */
  async stopPod(podId) {
    const mutation = `
      mutation podStop($input: PodStopInput!) {
        podStop(input: $input) {
          id
          desiredStatus
        }
      }
    `;
    const data = await this.query(mutation, { input: { podId } });
    return data.podStop;
  }

  /**
   * Resume a stopped pod
   */
  async resumePod(podId, gpuCount = 1) {
    const mutation = `
      mutation podResume($input: PodResumeInput!) {
        podResume(input: $input) {
          id
          desiredStatus
          costPerHr
        }
      }
    `;
    const data = await this.query(mutation, { input: { podId, gpuCount } });
    return data.podResume;
  }

  /**
   * Terminate a pod (deletes it completely)
   */
  async terminatePod(podId) {
    const mutation = `
      mutation podTerminate($input: PodTerminateInput!) {
        podTerminate(input: $input)
      }
    `;
    const data = await this.query(mutation, { input: { podId } });
    return data.podTerminate;
  }

  /**
   * Get available templates
   */
  async getTemplates() {
    const query = `
      query myself {
        myself {
          podTemplates {
            id
            name
            imageName
            isPublic
          }
        }
      }
    `;
    const data = await this.query(query);
    return data.myself?.podTemplates || [];
  }
}

export const runpodClient = new RunPodClient();
export default RunPodClient;
