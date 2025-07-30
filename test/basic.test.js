const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Http2RPC = require('../index.js');

describe('Basic Functionality', () => {
  test('should create instance with default options', () => {
    const server = new Http2RPC();
    assert.strictEqual(server.port, 3000);
    assert.strictEqual(server.host, 'localhost');
    assert.deepStrictEqual(server.methods, {});
  });

  test('should add method successfully', () => {
    const server = new Http2RPC();
    const handler = async (params) => ({ result: params.value * 2 });
    server.addMethod('double', handler);
    assert.strictEqual(typeof server.methods.double, 'function');
  });

  test('should validate constructor options', () => {
    assert.throws(() => new Http2RPC({ port: 'invalid' }), /Port must be a valid port number/);
    assert.throws(() => new Http2RPC({ host: '' }), /Host must be a non-empty string/);
  });

  test('should validate method parameters', () => {
    const server = new Http2RPC();
    assert.throws(() => server.addMethod('', () => {}), /Method name must be a non-empty string/);
    assert.throws(() => server.addMethod('test', 'not-function'), /Method handler must be a function/);
  });

  test('should get and set methods', () => {
    const server = new Http2RPC();
    const methods = {
      method1: async () => 'result1',
      method2: async () => 'result2'
    };
    
    server.methods = methods;
    assert.strictEqual(Object.keys(server.methods).length, 2);
    assert.strictEqual(typeof server.methods.method1, 'function');
  });

  test('should provide metrics', () => {
    const server = new Http2RPC();
    const metrics = server.getMetrics();
    assert.ok(typeof metrics.requestCount === 'number');
    assert.ok(typeof metrics.errorCount === 'number');
    assert.ok(typeof metrics.startTime === 'number');
  });

  test('should provide resilience metrics', () => {
    const server = new Http2RPC();
    const metrics = server.getResilienceMetrics();
    assert.ok(metrics.resilience);
    assert.ok(metrics.resilience.timeout);
    assert.ok(metrics.resilience.circuitBreaker);
    assert.ok(metrics.resilience.retry);
  });

  test('should get method bulkhead status', () => {
    const server = new Http2RPC();
    server.addMethod('test', async () => 'ok');
    
    const status = server.getMethodBulkheadStatus('test');
    assert.strictEqual(status.methodName, 'test');
    assert.strictEqual(status.activeRequests, 0);
    
    const nonExistent = server.getMethodBulkheadStatus('nonexistent');
    assert.ok(nonExistent.error);
  });

  test('should reset circuit breaker', () => {
    const server = new Http2RPC();
    const serviceUrl = 'http://localhost:8888';
    
    // This should not throw
    server.resetCircuitBreaker(serviceUrl);
    
    const metrics = server.getResilienceMetrics();
    assert.ok(metrics.resilience.circuitBreaker);
  });

  test('should validate request parameters', async () => {
    const server = new Http2RPC();
    
    await assert.rejects(
      server.request('', 'test', {}),
      /Service URL must be a non-empty string/
    );
    
    await assert.rejects(
      server.request('invalid-url', 'test', {}),
      /Service URL must be a valid URL/
    );
    
    await assert.rejects(
      server.request('http://localhost:3000', '', {}),
      /Method name must be a non-empty string/
    );
  });

  test('should handle JWT validation methods', () => {
    const server = new Http2RPC({
      jwtAuth: true,
      jwtPublicKey: 'test-key'
    });
    
    // Test that the private method exists (indirectly)
    assert.strictEqual(server.jwtAuth, true);
    assert.strictEqual(server.jwtPublicKey, 'test-key');
  });

  test('should handle CORS configuration', () => {
    const server = new Http2RPC({
      cors: true,
      corsOptions: {
        origin: 'https://example.com',
        methods: 'GET, POST',
        headers: 'Content-Type'
      }
    });
    
    assert.strictEqual(server.cors, true);
    assert.strictEqual(server.corsOptions.origin, 'https://example.com');
  });

  test('should handle resilience configuration', () => {
    const server = new Http2RPC({
      resilience: {
        timeout: {
          requestTimeout: 5000,
          connectionTimeout: 2000
        },
        circuitBreaker: {
          failureThreshold: 3,
          recoveryTimeout: 5000
        },
        retry: {
          maxRetries: 5,
          initialDelay: 1000
        }
      }
    });
    
    assert.strictEqual(server.resilience.timeout.requestTimeout, 5000);
    assert.strictEqual(server.resilience.circuitBreaker.failureThreshold, 3);
    assert.strictEqual(server.resilience.retry.maxRetries, 5);
  });

  test('should handle backward compatible retry options', () => {
    const server = new Http2RPC({
      retryOptions: {
        maxRetries: 10,
        initialDelay: 2000
      }
    });
    
    assert.strictEqual(server.resilience.retry.maxRetries, 10);
    assert.strictEqual(server.resilience.retry.initialDelay, 2000);
  });

  test('should initialize with logger configuration', () => {
    const server = new Http2RPC({
      logger: {
        level: 'debug',
        isDev: false
      }
    });
    
    assert.ok(server.logger);
  });

  test('should handle excluded paths', () => {
    const server = new Http2RPC({
      excludedPaths: ['public', 'health']
    });
    
    assert.ok(server.excludedPaths.has('health-check'));
    assert.ok(server.excludedPaths.has('public'));
    assert.ok(server.excludedPaths.has('health'));
  });
});