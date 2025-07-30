# RPCMate

[![npm version](https://badge.fury.io/js/rpcmate.svg)](https://badge.fury.io/js/rpcmate)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> A lightweight and powerful HTTP/2 RPC server with JWT authentication and retry mechanism

## Overview

RPCMate is a production-ready Node.js library that simplifies building HTTP/2 RPC servers with enterprise-grade reliability. It implements comprehensive resilience patterns (Timeout → Bulkhead → Circuit Breaker → Retry) to ensure robust microservice communication, along with JWT RS256 authentication, structured logging with Pino, and comprehensive metrics. The library abstracts away low-level HTTP/2 protocol details while preserving full control over method handling, making it ideal for mission-critical microservices architectures and high-performance API servers.

## Features

- **HTTP/2 Support** with automatic connection handling
- **JWT RS256 Authentication** with configurable validation
- **Resilience Patterns** with enterprise-grade reliability:
  - **Timeout Pattern** - Request and connection timeouts
  - **Bulkhead Pattern** - Resource isolation and concurrency control
  - **Circuit Breaker Pattern** - Automatic failure detection and recovery
  - **Enhanced Retry Pattern** - Exponential backoff with jitter
- **Built-in Metrics** and health check endpoints
- **CORS Support** with configurable options
- **Graceful Shutdown** handling
- **Structured Logging** with Pino (development and production modes)
- **Simple API** for quick integration
- **TypeScript Ready** (types included)
- **Enhanced Validation** - Comprehensive input validation and error handling
- **Performance Optimized** - Efficient resource management and connection pooling
- **Comprehensive Testing** - Full test coverage with unit and integration tests

## Installation

```bash
npm install rpcmate
```

## Quick Start

```javascript
const Http2RPC = require('rpcmate');

// Create server instance
const server = new Http2RPC({
  port: 3000,
  host: 'localhost'
});

// Add a method
server.addMethod('getUser', async (params) => {
  return {
    id: params.id,
    name: 'Eugene',
    email: 'eugene@example.com'
  };
});

// Make client request
const result = await server.request('http://localhost:3000', 'getUser', { id: 123 });
console.log('User:', result.data);
```

## Configuration Options

### Basic Configuration
```javascript
const server = new Http2RPC({
  port: 3000,                    // Server port (default: 3000)
  host: 'localhost',             // Server host (default: 'localhost')
  startServer: true,             // Auto-start server (default: false)
  
  // Logger configuration
  logger: {
    title: 'MyRPCServer',        // Logger name (default: class name)
    level: 'info',               // Log level (default: 'info')
    isDev: false                 // Use JSON format for production (default: true)
  }
});
```

### CORS Configuration
```javascript
const server = new Http2RPC({
  cors: true,                    // Enable CORS (default: true)
  corsOptions: {
    origin: '*',                 // Allowed origins
    methods: 'GET, POST, OPTIONS',
    headers: 'Content-Type, Authorization'
  }
});
```

### JWT Authentication
```javascript
const server = new Http2RPC({
  jwtAuth: true,
  jwtPublicKey: fs.readFileSync('public-key.pem'),
  jwtIssuer: 'your-issuer',
  jwtAudience: 'your-audience',
  excludedPaths: ['health-check', 'public-method']
});
```

### Resilience Patterns Configuration
```javascript
const server = new Http2RPC({
  resilience: {
    // Timeout pattern
    timeout: {
      enabled: true,             // Enable timeouts (default: true)
      requestTimeout: 30000,     // Request timeout in ms (default: 30000)
      connectionTimeout: 5000    // Connection timeout in ms (default: 5000)
    },
    
    // Bulkhead pattern
    bulkhead: {
      enabled: true,             // Enable bulkhead (default: true)
      maxConcurrentRequests: 100, // Max concurrent requests (default: 100)
      maxQueueSize: 200          // Max queued requests (default: 200)
    },
    
    // Circuit breaker pattern
    circuitBreaker: {
      enabled: true,             // Enable circuit breaker (default: true)
      failureThreshold: 5,       // Failures before opening (default: 5)
      recoveryTimeout: 60000,    // Recovery timeout in ms (default: 60000)
      successThreshold: 3        // Successes to close circuit (default: 3)
    },
    
    // Enhanced retry pattern
    retry: {
      maxRetries: 3,             // Maximum retry attempts (default: 3)
      initialDelay: 500,         // Initial delay in ms (default: 500)
      maxDelay: 10000,           // Maximum delay in ms (default: 10000)
      backoffFactor: 2,          // Backoff multiplier (default: 2)
      retryOn: [500, 502, 503, 504], // HTTP status codes to retry
      jitterEnabled: true        // Add jitter to delays (default: true)
    }
  }
});
```

### Legacy Retry Configuration (Backward Compatible)
```javascript
const server = new Http2RPC({
  retryOptions: {
    maxRetries: 5,               // Maximum retry attempts (default: 3)
    initialDelay: 1000,          // Initial delay in ms (default: 500)
    maxDelay: 30000,             // Maximum delay in ms (default: 10000)
    backoffFactor: 2,            // Backoff multiplier (default: 2)
    retryOn: [500, 502, 503, 504] // HTTP status codes to retry
  }
});
```

### Methods in Constructor
```javascript
const server = new Http2RPC({
  methods: {
    'getUser': async (params) => ({ id: params.id, name: 'User' }),
    'createUser': async (params) => ({ id: Date.now(), ...params })
  }
});
```

## API Reference

### Constructor
```javascript
new RPCMate(options)
```

**Parameters:**
- `options` (object) - Configuration options

### Core Methods

#### `addMethod(name, handler)`
Adds a new RPC method to the server.

**Parameters:**
- `name` (string) - Method name
- `handler` (function) - Async function to handle the method

**Example:**
```javascript
server.addMethod('calculateSum', async (params) => {
  const { a, b } = params;
  return { result: a + b };
});
```

#### `request(serviceUrl, methodName, params, options)`
Makes an RPC request to a remote server with retry mechanism.

**Parameters:**
- `serviceUrl` (string) - Target server URL
- `methodName` (string) - Method to call
- `params` (object) - Parameters to send
- `options` (object) - Request options (token, custom retry settings)

**Example:**
```javascript
const result = await server.request(
  'http://api.example.com',
  'getUserData',
  { userId: 123 },
  { token: 'jwt-token' }
);
```

#### `start()`
Starts the HTTP/2 server.

**Returns:** Promise<Server>

#### `stop(timeout)`
Stops the server gracefully.

**Parameters:**
- `timeout` (number) - Shutdown timeout in ms (default: 5000)

#### `getMetrics()`
Returns comprehensive server metrics including resilience patterns data.

**Returns:**
```javascript
{
  requestCount: 150,
  errorCount: 5,
  averageResponseTime: 45,
  uptime: 3600000,
  retryCount: 12,
  authFailures: 2,
  timeoutCount: 3,
  circuitBreakerTrips: 1,
  bulkheadRejections: 5,
  circuitBreakerState: {
    'http://api.example.com': {
      state: 'CLOSED',
      failureCount: 0,
      successCount: 10
    }
  },
  bulkhead: {
    activeRequests: 25,
    queuedRequests: 5,
    rejectedRequests: 10
  }
}
```

#### `getResilienceMetrics()`
Returns detailed resilience patterns metrics and configuration.

**Returns:**
```javascript
{
  resilience: {
    timeout: {
      enabled: true,
      requestTimeout: 30000,
      timeoutCount: 3
    },
    circuitBreaker: {
      enabled: true,
      trips: 1,
      states: { /* per-service states */ }
    },
    bulkhead: {
      enabled: true,
      maxConcurrentRequests: 100,
      activeRequests: 25,
      rejections: 5
    },
    retry: {
      enabled: true,
      maxRetries: 3,
      jitterEnabled: true,
      totalRetries: 12
    }
  }
}
```

#### `resetCircuitBreaker(serviceUrl)`
Manually resets circuit breaker for a specific service to CLOSED state.

**Parameters:**
- `serviceUrl` (string) - Service URL to reset circuit breaker for

**Example:**
```javascript
server.resetCircuitBreaker('http://api.example.com');
```

### Properties

#### `methods` (getter/setter)
Get or set all methods at once.

**Example:**
```javascript
// Get all methods
console.log(server.methods);

// Set multiple methods
server.methods = {
  'method1': async (params) => 'result1',
  'method2': async (params) => 'result2'
};
```

## Logger Configuration

- **title** (string): Name displayed in logs (default: class name)
- **level** (string): Logging level - 'trace', 'debug', 'info', 'warn', 'error', 'fatal' (default: 'info')
- **isDev** (boolean): 
  - `true`: Uses pino-pretty for colored, human-readable output (development)
  - `false`: Uses JSON format for structured logging (production)

## Authentication

### JWT RS256 Setup
```javascript
const fs = require('fs');

const server = new Http2RPC({
  jwtAuth: true,
  jwtPublicKey: fs.readFileSync('path/to/public-key.pem'),
  jwtIssuer: 'your-service',
  jwtAudience: 'your-client-app',
  excludedPaths: ['health-check', 'public-api']
});
```

### Accessing User Data in Methods
```javascript
server.addMethod('getUserProfile', async (params) => {
  // JWT payload is available in params._user
  const userId = params._user.sub;
  return await getUserById(userId);
});
```

## Resilience Patterns

RPCMate implements four key resilience patterns to ensure robust microservice communication:

### 1. Timeout Pattern
Prevents indefinite waiting by setting time limits on operations.

```javascript
const server = new Http2RPC({
  resilience: {
    timeout: {
      enabled: true,
      requestTimeout: 10000,     // 10 second request timeout
      connectionTimeout: 2000    // 2 second connection timeout
    }
  }
});

// Requests will timeout after 10 seconds
// Connections will timeout after 2 seconds
```

### 2. Bulkhead Pattern
Isolates resources to prevent cascade failures by limiting concurrent operations.

```javascript
const server = new Http2RPC({
  resilience: {
    bulkhead: {
      enabled: true,
      maxConcurrentRequests: 50,  // Only 50 concurrent requests allowed
      maxQueueSize: 100          // Queue up to 100 additional requests
    }
  }
});

// If 50 requests are active and 100 are queued,
// additional requests will be rejected immediately
```

### 3. Circuit Breaker Pattern
Automatically stops calling failing services and provides fast failure responses.

```javascript
const server = new Http2RPC({
  resilience: {
    circuitBreaker: {
      enabled: true,
      failureThreshold: 3,        // Open after 3 consecutive failures
      recoveryTimeout: 30000,     // Try again after 30 seconds
      successThreshold: 2         // Close after 2 successful calls
    }
  }
});

// Circuit states: CLOSED -> OPEN -> HALF_OPEN -> CLOSED
// Monitor circuit state: server.getResilienceMetrics()
```

### 4. Enhanced Retry Pattern
Intelligent retry mechanism with exponential backoff and jitter.

```javascript
const server = new Http2RPC({
  resilience: {
    retry: {
      maxRetries: 5,
      initialDelay: 1000,         // Start with 1 second delay
      maxDelay: 30000,           // Maximum 30 second delay
      backoffFactor: 2,          // Double delay each time
      jitterEnabled: true,       // Add randomness to prevent thundering herd
      retryOn: [500, 502, 503, 504, 'ETIMEDOUT']
    }
  }
});

// Retry delays with jitter: ~1s, ~2s, ~4s, ~8s, ~16s
```

### Complete Resilience Configuration
```javascript
const server = new Http2RPC({
  resilience: {
    timeout: {
      enabled: true,
      requestTimeout: 15000,
      connectionTimeout: 3000
    },
    bulkhead: {
      enabled: true,
      maxConcurrentRequests: 200,
      maxQueueSize: 500
    },
    circuitBreaker: {
      enabled: true,
      failureThreshold: 5,
      recoveryTimeout: 60000,
      successThreshold: 3
    },
    retry: {
      maxRetries: 4,
      initialDelay: 500,
      maxDelay: 20000,
      backoffFactor: 1.5,
      jitterEnabled: true
    }
  }
});

// Monitor all patterns
const metrics = server.getResilienceMetrics();
console.log('Circuit Breaker States:', metrics.resilience.circuitBreaker.states);
console.log('Active Requests:', metrics.resilience.bulkhead.activeRequests);
```

## Examples

### Microservice with Full Configuration
```javascript
const Http2RPC = require('rpcmate');
const fs = require('fs');

const server = new Http2RPC({
  port: process.env.PORT || 3000,
  host: process.env.HOST || '0.0.0.0',
  
  logger: {
    title: 'UserService',
    level: process.env.LOG_LEVEL || 'info',
    isDev: process.env.NODE_ENV !== 'production'
  },
  
  jwtAuth: process.env.JWT_AUTH === 'true',
  jwtPublicKey: process.env.JWT_PUBLIC_KEY ? 
    fs.readFileSync(process.env.JWT_PUBLIC_KEY) : null,
  jwtIssuer: process.env.JWT_ISSUER,
  jwtAudience: process.env.JWT_AUDIENCE,
  
  retryOptions: {
    maxRetries: 5,
    initialDelay: 1000,
    backoffFactor: 1.5
  }
});

// Add methods
server.addMethod('createUser', async (params) => {
  const user = await createUser(params);
  return { success: true, user };
});

server.addMethod('getUser', async (params) => {
  const user = await getUserById(params.id);
  return { user };
});
```

### Health Check Endpoint
The server automatically provides a health check endpoint at `/health-check`:

```bash
curl http://localhost:3000/health-check
```

Response:
```json
{
  "data": {
    "status": "ok",
    "uptime": 3600000,
    "timestamp": "2024-01-15T12:00:00.000Z",
    "rpc": {
      "status": "ok", 
      "mode": "server",
      "details": "RPC server is running and accepting requests"
    },
    "metrics": {
      "requestCount": 150,
      "errorCount": 5,
      "averageResponseTime": 45
    },
    "methods": ["getUser", "createUser"],
    "auth": "JWT RS256"
  }
}
```

#### Health Check Modes

RPCMate автоматически определяет режим работы и возвращает соответствующий статус:

1. **Режим Server**: когда есть зарегистрированные методы и сервер запущен
```json
"rpc": {
  "status": "ok",
  "mode": "server",
  "details": "RPC server is running and accepting requests"
}
```

2. **Режим Client-only**: когда нет зарегистрированных методов (только отправка запросов)
```json
"rpc": {
  "status": "ok",
  "mode": "client-only", 
  "details": "RPC client mode - server not required"
}
```

3. **Ошибка инициализации сервера**: когда есть зарегистрированные методы, но сервер не запущен
```json
"rpc": {
  "status": "error", 
  "error": "RPC server is not initialized",
  "details": "RPC server is not available",
  "critical": true
}
```

### Client Request with Retry
```javascript
// Client making requests with automatic retry
const client = new RPCMate();

try {
  const result = await client.request(
    'http://unreliable-service.com',
    'processData',
    { data: 'important-data' },
    {
      token: 'bearer-token',
      maxRetries: 5,
      initialDelay: 2000
    }
  );
  console.log('Success:', result.data);
} catch (error) {
  console.error('Failed after retries:', error.message);
}
```

### Error Handling
```javascript
server.addMethod('processPayment', async (params) => {
  try {
    const result = await processPayment(params);
    return { success: true, transactionId: result.id };
  } catch (error) {
    // Errors are automatically logged with context
    throw new Error(`Payment processing failed: ${error.message}`);
  }
});
```

## Response Format

All responses follow a consistent format:

**Success Response:**
```json
{
  "data": {
    "result": "method-specific-data"
  }
}
```

**Error Response:**
```json
{
  "error": "ERROR_CODE",
  "message": "Human readable error message",
  "details": "Additional error context"
}
```

## Testing

RPCMate includes comprehensive test coverage with both unit and integration tests. All tests are designed to validate the resilience patterns, security features, and performance characteristics.

### Running Tests

```bash
# Run all tests
npm test

# Run specific test files
npm run test:basic
npm run test:integration

# Run tests with coverage
npm run test:coverage
```

### Test Coverage

- **Unit Tests**: Constructor validation, method management, resilience patterns, metrics
- **Integration Tests**: Microservice communication, real-world scenarios, performance testing
- **Security Tests**: JWT authentication, input validation, error handling
- **Performance Tests**: Load testing, concurrent request handling, resource management

## Version History

### v1.3.0 (Latest)
- ✅ Enhanced input validation and error handling
- ✅ Improved HTTP/2 connection management
- ✅ Performance optimizations and memory leak fixes
- ✅ Comprehensive test coverage
- ✅ TypeScript definitions included
- ✅ Better resilience pattern implementations

### v1.2.0
- JWT RS256 authentication support
- Circuit breaker and bulkhead patterns
- Enhanced retry mechanism with jitter
- Structured logging with Pino

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

## License

MIT © [Eugene Surkov](https://github.com/esurkov1)

---

**Made with ❤️ for the Node.js community** 