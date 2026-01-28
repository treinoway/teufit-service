'use strict'

import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { 
    LoggerProvider, 
    SimpleLogRecordProcessor,
    ConsoleLogRecordExporter,
    BatchLogRecordProcessor
} from '@opentelemetry/sdk-logs';

// Enable OpenTelemetry diagnostics for debugging
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

const serviceName = process.env.SERVICE_NAME || 'treinoway-service';
const serviceVersion = process.env.SERVICE_VERSION || '1.0.0';
const environment = process.env.NODE_ENV || 'development';
const grafanaOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'https://otlp-gateway-prod-sa-east-1.grafana.net/otlp';
const grafanaOtlpHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;

// Log configuration for debugging
console.log('[Logger Config]', {
    serviceName,
    serviceVersion,
    environment,
    hasGrafanaEndpoint: !!grafanaOtlpEndpoint,
    hasGrafanaHeaders: !!grafanaOtlpHeaders,
    grafanaEndpoint: grafanaOtlpEndpoint,
});

// Log levels
const LogLevel = {
    DEBUG: 'debug',
    INFO: 'info',
    WARN: 'warn',
    ERROR: 'error',
};

// Create resource with service information
const resource = Resource.default().merge(
    new Resource({
        [ATTR_SERVICE_NAME]: serviceName,
        [ATTR_SERVICE_VERSION]: serviceVersion,
        'environment': environment,
    })
);

// Configure logger provider
const loggerProvider = new LoggerProvider({ resource });

// Add console exporter for local development
if (environment === 'development' || environment === 'test') {
    loggerProvider.addLogRecordProcessor(
        new SimpleLogRecordProcessor(new ConsoleLogRecordExporter())
    );
    console.log('[Logger] Console exporter added for development');
}

// Add Grafana OTLP exporter for production/staging
if (grafanaOtlpHeaders && (environment === 'production' || environment === 'staging')) {
    console.log('[Logger] Configuring Grafana OTLP exporter...');
    
    // Parse the OTLP headers from Grafana format
    const headers = {};
    const pairs = grafanaOtlpHeaders.split(',');
    pairs.forEach(pair => {
        const [key, value] = pair.split('=');
        if (key && value) {
            // Decode URL encoded values
            headers[key.trim()] = decodeURIComponent(value.trim());
        }
    });

    console.log('[Logger] Parsed headers:', Object.keys(headers));

    const otlpExporter = new OTLPLogExporter({
        url: `${grafanaOtlpEndpoint}/v1/logs`,
        headers,
    });

    loggerProvider.addLogRecordProcessor(
        new BatchLogRecordProcessor(otlpExporter, {
            maxQueueSize: 2048,
            maxExportBatchSize: 512,
            scheduledDelayMillis: 1000, // Send logs every 1 second
            exportTimeoutMillis: 30000,
        })
    );
    
    console.log('[Logger] Grafana OTLP exporter configured successfully');
    
    // Test log to verify connection
    setTimeout(() => {
        const testLogger = new Logger('system-test');
        testLogger.info('OpenTelemetry logger initialized and connected to Grafana', {
            serviceName,
            serviceVersion,
            environment,
        });
        loggerProvider.forceFlush();
    }, 500);
} else {
    console.log('[Logger] Grafana OTLP exporter NOT configured:', {
        hasHeaders: !!grafanaOtlpHeaders,
        environment,
        reason: !grafanaOtlpHeaders 
            ? 'Missing OTEL_EXPORTER_OTLP_HEADERS' 
            : `Environment is ${environment}, expected production or staging`
    });
}

/**
 * Logger class with namespace support
 */
class Logger {
    constructor(namespace = 'app') {
        this.namespace = namespace;
        this.logger = loggerProvider.getLogger(namespace, serviceVersion);
    }

    /**
     * Format log attributes
     */
    _formatAttributes(level, message, meta = {}) {
        return {
            level,
            namespace: this.namespace,
            message,
            timestamp: new Date().toISOString(),
            environment,
            ...meta,
        };
    }

    /**
     * Emit log record
     */
    _emit(level, message, meta = {}) {
        const attributes = this._formatAttributes(level, message, meta);
        
        // Console output for development
        if (environment === 'development' || environment === 'test') {
            const color = {
                debug: '\x1b[36m', // Cyan
                info: '\x1b[32m',  // Green
                warn: '\x1b[33m',  // Yellow
                error: '\x1b[31m', // Red
            }[level] || '\x1b[0m';
            
            const reset = '\x1b[0m';
            const timestamp = new Date().toISOString();
            const prefix = `${color}[${timestamp}] [${level.toUpperCase()}] [${this.namespace}]${reset}`;
            
            console.log(`${prefix} ${message}`, meta && Object.keys(meta).length > 0 ? meta : '');
        }

        // Emit to OpenTelemetry
        this.logger.emit({
            severityText: level.toUpperCase(),
            body: message,
            attributes,
        });
    }

    /**
     * Debug level log
     */
    debug(message, meta = {}) {
        this._emit(LogLevel.DEBUG, message, meta);
    }

    /**
     * Info level log
     */
    info(message, meta = {}) {
        this._emit(LogLevel.INFO, message, meta);
    }

    /**
     * Warning level log
     */
    warn(message, meta = {}) {
        this._emit(LogLevel.WARN, message, meta);
    }

    /**
     * Error level log
     */
    error(message, meta = {}) {
        // If meta is an Error object, extract stack trace
        if (meta instanceof Error) {
            meta = {
                error: {
                    name: meta.name,
                    message: meta.message,
                    stack: meta.stack,
                }
            };
        }
        
        this._emit(LogLevel.ERROR, message, meta);
    }

    /**
     * Create a child logger with additional namespace
     */
    child(childNamespace) {
        return new Logger(`${this.namespace}:${childNamespace}`);
    }
}

/**
 * Create a logger instance with namespace
 */
function createLogger(namespace = 'app') {
    return new Logger(namespace);
}

/**
 * Force flush all pending logs
 */
async function forceFlush() {
    await loggerProvider.forceFlush();
}

/**
 * Graceful shutdown
 */
async function shutdownLogger() {
    await loggerProvider.shutdown();
}

// Handle process exit
process.on('SIGTERM', async () => {
    await shutdownLogger();
    process.exit(0);
});

process.on('SIGINT', async () => {
    await shutdownLogger();
    process.exit(0);
});

export { createLogger, Logger, LogLevel, shutdownLogger, forceFlush, loggerProvider };
export default createLogger;
