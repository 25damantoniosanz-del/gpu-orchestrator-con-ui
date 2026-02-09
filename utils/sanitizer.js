/**
 * Input sanitization utilities
 */

// Banned patterns that could indicate malicious input
const BANNED_PATTERNS = [
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i,
    /eval\s*\(/i,
    /document\./i,
    /window\./i,
    /\$\{/,
    /`.*`/
];

// Maximum lengths for different field types
const MAX_LENGTHS = {
    name: 100,
    prompt: 10000,
    imageName: 500,
    default: 1000
};

/**
 * Check if a string contains banned patterns
 */
function containsBannedPatterns(str) {
    if (typeof str !== 'string') return false;
    return BANNED_PATTERNS.some(pattern => pattern.test(str));
}

/**
 * Sanitize a string value
 */
function sanitizeString(value, fieldName = 'default') {
    if (typeof value !== 'string') return value;

    // Trim whitespace
    let sanitized = value.trim();

    // Check max length
    const maxLength = MAX_LENGTHS[fieldName] || MAX_LENGTHS.default;
    if (sanitized.length > maxLength) {
        sanitized = sanitized.slice(0, maxLength);
    }

    // Check for banned patterns
    if (containsBannedPatterns(sanitized)) {
        throw new Error(`Invalid characters detected in ${fieldName}`);
    }

    return sanitized;
}

/**
 * Sanitize an object recursively
 */
function sanitizeObject(obj, depth = 0) {
    if (depth > 10) {
        throw new Error('Object nesting too deep');
    }

    if (obj === null || obj === undefined) {
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map(item => sanitizeObject(item, depth + 1));
    }

    if (typeof obj === 'object') {
        const sanitized = {};
        for (const [key, value] of Object.entries(obj)) {
            // Sanitize key
            const sanitizedKey = sanitizeString(key, 'key');
            // Sanitize value
            sanitized[sanitizedKey] = sanitizeObject(value, depth + 1);
        }
        return sanitized;
    }

    if (typeof obj === 'string') {
        return sanitizeString(obj);
    }

    // Numbers, booleans pass through
    return obj;
}

/**
 * Validate pod creation input
 */
function validatePodInput(input) {
    const errors = [];

    if (!input.name || typeof input.name !== 'string') {
        errors.push('Pod name is required');
    } else if (input.name.length < 3 || input.name.length > 50) {
        errors.push('Pod name must be between 3 and 50 characters');
    } else if (!/^[a-zA-Z0-9-_]+$/.test(input.name)) {
        errors.push('Pod name can only contain letters, numbers, hyphens and underscores');
    }

    // Either imageName OR templateId is required
    const hasImageName = input.imageName && typeof input.imageName === 'string';
    const hasTemplateId = input.templateId && typeof input.templateId === 'string';

    if (!hasImageName && !hasTemplateId) {
        errors.push('Image name or template ID is required');
    }

    if (!input.gpuTypeId || typeof input.gpuTypeId !== 'string') {
        errors.push('GPU type is required');
    }

    if (input.gpuCount && (input.gpuCount < 1 || input.gpuCount > 8)) {
        errors.push('GPU count must be between 1 and 8');
    }

    if (input.volumeInGb && (input.volumeInGb < 0 || input.volumeInGb > 1000)) {
        errors.push('Volume size must be between 0 and 1000 GB');
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Validate job input
 */
function validateJobInput(input) {
    const errors = [];

    if (!input || typeof input !== 'object') {
        errors.push('Job input must be an object');
    }

    // Check for extremely large inputs
    const inputSize = JSON.stringify(input).length;
    if (inputSize > 1000000) { // 1MB limit
        errors.push('Job input too large (max 1MB)');
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Validate endpoint ID format
 */
function validateEndpointId(id) {
    if (!id || typeof id !== 'string') {
        return { valid: false, errors: ['Endpoint ID is required'] };
    }

    // RunPod endpoint IDs are typically alphanumeric
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
        return { valid: false, errors: ['Invalid endpoint ID format'] };
    }

    return { valid: true, errors: [] };
}

export const sanitizer = {
    sanitizeString,
    sanitizeObject,
    validatePodInput,
    validateJobInput,
    validateEndpointId,
    containsBannedPatterns
};

export default sanitizer;
