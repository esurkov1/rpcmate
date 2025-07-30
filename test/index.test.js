const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Http2RPC = require('../index.js');

// Test utilities
const testUtils = {
  // Generate test JWT key pair
  generateKeyPair() {
    return crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
  },

  // Create test JWT token
  createJWT(payload, privateKey) {
    const header = { alg: 'RS256', typ: 'JWT' };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    
    const signatureData = `${headerB64}.${payloadB64}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signatureData);
    const signature = signer.sign(privateKey, 'base64url');
    
    return `${headerB64}.${payloadB64}.${signature}`;
  },

  // Wait helper
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  // Free port finder
  async findFreePort() {
    const { createServer } = require('http');
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(0, (err) => {
        if (err) reject(err);
        const port = server.address().port;
        server.close(() => resolve(port));
      });
    });
  }
};

describe('Http2RPC', () => {
  let server;
  let port;
  let keyPair;

  before(async () => {
    port = await testUtils.findFreePort();
    keyPair = testUtils.generateKeyPair();
  });

  afterEach(async () => {
    if (server && server.server) {
      await server.stop();
      server = null;
    }
  });

  describe('Constructor', () => {
    test('should create instance with default options', () => {
      server = new Http2RPC();
      assert.strictEqual(server.port, 3000);
      assert.strictEqual(server.host, 'localhost');
      assert.deepStrictEqual(server.methods, {});
    });

    test('should create instance with custom options', () => {
      server = new Http2RPC({
        port: port,
        host: '127.0.0.1',
        jwtAuth: true,
        jwtPublicKey: keyPair.publicKey
      });
      assert.strictEqual(server.port, port);
      assert.strictEqual(server.host, '127.0.0.1');
      assert.strictEqual(server.jwtAuth, true);
    });

    test('should validate constructor options', () => {
      assert.throws(() => new Http2RPC({ port: 'invalid' }), /Port must be a valid port number/);
      assert.throws(() => new Http2RPC({ host: '' }), /Host must be a non-empty string/);
      assert.throws(() => new Http2RPC({ methods: 'invalid' }), /Methods must be an object/);
    });

    test('should initialize with methods', () => {
      const methods = {
        testMethod: async (params) => ({ result: 'test' })
      };
      server = new Http2RPC({ methods, port });
      assert.strictEqual(typeof server.methods.testMethod, 'function');
    });
  });

  describe('Method Management', () => {
    beforeEach(() => {
      server = new Http2RPC({ port });
    });

    test('should add method successfully', () => {
      const handler = async (params) => ({ result: params.value * 2 });
      server.addMethod('double', handler);
      assert.strictEqual(typeof server.methods.double, 'function');
    });

    test('should validate method parameters', () => {
      assert.throws(() => server.addMethod('', () => {}), /Method name must be a non-empty string/);
      assert.throws(() => server.addMethod('test', 'not-function'), /Method handler must be a function/);
      assert.throws(() => server.addMethod('test', () => {}, 'not-object'), /Bulkhead config must be an object/);
    });

    test('should warn on method override', () => {
      const handler1 = async () => 'first';
      const handler2 = async () => 'second';
      
      server.addMethod('test', handler1);
      server.addMethod('test', handler2); // Should warn but not throw
      
      assert.strictEqual(typeof server.methods.test, 'function');
    });

    test('should set methods via property', () => {
      const methods = {
        method1: async () => 'result1',
        method2: async () => 'result2'
      };
      
      server.methods = methods;
      assert.strictEqual(Object.keys(server.methods).length, 2);
      assert.strictEqual(typeof server.methods.method1, 'function');
    });

    test('should validate methods property', () => {
      assert.throws(() => { server.methods = 'invalid'; }, /Methods must be an object/);
    });
  });

  describe('Server Lifecycle', () => {
    test('should start and stop server', async () => {
      server = new Http2RPC({ port });
      server.addMethod('test', async () => 'ok');
      
      const httpServer = await server.start();
      assert.ok(httpServer.listening);
      
      await server.stop();
      assert.ok(!httpServer.listening);
    });

    test('should handle start errors', async () => {
      // Create two servers on same port to trigger error
      const server1 = new Http2RPC({ port });
      const server2 = new Http2RPC({ port });
      
      server1.addMethod('test', async () => 'ok');
      server2.addMethod('test', async () => 'ok');
      
      await server1.start();
      
      try {
        await assert.rejects(server2.start(), /EADDRINUSE/);
      } finally {
        await server1.stop();
      }
    });

    test('should handle graceful shutdown timeout', async () => {
      server = new Http2RPC({ port });
      server.addMethod('test', async () => 'ok');
      
      await server.start();
      await server.stop(100); // Short timeout
    });
  });

  describe('HTTP/2 RPC Methods', () => {
    beforeEach(async () => {
      server = new Http2RPC({ port });
      server.addMethod('echo', async (params) => params);
      server.addMethod('add', async (params) => ({ result: params.a + params.b }));
      server.addMethod('error', async () => { throw new Error('Test error'); });
      server.addMethod('delay', async (params) => {
        await testUtils.sleep(params.ms || 100);
        return { delayed: true };
      });
      
      await server.start();
    });

    test('should handle basic RPC calls', async () => {
      const result = await server.request(`http://localhost:${port}`, 'echo', { message: 'hello' });
      assert.deepStrictEqual(result, { message: 'hello' });
    });

    test('should handle arithmetic operations', async () => {
      const result = await server.request(`http://localhost:${port}`, 'add', { a: 5, b: 3 });
      assert.deepStrictEqual(result, { result: 8 });
    });

    test('should handle method errors', async () => {
      await assert.rejects(
        server.request(`http://localhost:${port}`, 'error', {}),
        /Test error/
      );
    });

    test('should handle non-existent methods', async () => {
      await assert.rejects(
        server.request(`http://localhost:${port}`, 'nonexistent', {}),
        /Method not found/
      );
    });

    test('should validate request parameters', async () => {
      await assert.rejects(
        server.request('', 'test', {}),
        /Service URL must be a non-empty string/
      );
      
      await assert.rejects(
        server.request('invalid-url', 'test', {}),
        /Service URL must be a valid URL/
      );
      
      await assert.rejects(
        server.request(`http://localhost:${port}`, '', {}),
        /Method name must be a non-empty string/
      );
    });
  });

  describe('JWT Authentication', () => {
    beforeEach(async () => {
      server = new Http2RPC({
        port,
        jwtAuth: true,
        jwtPublicKey: keyPair.publicKey,
        jwtIssuer: 'test-issuer',
        jwtAudience: 'test-audience'
      });
      
      server.addMethod('protected', async (params) => ({ user: params._user, data: 'secret' }));
      server.addMethod('user-info', async (params) => ({ userId: params._user.sub }));
      
      await server.start();
    });

    test('should reject requests without token', async () => {
      await assert.rejects(
        server.request(`http://localhost:${port}`, 'protected', {}),
        /Missing or invalid Authorization header/
      );
    });

    test('should accept valid JWT token', async () => {
      const payload = {
        sub: 'user123',
        iss: 'test-issuer',
        aud: 'test-audience',
        exp: Math.floor(Date.now() / 1000) + 3600 // 1 hour
      };
      
      const token = testUtils.createJWT(payload, keyPair.privateKey);
      
      const result = await server.request(
        `http://localhost:${port}`,
        'protected',
        {},
        { token }
      );
      
      assert.strictEqual(result.user.sub, 'user123');
      assert.strictEqual(result.data, 'secret');
    });

    test('should reject expired tokens', async () => {
      const payload = {
        sub: 'user123',
        iss: 'test-issuer',
        aud: 'test-audience',
        exp: Math.floor(Date.now() / 1000) - 3600 // Expired 1 hour ago
      };
      
      const token = testUtils.createJWT(payload, keyPair.privateKey);
      
      await assert.rejects(
        server.request(`http://localhost:${port}`, 'protected', {}, { token }),
        /Token expired/
      );
    });

    test('should reject invalid issuer', async () => {
      const payload = {
        sub: 'user123',
        iss: 'wrong-issuer',
        aud: 'test-audience',
        exp: Math.floor(Date.now() / 1000) + 3600
      };
      
      const token = testUtils.createJWT(payload, keyPair.privateKey);
      
      await assert.rejects(
        server.request(`http://localhost:${port}`, 'protected', {}, { token }),
        /Invalid issuer/
      );
    });

    test('should allow excluded paths', async () => {
      const serverWithExcluded = new Http2RPC({
        port: port + 1,
        jwtAuth: true,
        jwtPublicKey: keyPair.publicKey,
        excludedPaths: ['public']
      });
      
      serverWithExcluded.addMethod('public', async () => ({ public: true }));
      
      try {
        await serverWithExcluded.start();
        
        const result = await server.request(
          `http://localhost:${port + 1}`,
          'public',
          {}
        );
        
        assert.deepStrictEqual(result, { public: true });
      } finally {
        await serverWithExcluded.stop();
      }
    });
  });

  describe('Resilience Patterns', () => {
    describe('Retry Pattern', () => {
      test('should retry on failure', async () => {
        let attempts = 0;
        server = new Http2RPC({ port });
        
        server.addMethod('flaky', async () => {
          attempts++;
          if (attempts < 3) throw new Error('Temporary failure');
          return { success: true, attempts };
        });
        
        await server.start();
        
        const result = await server.request(
          `http://localhost:${port}`,
          'flaky',
          {},
          { maxRetries: 5 }
        );
        
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.attempts, 3);
      });

      test('should respect max retries', async () => {
        server = new Http2RPC({ port });
        
        server.addMethod('alwaysFails', async () => {
          throw new Error('Always fails');
        });
        
        await server.start();
        
        await assert.rejects(
          server.request(
            `http://localhost:${port}`,
            'alwaysFails',
            {},
            { maxRetries: 2 }
          ),
          /Always fails/
        );
      });
    });

    describe('Circuit Breaker', () => {
      test('should open circuit after failures', async () => {
        server = new Http2RPC({
          port,
          resilience: {
            circuitBreaker: {
              failureThreshold: 2,
              recoveryTimeout: 1000
            }
          }
        });
        
        server.addMethod('test', async () => 'ok');
        await server.start();
        
        const targetUrl = `http://localhost:${port + 100}`; // Non-existent server
        
        // First failures should trigger circuit breaker
        for (let i = 0; i < 3; i++) {
          try {
            await server.request(targetUrl, 'test', {}, { maxRetries: 0 });
          } catch (error) {
            // Expected failures
          }
        }
        
        // Circuit should be open now
        await assert.rejects(
          server.request(targetUrl, 'test', {}, { maxRetries: 0 }),
          /Circuit breaker is OPEN/
        );
      });

      test('should reset circuit breaker manually', async () => {
        server = new Http2RPC({ port });
        
        const targetUrl = `http://localhost:${port + 100}`;
        
        // Trigger circuit breaker
        for (let i = 0; i < 6; i++) {
          try {
            await server.request(targetUrl, 'test', {}, { maxRetries: 0 });
          } catch (error) {
            // Expected failures
          }
        }
        
        server.resetCircuitBreaker(targetUrl);
        
        // Circuit should be reset to CLOSED
        const metrics = server.getResilienceMetrics();
        const circuitState = metrics.resilience.circuitBreaker.states[targetUrl];
        assert.strictEqual(circuitState?.state, 'CLOSED');
      });
    });

    describe('Bulkhead Pattern', () => {
      test('should limit concurrent requests per method', async () => {
        server = new Http2RPC({ port });
        
        server.addMethod('slow', async (params) => {
          await testUtils.sleep(200);
          return { processed: true };
        }, {
          maxConcurrentRequests: 2,
          maxQueueSize: 1
        });
        
        await server.start();
        
        const requests = [];
        
        // Start 4 concurrent requests (2 active + 1 queued + 1 should be rejected)
        for (let i = 0; i < 4; i++) {
          requests.push(
            server.request(`http://localhost:${port}`, 'slow', { id: i })
              .catch(error => ({ error: error.message }))
          );
        }
        
        const results = await Promise.all(requests);
        
        // Check that some requests were rejected due to bulkhead
        const rejectedCount = results.filter(r => r.error?.includes('bulkhead')).length;
        assert.ok(rejectedCount > 0, 'Expected some requests to be rejected by bulkhead');
      });

      test('should provide bulkhead status', async () => {
        server = new Http2RPC({ port });
        server.addMethod('test', async () => 'ok');
        
        const status = server.getMethodBulkheadStatus('test');
        assert.strictEqual(status.methodName, 'test');
        assert.strictEqual(status.activeRequests, 0);
        assert.strictEqual(status.queuedRequests, 0);
      });
    });

    describe('Timeout Pattern', () => {
      test('should timeout long-running requests', async () => {
        server = new Http2RPC({
          port,
          resilience: {
            timeout: {
              requestTimeout: 100 // Very short timeout
            }
          }
        });
        
        server.addMethod('longRunning', async () => {
          await testUtils.sleep(500);
          return { completed: true };
        });
        
        await server.start();
        
        await assert.rejects(
          server.request(`http://localhost:${port}`, 'longRunning', {}),
          /timeout/
        );
      });
    });
  });

  describe('Metrics and Monitoring', () => {
    beforeEach(async () => {
      server = new Http2RPC({ port });
      server.addMethod('counter', async () => ({ count: 1 }));
      server.addMethod('error', async () => { throw new Error('Test error'); });
      await server.start();
    });

    test('should track basic metrics', async () => {
      await server.request(`http://localhost:${port}`, 'counter', {});
      await server.request(`http://localhost:${port}`, 'counter', {});
      
      try {
        await server.request(`http://localhost:${port}`, 'error', {});
      } catch (error) {
        // Expected error
      }
      
      const metrics = server.getMetrics();
      assert.strictEqual(metrics.requestCount, 3);
      assert.strictEqual(metrics.errorCount, 1);
      assert.ok(metrics.averageResponseTime > 0);
      assert.ok(metrics.uptime > 0);
    });

    test('should provide resilience metrics', async () => {
      const metrics = server.getResilienceMetrics();
      
      assert.ok(metrics.resilience);
      assert.ok(metrics.resilience.timeout);
      assert.ok(metrics.resilience.circuitBreaker);
      assert.ok(metrics.resilience.retry);
      assert.strictEqual(typeof metrics.resilience.timeout.enabled, 'boolean');
    });

    test('should track method-specific bulkhead metrics', async () => {
      const metrics = server.getMetrics();
      assert.ok(metrics.methodBulkheads);
      assert.ok(metrics.methodBulkheads.counter);
      assert.strictEqual(metrics.methodBulkheads.counter.activeRequests, 0);
    });
  });

  describe('Health Check', () => {
    test('should provide health check endpoint', async () => {
      server = new Http2RPC({ port });
      server.addMethod('test', async () => 'ok');
      await server.start();
      
      // Simulate health check request
      const http2 = require('http2');
      const client = http2.connect(`http://localhost:${port}`);
      
      return new Promise((resolve, reject) => {
        const req = client.request({
          ':method': 'GET',
          ':path': '/health-check'
        });
        
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => {
          client.close();
          const response = JSON.parse(data);
          
          assert.strictEqual(response.data.status, 'ok');
          assert.strictEqual(response.data.rpc.mode, 'server');
          assert.ok(Array.isArray(response.data.methods));
          resolve();
        });
        req.on('error', reject);
        req.end();
      });
    });
  });

  describe('CORS Support', () => {
    test('should handle OPTIONS requests', async () => {
      server = new Http2RPC({ port, cors: true });
      await server.start();
      
      const http2 = require('http2');
      const client = http2.connect(`http://localhost:${port}`);
      
      return new Promise((resolve, reject) => {
        const req = client.request({
          ':method': 'OPTIONS',
          ':path': '/test'
        });
        
        req.on('response', (headers) => {
          client.close();
          assert.strictEqual(headers[':status'], 200);
          assert.ok(headers['access-control-allow-origin']);
          resolve();
        });
        req.on('error', reject);
        req.end();
      });
    });
  });

  describe('Error Handling', () => {
    beforeEach(async () => {
      server = new Http2RPC({ port });
      await server.start();
    });

    test('should handle malformed JSON', async () => {
      const http2 = require('http2');
      const client = http2.connect(`http://localhost:${port}`);
      
      return new Promise((resolve, reject) => {
        const req = client.request({
          ':method': 'POST',
          ':path': '/test',
          'content-type': 'application/json'
        });
        
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => {
          client.close();
          const response = JSON.parse(data);
          assert.strictEqual(response.error, 'INVALID_JSON');
          resolve();
        });
        req.on('error', reject);
        
        req.write('invalid json');
        req.end();
      });
    });

    test('should handle large payloads', async () => {
      const http2 = require('http2');
      const client = http2.connect(`http://localhost:${port}`);
      
      return new Promise((resolve, reject) => {
        const req = client.request({
          ':method': 'POST',
          ':path': '/test',
          'content-type': 'application/json'
        });
        
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => {
          client.close();
          const response = JSON.parse(data);
          assert.strictEqual(response.error, 'PAYLOAD_TOO_LARGE');
          resolve();
        });
        req.on('error', reject);
        
        // Send payload larger than 1MB
        const largePayload = 'x'.repeat(1024 * 1024 + 1);
        req.write(largePayload);
        req.end();
      });
    });
  });
});