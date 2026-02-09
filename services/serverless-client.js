import { config } from '../config/env.js';

/**
 * RunPod Serverless Client for Endpoint Management
 */
class ServerlessClient {
    constructor() {
        this.baseUrl = config.runpodRestUrl;
        this.graphqlUrl = config.runpodGraphqlUrl;
        this.apiKey = config.runpodApiKey;
    }

    /**
     * Make an authenticated request to RunPod REST API
     */
    async request(method, url, body = null) {
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            }
        };

        if (body) {
            options.body = JSON.stringify(body);
        }

        const response = await fetch(url, options);
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || `Request failed with status ${response.status}`);
        }

        return data;
    }

    /**
     * Execute GraphQL query
     */
    async graphql(query, variables = {}) {
        const response = await fetch(this.graphqlUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({ query, variables })
        });

        const result = await response.json();
        if (result.errors) {
            throw new Error(result.errors[0].message);
        }
        return result.data;
    }

    /**
     * Get all serverless endpoints
     */
    async getEndpoints() {
        const query = `
      query myself {
        myself {
          endpoints {
            id
            name
            templateId
            gpuIds
            networkVolumeId
            idleTimeout
            scalerType
            scalerValue
            workersMin
            workersMax
            type
          }
        }
      }
    `;
        const data = await this.graphql(query);
        return data.myself?.endpoints || [];
    }

    /**
     * Create a serverless endpoint
     */
    async createEndpoint(options) {
        const {
            name,
            templateId,
            gpuIds,
            workersMin = 0,
            workersMax = 3,
            idleTimeout = 5,
            scalerType = 'QUEUE_DELAY',
            scalerValue = 4
        } = options;

        const mutation = `
      mutation saveEndpoint($input: EndpointInput!) {
        saveEndpoint(input: $input) {
          id
          name
          templateId
          gpuIds
          workersMin
          workersMax
        }
      }
    `;

        const input = {
            name,
            templateId,
            gpuIds,
            workersMin,
            workersMax,
            idleTimeout,
            scalerType,
            scalerValue
        };

        const data = await this.graphql(mutation, { input });
        return data.saveEndpoint;
    }

    /**
     * Delete an endpoint
     */
    async deleteEndpoint(endpointId) {
        const mutation = `
      mutation deleteEndpoint($id: String!) {
        deleteEndpoint(id: $id)
      }
    `;
        const data = await this.graphql(mutation, { id: endpointId });
        return data.deleteEndpoint;
    }

    /**
     * Run a job asynchronously (queue mode)
     */
    async runJob(endpointId, input, options = {}) {
        const { webhook, policy } = options;

        const body = { input };
        if (webhook) body.webhook = webhook;
        if (policy) body.policy = policy;

        return this.request(
            'POST',
            `${this.baseUrl}/${endpointId}/run`,
            body
        );
    }

    /**
     * Run a job synchronously (wait for result)
     */
    async runJobSync(endpointId, input, options = {}) {
        const { webhook, policy } = options;

        const body = { input };
        if (webhook) body.webhook = webhook;
        if (policy) body.policy = policy;

        return this.request(
            'POST',
            `${this.baseUrl}/${endpointId}/runsync`,
            body
        );
    }

    /**
     * Get job status
     */
    async getJobStatus(endpointId, jobId) {
        return this.request(
            'GET',
            `${this.baseUrl}/${endpointId}/status/${jobId}`
        );
    }

    /**
     * Cancel a job
     */
    async cancelJob(endpointId, jobId) {
        return this.request(
            'POST',
            `${this.baseUrl}/${endpointId}/cancel/${jobId}`
        );
    }

    /**
     * Stream job results (for streaming endpoints)
     */
    async streamJob(endpointId, jobId) {
        return this.request(
            'GET',
            `${this.baseUrl}/${endpointId}/stream/${jobId}`
        );
    }

    /**
     * Retry a failed job
     */
    async retryJob(endpointId, jobId) {
        return this.request(
            'POST',
            `${this.baseUrl}/${endpointId}/retry/${jobId}`
        );
    }

    /**
     * Purge all jobs in the queue
     */
    async purgeQueue(endpointId) {
        return this.request(
            'POST',
            `${this.baseUrl}/${endpointId}/purge-queue`
        );
    }

    /**
     * Get endpoint health
     */
    async getHealth(endpointId) {
        return this.request(
            'GET',
            `${this.baseUrl}/${endpointId}/health`
        );
    }
}

export const serverlessClient = new ServerlessClient();
export default ServerlessClient;
