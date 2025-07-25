# RPCMate

[![npm version](https://badge.fury.io/js/rpcmate.svg)](https://badge.fury.io/js/rpcmate)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> A lightweight and powerful HTTP/2 RPC server with JWT authentication and retry mechanism

## Overview

RPCMate is a production-ready Node.js library that simplifies building HTTP/2 RPC servers with enterprise-grade features. It provides JWT RS256 authentication, automatic retry mechanisms, built-in metrics, and structured logging with Pino. The library abstracts away low-level HTTP/2 protocol details while preserving full control over method handling, making it ideal for microservices architectures and high-performance API servers.

## Features

- **HTTP/2 Support** with automatic connection handling
- **JWT RS256 Authentication** with configurable validation
- **Retry Mechanism** for client requests with exponential backoff
- **Built-in Metrics** and health check endpoints
- **CORS Support** with configurable options
- **Graceful Shutdown** handling
- **Structured Logging** with Pino (development and production modes)
- **Simple API** for quick integration
- **TypeScript Ready** (types included)

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

### Retry Configuration
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
new Http2RPC(options)
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
Returns comprehensive server metrics.

**Returns:**
```javascript
{
  requestCount: 150,
  errorCount: 5,
  averageResponseTime: 45,
  uptime: 3600000,
  retryCount: 12,
  authFailures: 2
}
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

### Client Request with Retry
```javascript
// Client making requests with automatic retry
const client = new Http2RPC();

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

## License

MIT © [Eugene Surkov](https://github.com/esurkov1)

---

**Made with ❤️ for the Node.js community** 