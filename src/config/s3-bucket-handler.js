'use strict'

import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { parseBool } from '../helpers/env.js';

const disableS3Upload = parseBool(process.env.DISABLE_S3_UPLOAD, false);
const awsRegion = process.env.AWS_DEFAULT_REGION;
const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const awsS3Bucket = process.env.AWS_S3_BUCKET_NAME;
const awsEndpointUrl = process.env.AWS_ENDPOINT_URL;

/**
 * S3 bucket handler configuration and setup for Railway S3-compatible storage.
 */
class S3BucketHandler {
    constructor() {
        // Allow explicit disabling of S3 uploads via env var,
        // and keep tests safe even without credentials.
        if (disableS3Upload) {
            this.s3Client = null;
            this.bucketName = null;
            return;
        }

        // Validate required environment variables
        if (!awsRegion) {
            throw new Error('AWS_DEFAULT_REGION environment variable is required for S3 uploads');
        }
        if (!awsAccessKeyId) {
            throw new Error('AWS_ACCESS_KEY_ID environment variable is required for S3 uploads');
        }
        if (!awsSecretAccessKey) {
            throw new Error('AWS_SECRET_ACCESS_KEY environment variable is required for S3 uploads');
        }
        if (!awsS3Bucket) {
            throw new Error('AWS_S3_BUCKET_NAME environment variable is required for S3 uploads');
        }

        // Initialize S3 client with optional endpoint override for S3-compatible services (Railway)
        const clientConfig = {
            region: awsRegion,
            credentials: {
                accessKeyId: awsAccessKeyId,
                secretAccessKey: awsSecretAccessKey,
            },
            // why: the SDK default (WHEN_SUPPORTED) signs a CRC32 of an empty body into presigned PUT URLs, so browser uploads fail with SignatureDoesNotMatch
            requestChecksumCalculation: 'WHEN_REQUIRED',
        };

        // Add endpoint override if provided (for Railway S3-compatible storage)
        if (awsEndpointUrl) {
            clientConfig.endpoint = awsEndpointUrl;
            // Force path style for S3-compatible endpoints
            clientConfig.forcePathStyle = true;
        }

        this.s3Client = new S3Client(clientConfig);
        this.bucketName = awsS3Bucket;
    }

    /**
     * Upload a file to S3 bucket.
     * @param {Object} params - Upload parameters
     * @param {string} params.key - S3 object key (file path in bucket)
     * @param {Buffer} params.buffer - File buffer
     * @param {string} params.contentType - MIME type (e.g., 'image/jpeg')
     * @returns {Promise<string>} S3 key of uploaded file (to be stored in database)
     */
    async uploadFile({ key, buffer, contentType }) {
        // In test mode with no client configured, return the key as-is
        // URL generation happens in resolveUrl/getSignedUrl
        if (!this.s3Client) {
            return Promise.resolve(key);
        }

        try {
            const command = new PutObjectCommand({
                Bucket: this.bucketName,
                Key: key,
                Body: buffer,
                ContentType: contentType,
            });

            await this.s3Client.send(command);

            // Return the S3 key (to be stored in DB)
            return key;
        } catch (error) {
            const s3Error = new Error(`Failed to upload file to S3: ${error.message}`);
            s3Error.code = 'S3_UPLOAD_FAILED';
            s3Error.statusCode = 502;
            s3Error.originalError = error;
            throw s3Error;
        }
    }

    /**
     * Delete a file from S3 bucket.
     * @param {Object} params - Delete parameters
     * @param {string} params.key - S3 object key (file path in bucket)
     * @returns {Promise<void>}
     */
    async deleteFile({ key }) {
        // In test mode with no client configured, act as a no-op
        if (!this.s3Client) {
            return Promise.resolve();
        }

        try {
            const command = new DeleteObjectCommand({
                Bucket: this.bucketName,
                Key: key,
            });

            await this.s3Client.send(command);
        } catch (error) {
            // Don't throw on deletion errors - log and continue
            // File might not exist (404) or other non-critical issues
            console.error(`Failed to delete file from S3 (non-critical): ${error.message}`);
        }
    }

    /**
     * Resolve a stored avatar value to an accessible URL.
     * If the value is an S3 key (e.g. "avatars/uuid.jpg"), returns a signed URL.
     * If the value is already a full URL (e.g. Google avatar), returns it as-is.
     * @param {string|null} storedValue - S3 key or external URL from database
     * @param {number} [expiresIn=604800] - Signed URL expiration in seconds (default: 7 days)
     * @returns {Promise<string|null>} Accessible URL or null
     */
    async resolveUrl(storedValue, expiresIn = 604800) {
        if (!storedValue) return null;

        // If it looks like a full URL, return as-is (e.g. Google avatar)
        if (storedValue.startsWith('http://') || storedValue.startsWith('https://')) {
            return storedValue;
        }

        // Otherwise treat as S3 key and generate signed URL
        return this.getSignedUrl({ key: storedValue, expiresIn });
    }

    /**
     * Get a signed URL for an S3 object (temporary access).
     * @param {Object} params - Parameters
     * @param {string} params.key - S3 object key (file path in bucket)
     * @param {number} [params.expiresIn=604800] - URL expiration in seconds (default: 7 days)
     * @returns {Promise<string>} Signed URL
     */
    async getSignedUrl({ key, expiresIn = 604800 }) {
        if (!this.s3Client || !this.bucketName) {
            return 'https://example.com/disabled-s3-upload';
        }

        const command = new GetObjectCommand({
            Bucket: this.bucketName,
            Key: key,
        });

        return getSignedUrl(this.s3Client, command, { expiresIn, signableHeaders: new Set(['content-type', 'content-length']) });
    }

    /**
     * Get a presigned PUT URL so a client can upload an object directly to the bucket.
     * @param {Object} params - Parameters
     * @param {string} params.key - S3 object key (file path in bucket)
     * @param {string} params.contentType - MIME type the upload must declare
     * @param {number} [params.contentLength] - Exact byte size to sign; omitted keeps the length unsigned
     * @param {number} [params.expiresIn=900] - URL expiration in seconds
     * @returns {Promise<string>} Presigned upload URL
     */
    async getSignedPutUrl({ key, contentType, contentLength, expiresIn = 900 }) {
        if (!this.s3Client || !this.bucketName) {
            return 'https://example.com/disabled-s3-upload';
        }

        const command = new PutObjectCommand({
            Bucket: this.bucketName,
            Key: key,
            ContentType: contentType,
            ...(contentLength !== undefined && { ContentLength: contentLength }),
        });

        return getSignedUrl(this.s3Client, command, { expiresIn, signableHeaders: new Set(['content-type', 'content-length']) });
    }
}

export default new S3BucketHandler();
