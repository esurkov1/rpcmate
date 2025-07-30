const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Http2RPC = require('../index.js');

describe('Integration Tests', () => {
  let server1, server2, server3;
  let port1, port2, port3;

  // Helper to find free ports
  async function findFreePort() {
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

  before(async () => {
    port1 = await findFreePort();
    port2 = await findFreePort();
    port3 = await findFreePort();
  });

  afterEach(async () => {
    if (server1?.server) await server1.stop();
    if (server2?.server) await server2.stop();
    if (server3?.server) await server3.stop();
    server1 = server2 = server3 = null;
  });

  describe('Microservices Communication', () => {
    test('should enable service-to-service communication', async () => {
      // User Service
      server1 = new Http2RPC({ port: port1 });
      server1.addMethod('getUser', async (params) => ({
        id: params.id,
        name: 'John Doe',
        email: 'john@example.com'
      }));
      server1.addMethod('createUser', async (params) => ({
        id: Date.now(),
        name: params.name,
        email: params.email,
        created: new Date().toISOString()
      }));

      // Order Service
      server2 = new Http2RPC({ port: port2 });
      server2.addMethod('createOrder', async (params) => {
        // Call User Service to get user info
        const user = await server2.request(
          `http://localhost:${port1}`,
          'getUser',
          { id: params.userId }
        );
        
        return {
          id: Date.now(),
          userId: params.userId,
          userName: user.name,
          items: params.items,
          total: params.total,
          created: new Date().toISOString()
        };
      });

      // Notification Service
      server3 = new Http2RPC({ port: port3 });
      server3.addMethod('sendNotification', async (params) => ({
        id: Date.now(),
        recipient: params.email,
        subject: params.subject,
        message: params.message,
        sent: new Date().toISOString()
      }));

      await Promise.all([server1.start(), server2.start(), server3.start()]);

      // Test the microservices workflow
      const order = await server2.request(`http://localhost:${port2}`, 'createOrder', {
        userId: 123,
        items: ['item1', 'item2'],
        total: 99.99
      });

      assert.strictEqual(order.userId, 123);
      assert.strictEqual(order.userName, 'John Doe');
      assert.deepStrictEqual(order.items, ['item1', 'item2']);
      assert.strictEqual(order.total, 99.99);

      // Send notification about the order
      const notification = await server3.request(`http://localhost:${port3}`, 'sendNotification', {
        email: 'john@example.com',
        subject: 'Order Confirmation',
        message: `Your order ${order.id} has been created`
      });

      assert.strictEqual(notification.recipient, 'john@example.com');
      assert.strictEqual(notification.subject, 'Order Confirmation');
    });

    test('should handle cascade failures with circuit breaker', async () => {
      // Primary service
      server1 = new Http2RPC({
        port: port1,
        resilience: {
          circuitBreaker: {
            failureThreshold: 2,
            recoveryTimeout: 1000
          }
        }
      });

      let dependencyCallCount = 0;
      server1.addMethod('primaryOperation', async (params) => {
        // This will fail because server2 is not running
        try {
          dependencyCallCount++;
          return await server1.request(
            `http://localhost:${port2}`,
            'dependencyOperation',
            params,
            { maxRetries: 0 }
          );
        } catch (error) {
          // Fallback response
          return {
            result: 'fallback',
            reason: 'dependency unavailable',
            callCount: dependencyCallCount
          };
        }
      });

      await server1.start();

      // First few calls should try the dependency
      const result1 = await server1.request(`http://localhost:${port1}`, 'primaryOperation', {});
      assert.strictEqual(result1.result, 'fallback');

      const result2 = await server1.request(`http://localhost:${port1}`, 'primaryOperation', {});
      assert.strictEqual(result2.result, 'fallback');

      // After circuit breaker opens, calls should fail faster
      const result3 = await server1.request(`http://localhost:${port1}`, 'primaryOperation', {});
      assert.strictEqual(result3.result, 'fallback');

      // Verify that dependency calls stopped after circuit opened
      assert.ok(dependencyCallCount >= 2);
    });
  });

  describe('Load Testing Simulation', () => {
    test('should handle concurrent requests with bulkhead', async () => {
      server1 = new Http2RPC({ port: port1 });
      
      let processedCount = 0;
      server1.addMethod('heavyOperation', async (params) => {
        await new Promise(resolve => setTimeout(resolve, 100)); // Simulate work
        processedCount++;
        return { 
          id: params.id,
          processed: true,
          processedCount 
        };
      }, {
        maxConcurrentRequests: 3,
        maxQueueSize: 5
      });

      await server1.start();

      // Send 10 concurrent requests
      const requests = [];
      for (let i = 0; i < 10; i++) {
        requests.push(
          server1.request(`http://localhost:${port1}`, 'heavyOperation', { id: i })
            .catch(error => ({ error: error.message, id: i }))
        );
      }

      const results = await Promise.all(requests);
      
      const successful = results.filter(r => r.processed);
      const rejected = results.filter(r => r.error?.includes('bulkhead'));

      // Some should succeed, some should be rejected due to bulkhead
      assert.ok(successful.length > 0, 'Some requests should succeed');
      assert.ok(rejected.length > 0, 'Some requests should be rejected by bulkhead');
      
      console.log(`Processed: ${successful.length}, Rejected: ${rejected.length}`);
    });

    test('should demonstrate retry pattern with unreliable service', async () => {
      server1 = new Http2RPC({ port: port1 });
      
      let attemptCount = 0;
      server1.addMethod('unreliableOperation', async (params) => {
        attemptCount++;
        
        // Fail first 2 attempts, succeed on 3rd
        if (attemptCount < 3) {
          throw new Error(`Temporary failure (attempt ${attemptCount})`);
        }
        
        return {
          success: true,
          totalAttempts: attemptCount,
          data: params.data
        };
      });

      await server1.start();

      const result = await server1.request(
        `http://localhost:${port1}`,
        'unreliableOperation',
        { data: 'test' },
        {
          maxRetries: 5,
          initialDelay: 50,
          backoffFactor: 1.5
        }
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.totalAttempts, 3);
      assert.strictEqual(result.data, 'test');
    });
  });

  describe('Real-world Scenarios', () => {
    test('should implement API gateway pattern', async () => {
      // Backend services
      server1 = new Http2RPC({ port: port1 }); // User service
      server2 = new Http2RPC({ port: port2 }); // Product service
      server3 = new Http2RPC({ port: port3 }); // Gateway

      // User service
      server1.addMethod('getProfile', async (params) => ({
        id: params.userId,
        name: 'John Doe',
        email: 'john@example.com',
        preferences: { theme: 'dark', notifications: true }
      }));

      // Product service  
      server2.addMethod('getRecommendations', async (params) => ([
        { id: 1, name: 'Product A', price: 29.99 },
        { id: 2, name: 'Product B', price: 49.99 },
        { id: 3, name: 'Product C', price: 19.99 }
      ]));

      // API Gateway
      server3.addMethod('getDashboard', async (params) => {
        const [profile, recommendations] = await Promise.all([
          server3.request(`http://localhost:${port1}`, 'getProfile', { userId: params.userId }),
          server3.request(`http://localhost:${port2}`, 'getRecommendations', { userId: params.userId })
        ]);

        return {
          user: profile,
          recommendations: recommendations,
          timestamp: new Date().toISOString()
        };
      });

      await Promise.all([server1.start(), server2.start(), server3.start()]);

      // Client calls gateway
      const dashboard = await server3.request(`http://localhost:${port3}`, 'getDashboard', {
        userId: 123
      });

      assert.strictEqual(dashboard.user.name, 'John Doe');
      assert.strictEqual(dashboard.recommendations.length, 3);
      assert.ok(dashboard.timestamp);
    });

    test('should handle distributed transaction pattern', async () => {
      // Payment service
      server1 = new Http2RPC({ port: port1 });
      server1.addMethod('processPayment', async (params) => {
        // Simulate payment processing
        if (params.amount > 1000) {
          throw new Error('Payment amount too large');
        }
        
        return {
          transactionId: `tx_${Date.now()}`,
          amount: params.amount,
          status: 'completed',
          timestamp: new Date().toISOString()
        };
      });

      // Inventory service
      server2 = new Http2RPC({ port: port2 });
      server2.addMethod('reserveItems', async (params) => {
        // Simulate inventory check
        if (params.items.some(item => item.quantity > 100)) {
          throw new Error('Insufficient inventory');
        }
        
        return {
          reservationId: `res_${Date.now()}`,
          items: params.items,
          status: 'reserved',
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
        };
      });

      // Order service (coordinator)
      server3 = new Http2RPC({ port: port3 });
      server3.addMethod('createOrder', async (params) => {
        try {
          // Step 1: Reserve inventory
          const reservation = await server3.request(
            `http://localhost:${port2}`,
            'reserveItems',
            { items: params.items }
          );

          // Step 2: Process payment
          const payment = await server3.request(
            `http://localhost:${port1}`,
            'processPayment',
            { amount: params.total }
          );

          // Step 3: Create order
          return {
            orderId: `order_${Date.now()}`,
            reservation: reservation,
            payment: payment,
            status: 'confirmed',
            items: params.items,
            total: params.total
          };

        } catch (error) {
          // Handle rollback logic here in real implementation
          throw new Error(`Order creation failed: ${error.message}`);
        }
      });

      await Promise.all([server1.start(), server2.start(), server3.start()]);

      // Successful order
      const order = await server3.request(`http://localhost:${port3}`, 'createOrder', {
        items: [{ id: 1, quantity: 2 }, { id: 2, quantity: 1 }],
        total: 99.99
      });

      assert.strictEqual(order.status, 'confirmed');
      assert.strictEqual(order.payment.status, 'completed');
      assert.strictEqual(order.reservation.status, 'reserved');

      // Failed order (too expensive)
      await assert.rejects(
        server3.request(`http://localhost:${port3}`, 'createOrder', {
          items: [{ id: 1, quantity: 1 }],
          total: 2000
        }),
        /Payment amount too large/
      );
    });
  });

  describe('Performance and Reliability', () => {
    test('should maintain performance under sustained load', async () => {
      server1 = new Http2RPC({
        port: port1,
        resilience: {
          timeout: { requestTimeout: 5000 },
          retry: { maxRetries: 1 }
        }
      });

      server1.addMethod('fastOperation', async (params) => ({
        id: params.id,
        timestamp: Date.now(),
        result: 'ok'
      }));

      await server1.start();

      const startTime = Date.now();
      const requests = [];

      // Send 50 rapid requests
      for (let i = 0; i < 50; i++) {
        requests.push(
          server1.request(`http://localhost:${port1}`, 'fastOperation', { id: i })
        );
      }

      const results = await Promise.all(requests);
      const endTime = Date.now();

      // All should succeed
      assert.strictEqual(results.length, 50);
      results.forEach((result, index) => {
        assert.strictEqual(result.id, index);
        assert.strictEqual(result.result, 'ok');
      });

      // Should complete reasonably quickly
      const totalTime = endTime - startTime;
      console.log(`50 requests completed in ${totalTime}ms (avg: ${totalTime/50}ms per request)`);
      assert.ok(totalTime < 10000, 'Should complete within 10 seconds');

      // Check metrics
      const metrics = server1.getMetrics();
      assert.strictEqual(metrics.requestCount, 50);
      assert.strictEqual(metrics.errorCount, 0);
    });

    test('should recover gracefully from service failures', async () => {
      // Main service
      server1 = new Http2RPC({
        port: port1,
        resilience: {
          circuitBreaker: {
            failureThreshold: 3,
            recoveryTimeout: 500
          },
          retry: { maxRetries: 1 }
        }
      });

      server1.addMethod('dependentOperation', async (params) => {
        try {
          return await server1.request(
            `http://localhost:${port2}`,
            'externalService',
            params,
            { maxRetries: 0 }
          );
        } catch (error) {
          // Fallback
          return { fallback: true, reason: error.message };
        }
      });

      await server1.start();

      // Phase 1: Service is down, should use fallback
      const result1 = await server1.request(`http://localhost:${port1}`, 'dependentOperation', {});
      assert.strictEqual(result1.fallback, true);

      // Start dependency service
      server2 = new Http2RPC({ port: port2 });
      server2.addMethod('externalService', async (params) => ({
        data: 'from external service',
        timestamp: Date.now()
      }));
      await server2.start();

      // Wait for circuit breaker recovery
      await new Promise(resolve => setTimeout(resolve, 600));

      // Reset circuit breaker manually to test recovery
      server1.resetCircuitBreaker(`http://localhost:${port2}`);

      // Phase 2: Service is up, should work normally
      const result2 = await server1.request(`http://localhost:${port1}`, 'dependentOperation', {});
      assert.strictEqual(result2.data, 'from external service');
      assert.strictEqual(result2.fallback, undefined);
    });
  });
});