# Logger Configuration

## Environment Variables

Add these to your `.env` file:

```bash
# Service identification
SERVICE_NAME=gaujofit-service
SERVICE_VERSION=1.0.0
NODE_ENV=development # or staging, production

# Grafana Cloud OTLP Configuration
GRAFANA_API_TOKEN=your_grafana_token_here
GRAFANA_OTLP_ENDPOINT=https://otlp-gateway-prod-us-central-0.grafana.net/otlp
```

## Usage Examples

### Basic Usage

```javascript
import createLogger from './src/config/logger.js';

const logger = createLogger('auth-service');

logger.debug('Debugging user authentication');
logger.info('User logged in successfully', { userId: '123', email: 'user@example.com' });
logger.warn('Rate limit approaching', { remainingAttempts: 2 });
logger.error('Authentication failed', { reason: 'Invalid credentials' });
```

### With Error Objects

```javascript
try {
  // some code
} catch (error) {
  logger.error('Failed to process request', error);
}
```

### Child Loggers (Nested Namespaces)

```javascript
const logger = createLogger('user-service');
const authLogger = logger.child('auth');

authLogger.info('Login attempt'); // Logs as [user-service:auth]
```

### In Route Handlers

```javascript
// api/routes/auth-route.js
import createLogger from '../../src/config/logger.js';

const logger = createLogger('auth-route');

export default async function authRoute(fastify, options) {
  fastify.post('/login', async (request, reply) => {
    logger.info('Login request received', { 
      ip: request.ip,
      userAgent: request.headers['user-agent'] 
    });
    
    try {
      // your logic
      logger.info('Login successful', { userId: user.id });
    } catch (error) {
      logger.error('Login failed', error);
      throw error;
    }
  });
}
```

### In Services

```javascript
// src/services/auth-service.js
import createLogger from '../config/logger.js';

const logger = createLogger('auth-service');

export async function authenticate(email, password) {
  logger.debug('Authenticating user', { email });
  
  try {
    // authentication logic
    logger.info('User authenticated successfully', { email });
    return user;
  } catch (error) {
    logger.error('Authentication failed', { email, error });
    throw error;
  }
}
```

## Log Levels

- **DEBUG**: Detailed information for debugging
- **INFO**: General informational messages
- **WARN**: Warning messages for potentially harmful situations
- **ERROR**: Error messages for error events

## Features

✅ OpenTelemetry integration
✅ Grafana Cloud Loki support
✅ Structured logging with metadata
✅ Namespace/context support
✅ Color-coded console output in development
✅ Automatic error stack trace extraction
✅ Child logger support
✅ Environment-aware (dev/staging/production)
✅ Graceful shutdown handling

## Installation

Run:
```bash
npm install @opentelemetry/api @opentelemetry/sdk-logs @opentelemetry/exporter-logs-otlp-http @opentelemetry/resources @opentelemetry/semantic-conventions
```
