const http2 = require('http2');
const url = require('url');
const crypto = require('crypto');
const pino = require('pino');

// Constants
const DEFAULTS = {
  PORT: 3000,
  HOST: 'localhost',
  MAX_REQUEST_SIZE: 1024 * 1024, // 1MB
  DEFAULT_TIMEOUT: 30000,
  CONNECTION_TIMEOUT: 5000,
  SHUTDOWN_TIMEOUT: 5000,
  LOG_LEVEL: 'info',
  JWT_ALGORITHM: 'RS256',
  CORS_METHODS: 'GET, POST, OPTIONS',
  CORS_HEADERS: 'Content-Type, Authorization',
  RESILIENCE: {
    TIMEOUT: {
      REQUEST: 30000,
      CONNECTION: 5000
    },
    CIRCUIT_BREAKER: {
      FAILURE_THRESHOLD: 5,
      RECOVERY_TIMEOUT: 10000,
      SUCCESS_THRESHOLD: 3
    },
    RETRY: {
      MAX_RETRIES: 3,
      INITIAL_DELAY: 500,
      MAX_DELAY: 5000,
      BACKOFF_FACTOR: 2,
      RETRY_ON: [500, 502, 503, 504],
      JITTER: true
    },
    BULKHEAD: {
      MAX_CONCURRENT: 10,
      MAX_QUEUE: 20,
      QUEUE_TIMEOUT: 10000
    }
  }
};

// Validation helpers
const validators = {
  isString: (value) => typeof value === 'string',
  isNumber: (value) => typeof value === 'number' && !isNaN(value),
  isFunction: (value) => typeof value === 'function',
  isObject: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  isNonEmptyString: (value) => typeof value === 'string' && value.trim().length > 0,
  isPositiveNumber: (value) => typeof value === 'number' && value > 0,
  isValidPort: (value) => Number.isInteger(value) && value > 0 && value <= 65535,
  isValidUrl: (value) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }
};

class Http2RPC {
  constructor(options = {}) {
    // Validate options
    this.#validateConstructorOptions(options);
    
    this.port = options.port || DEFAULTS.PORT;
    this.host = options.host || DEFAULTS.HOST;
    this._methods = {};
    this.server = null;
    
    // Logger configuration
    const loggerConfig = {
      title: this.constructor.name,
      level: 'info',
      isDev: true,
      ...options.logger
    };
    
    this.logger = this.#createLogger(loggerConfig);
    
    this.cors = options.cors !== false;
    this.corsOptions = {
      origin: '*',
      methods: 'GET, POST, OPTIONS',
      headers: 'Content-Type, Authorization',
      ...options.corsOptions
    };
    
    this.jwtAuth = options.jwtAuth || false;
    this.jwtPublicKey = options.jwtPublicKey || null;
    this.jwtIssuer = options.jwtIssuer || null;
    this.jwtAudience = options.jwtAudience || null;
    this.excludedPaths = new Set(['health-check', ...(options.excludedPaths || [])]);
    
    // Resilience patterns configuration
    this.resilience = {
      // Timeout pattern
      timeout: {
        enabled: true,
        requestTimeout: DEFAULTS.RESILIENCE.TIMEOUT.REQUEST,
        connectionTimeout: DEFAULTS.RESILIENCE.TIMEOUT.CONNECTION,
        ...options.resilience?.timeout
      },
      
      // Circuit breaker pattern
      circuitBreaker: {
        enabled: true,
        failureThreshold: DEFAULTS.RESILIENCE.CIRCUIT_BREAKER.FAILURE_THRESHOLD,
        recoveryTimeout: DEFAULTS.RESILIENCE.CIRCUIT_BREAKER.RECOVERY_TIMEOUT,
        successThreshold: DEFAULTS.RESILIENCE.CIRCUIT_BREAKER.SUCCESS_THRESHOLD,
        ...options.resilience?.circuitBreaker
      },
      
      // Enhanced retry pattern
      retry: {
        maxRetries: DEFAULTS.RESILIENCE.RETRY.MAX_RETRIES,
        initialDelay: DEFAULTS.RESILIENCE.RETRY.INITIAL_DELAY,
        maxDelay: DEFAULTS.RESILIENCE.RETRY.MAX_DELAY,
        backoffFactor: DEFAULTS.RESILIENCE.RETRY.BACKOFF_FACTOR,
        retryOn: [...DEFAULTS.RESILIENCE.RETRY.RETRY_ON],
        jitterEnabled: DEFAULTS.RESILIENCE.RETRY.JITTER,
        ...options.resilience?.retry,
        ...options.retryOptions       // Backward compatibility
      }
    };
    
    // Circuit breaker state management
    this.circuitBreakers = new Map(); // serviceUrl -> circuit state
    
    // Bulkhead state management (только для server-side методов)
    this.bulkheadState = {
      methods: new Map() // methodName -> { activeRequests, queuedRequests, config, rejectedRequests }
    };
    
    this.metrics = {
      requestCount: 0,
      errorCount: 0,
      averageResponseTime: 0,
      startTime: Date.now(),
      retryCount: 0,
      authFailures: 0,
      // Resilience metrics
      timeoutCount: 0,
      circuitBreakerTrips: 0,
      bulkheadRejections: 0,
      circuitBreakerState: {}
    };

    if (options.methods) {
      Object.entries(options.methods).forEach(([name, handler]) => {
        this.addMethod(name, handler);
      });
    }

    this._setupGracefulShutdown = this.#setupGracefulShutdown.bind(this);
    this._setupGracefulShutdown();
    
    // Start server only if methods are provided or explicitly requested
    const shouldStartServer = options.methods || options.startServer === true;
    if (shouldStartServer) {
      this.start();
    }
  }

  #createLogger(config) {
    const baseOptions = {
      name: config.title,
      level: config.level
    };

    if (config.isDev) {
      return pino({
        ...baseOptions,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'yyyy-mm-dd HH:MM:ss',
            ignore: 'pid,hostname'
          }
        }
      });
    }

    return pino(baseOptions);
  }

  #validateConstructorOptions(options) {
    if (!validators.isObject(options)) {
      throw new Error('Options must be an object');
    }
    
    if (options.port !== undefined && !validators.isValidPort(options.port)) {
      throw new Error('Port must be a valid port number (1-65535)');
    }
    
    if (options.host !== undefined && !validators.isNonEmptyString(options.host)) {
      throw new Error('Host must be a non-empty string');
    }
    
    if (options.methods !== undefined && !validators.isObject(options.methods)) {
      throw new Error('Methods must be an object');
    }
    
    if (options.jwtPublicKey !== undefined && !validators.isString(options.jwtPublicKey)) {
      throw new Error('JWT public key must be a string');
    }
    
    if (options.excludedPaths !== undefined && !Array.isArray(options.excludedPaths)) {
      throw new Error('Excluded paths must be an array');
    }
  }

  get methods() {
    return this._methods;
  }

  set methods(methodsObject) {
    if (typeof methodsObject !== 'object' || methodsObject === null) {
      throw new Error('Methods must be an object');
    }
    
    this._methods = {};
    Object.entries(methodsObject).forEach(([name, handler]) => {
      this.addMethod(name, handler);
    });
  }

  addMethod(name, handler, bulkheadConfig = {}) {
    // Enhanced validation
    if (!validators.isNonEmptyString(name)) {
      throw new Error('Method name must be a non-empty string');
    }
    if (!validators.isFunction(handler)) {
      throw new Error('Method handler must be a function');
    }
    if (!validators.isObject(bulkheadConfig)) {
      throw new Error('Bulkhead config must be an object');
    }
    
    // Check for method name conflicts
    if (this._methods[name]) {
      this.logger.warn({ methodName: name }, 'Overriding existing method');
    }
    
    // Default per-method bulkhead configuration with constants
    const defaultConfig = {
      enabled: true,
      maxConcurrentRequests: DEFAULTS.RESILIENCE.BULKHEAD.MAX_CONCURRENT,
      maxQueueSize: DEFAULTS.RESILIENCE.BULKHEAD.MAX_QUEUE,
      queueTimeout: DEFAULTS.RESILIENCE.BULKHEAD.QUEUE_TIMEOUT
    };
    
    const methodBulkhead = { ...defaultConfig, ...bulkheadConfig };
    
    // Validate bulkhead configuration
    if (methodBulkhead.maxConcurrentRequests !== undefined && !validators.isPositiveNumber(methodBulkhead.maxConcurrentRequests)) {
      throw new Error('maxConcurrentRequests must be a positive number');
    }
    if (methodBulkhead.maxQueueSize !== undefined && !validators.isPositiveNumber(methodBulkhead.maxQueueSize)) {
      throw new Error('maxQueueSize must be a positive number');
    }
    if (methodBulkhead.queueTimeout !== undefined && !validators.isPositiveNumber(methodBulkhead.queueTimeout)) {
      throw new Error('queueTimeout must be a positive number');
    }
    
    // Initialize method bulkhead state
    this.bulkheadState.methods.set(name, {
      config: methodBulkhead,
      activeRequests: 0,
      queuedRequests: [],
      rejectedRequests: 0
    });
    
    this._methods[name] = handler;
    this.logger.info({ 
      method: name, 
      bulkhead: methodBulkhead 
    }, 'Method added with bulkhead configuration');
    
    return this;
  }

  // Resilience Pattern: Circuit Breaker
  #getCircuitBreakerState(serviceUrl) {
    if (!this.circuitBreakers.has(serviceUrl)) {
      this.circuitBreakers.set(serviceUrl, {
        state: 'CLOSED',        // CLOSED, OPEN, HALF_OPEN
        failureCount: 0,
        successCount: 0,
        lastFailureTime: 0,
        nextAttemptTime: 0
      });
    }
    return this.circuitBreakers.get(serviceUrl);
  }

  #updateCircuitBreakerOnSuccess(serviceUrl) {
    const circuit = this.#getCircuitBreakerState(serviceUrl);
    const config = this.resilience.circuitBreaker;
    
    if (circuit.state === 'HALF_OPEN') {
      circuit.successCount++;
      if (circuit.successCount >= config.successThreshold) {
        circuit.state = 'CLOSED';
        circuit.failureCount = 0;
        circuit.successCount = 0;
        this.logger.info({ serviceUrl }, 'Circuit breaker closed after successful recovery');
      }
    } else if (circuit.state === 'CLOSED') {
      circuit.failureCount = 0; // Reset failure count on success
    }
  }

  #updateCircuitBreakerOnFailure(serviceUrl, error) {
    const circuit = this.#getCircuitBreakerState(serviceUrl);
    const config = this.resilience.circuitBreaker;
    
    circuit.failureCount++;
    circuit.lastFailureTime = Date.now();
    circuit.successCount = 0;
    
    if (circuit.state === 'CLOSED' && circuit.failureCount >= config.failureThreshold) {
      circuit.state = 'OPEN';
      circuit.nextAttemptTime = Date.now() + config.recoveryTimeout;
      this.metrics.circuitBreakerTrips++;
      this.logger.warn({
        serviceUrl,
        failureCount: circuit.failureCount,
        error: error.message
      }, 'Circuit breaker opened due to failures');
    } else if (circuit.state === 'HALF_OPEN') {
      circuit.state = 'OPEN';
      circuit.nextAttemptTime = Date.now() + config.recoveryTimeout;
      this.logger.warn({ serviceUrl }, 'Circuit breaker reopened after half-open failure');
    }
  }

  #checkCircuitBreaker(serviceUrl) {
    if (!this.resilience.circuitBreaker.enabled) return { allowed: true };
    
    const circuit = this.#getCircuitBreakerState(serviceUrl);
    const now = Date.now();
    
    if (circuit.state === 'OPEN') {
      if (now >= circuit.nextAttemptTime) {
        circuit.state = 'HALF_OPEN';
        circuit.successCount = 0;
        this.logger.info({ serviceUrl }, 'Circuit breaker entering half-open state');
        return { allowed: true };
      }
      return { 
        allowed: false, 
        error: new Error(`Circuit breaker is OPEN for ${serviceUrl}`)
      };
    }
    
    return { allowed: true };
  }

  // Resilience Pattern: Bulkhead
  async #acquireMethodBulkheadPermit(methodName) {
    const methodState = this.bulkheadState.methods.get(methodName);
    if (!methodState || !methodState.config.enabled) {
      return { acquired: true };
    }
    
    const config = methodState.config;
    
    // Check if we can execute immediately
    if (methodState.activeRequests < config.maxConcurrentRequests) {
      methodState.activeRequests++;
      return { acquired: true };
    }
    
    // Try to queue the request
    if (methodState.queuedRequests.length < config.maxQueueSize) {
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          const index = methodState.queuedRequests.findIndex(item => item.resolve === resolve);
          if (index !== -1) {
            methodState.queuedRequests.splice(index, 1);
          }
          reject(new Error(`Method ${methodName} bulkhead queue timeout`));
        }, config.queueTimeout);
        
        methodState.queuedRequests.push({
          resolve: (result) => {
            clearTimeout(timeoutId);
            resolve(result);
          },
          reject: (error) => {
            clearTimeout(timeoutId);
            reject(error);
          }
        });
      });
    }
    
    // Reject if queue is full
    methodState.rejectedRequests++;
    this.metrics.bulkheadRejections++;
    throw new Error(`Method ${methodName} bulkhead capacity exceeded - request rejected`);
  }

  #releaseMethodBulkheadPermit(methodName) {
    const methodState = this.bulkheadState.methods.get(methodName);
    if (!methodState || !methodState.config.enabled) return;
    
    methodState.activeRequests--;
    
    // Process next request in queue
    if (methodState.queuedRequests.length > 0) {
      const next = methodState.queuedRequests.shift();
      methodState.activeRequests++;
      next.resolve({ acquired: true });
    }
  }

  // Resilience Pattern: Enhanced Retry with Jitter
  #calculateRetryDelay(attempt, config) {
    let delay = config.initialDelay * Math.pow(config.backoffFactor, attempt);
    delay = Math.min(delay, config.maxDelay);
    
    if (config.jitterEnabled) {
      // Add ±25% jitter to prevent thundering herd
      const jitter = delay * 0.25 * (Math.random() - 0.5) * 2;
      delay += jitter;
    }
    
    return Math.max(delay, 0);
  }

  // Resilience Pattern: Timeout
  #createTimeoutPromise(timeout, operation) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.metrics.timeoutCount++;
        reject(new Error(`Request timeout after ${timeout}ms`));
      }, timeout);
      
      operation.then(
        (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      );
    });
  }

  async request(serviceUrl, methodName, params = {}, options = {}) {
    // Enhanced validation
    if (!validators.isNonEmptyString(serviceUrl)) {
      throw new Error('Service URL must be a non-empty string');
    }
    if (!validators.isValidUrl(serviceUrl)) {
      throw new Error('Service URL must be a valid URL');
    }
    if (!validators.isNonEmptyString(methodName)) {
      throw new Error('Method name must be a non-empty string');
    }
    if (!validators.isObject(params)) {
      throw new Error('Params must be an object');
    }
    if (!validators.isObject(options)) {
      throw new Error('Options must be an object');
    }
    
    // Merge resilience configuration
    const retryConfig = { ...this.resilience.retry, ...options.retryOptions, ...options };
    const { maxRetries, retryOn } = retryConfig;
    
    this.logger.info({
      serviceUrl,
      methodName,
      paramsKeys: Object.keys(params),
      resilience: {
        timeoutEnabled: this.resilience.timeout.enabled,
        retryEnabled: maxRetries > 0,
        circuitBreakerEnabled: this.resilience.circuitBreaker.enabled
      }
    }, 'Initiating resilient RPC request');
    
    // Step 1: Circuit Breaker Pattern - Check if service is available
    const circuitCheck = this.#checkCircuitBreaker(serviceUrl);
    if (!circuitCheck.allowed) {
      this.logger.warn({ serviceUrl, methodName }, 'Circuit breaker blocked request');
      throw circuitCheck.error;
    }
    
    let lastError;
    
    // Step 2 & 3: Enhanced Retry Pattern with Timeout
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = this.#calculateRetryDelay(attempt - 1, retryConfig);
          this.logger.info({
            attempt,
            maxRetries,
            methodName,
            delay,
            withJitter: retryConfig.jitterEnabled
          }, 'Retrying request after enhanced delay');
          await this.#sleep(delay);
          this.metrics.retryCount++;
        }

        // Execute request with timeout wrapper
        const requestPromise = this.#makeRequest(serviceUrl, methodName, params, options);
        const result = this.resilience.timeout.enabled 
          ? await this.#createTimeoutPromise(this.resilience.timeout.requestTimeout, requestPromise)
          : await requestPromise;
        
        // Success: Update circuit breaker and return result
        this.#updateCircuitBreakerOnSuccess(serviceUrl);
        
        if (attempt > 0) {
          this.logger.info({ 
            attempt: attempt + 1, 
            methodName, 
            serviceUrl 
          }, 'Request succeeded after retry with resilience patterns');
        }
        
        this.logger.debug({
          serviceUrl,
          methodName,
          resultType: typeof result,
          resultKeys: result && typeof result === 'object' ? Object.keys(result) : null,
          circuitBreakerState: this.#getCircuitBreakerState(serviceUrl).state
        }, 'Resilient request completed successfully');
        
        return result;
        
      } catch (error) {
        lastError = error;
        
        // Update circuit breaker on failure
        this.#updateCircuitBreakerOnFailure(serviceUrl, error);
        
        // Check if we should continue retrying
        if (attempt === maxRetries) break;
        
        const shouldRetry = this.#shouldRetry(error, retryOn);
        if (!shouldRetry) {
          this.logger.warn({
            methodName,
            serviceUrl,
            errorMessage: error.message,
            errorCode: error.code,
            errorStatus: error.status,
            circuitBreakerState: this.#getCircuitBreakerState(serviceUrl).state
          }, 'Request failed, retry not applicable for error type');
          break;
        }
        
        this.logger.warn({
          methodName,
          serviceUrl,
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1,
          errorMessage: error.message,
          errorCode: error.code,
          errorStatus: error.status,
          isTimeout: error.message?.includes('timeout'),
          circuitBreakerState: this.#getCircuitBreakerState(serviceUrl).state
        }, 'Request attempt failed, will retry with resilience patterns');
      }
    }

    // All retries exhausted
    this.logger.error({
      methodName,
      serviceUrl,
      totalAttempts: maxRetries + 1,
      finalError: {
        message: lastError.message,
        code: lastError.code,
        status: lastError.status
      },
      circuitBreakerState: this.#getCircuitBreakerState(serviceUrl).state,
      resilience: {
        timeoutCount: this.metrics.timeoutCount,
        circuitBreakerTrips: this.metrics.circuitBreakerTrips
      }
    }, 'Resilient request failed after all retry attempts');
    
    throw lastError;
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.logger.info({
        port: this.port,
        host: this.host,
        methodsCount: Object.keys(this._methods).length,
        methods: Object.keys(this._methods),
        corsEnabled: this.cors,
        jwtAuthEnabled: this.jwtAuth
      }, 'Initializing HTTP/2 RPC server');

      this.server = http2.createServer((req, res) => {
        this.#handleRequest(req, res);
      });

      this.server.on('error', (error) => {
        this.logger.error({
          errorMessage: error.message,
          errorCode: error.code,
          port: this.port,
          host: this.host
        }, 'Server initialization failed');
        reject(error);
      });

      this.server.listen(this.port, this.host, () => {
        this.logger.info({
          host: this.host,
          port: this.port,
          methodsAvailable: Object.keys(this._methods).length
        }, 'HTTP/2 RPC server started successfully');
        
        if (this.jwtAuth) {
          this.logger.info({
            issuer: this.jwtIssuer,
            audience: this.jwtAudience,
            excludedPaths: Array.from(this.excludedPaths)
          }, 'JWT RS256 authentication enabled');
        }
        resolve(this.server);
      });
    });
  }

  async stop(timeout = DEFAULTS.SHUTDOWN_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        this.logger.debug('Stop called but server is not running');
        resolve();
        return;
      }

      this.logger.info({ timeout }, 'Initiating server shutdown');
      
      const forceShutdown = setTimeout(() => {
        this.logger.warn({ timeout }, 'Force closing server due to timeout exceeded');
        this.server.close();
        resolve();
      }, timeout);

      this.server.close((err) => {
        clearTimeout(forceShutdown);
        if (err) {
          this.logger.error({ error: err.message }, 'Error occurred during server shutdown');
          reject(err);
        } else {
          this.logger.info('Server stopped gracefully');
          resolve();
        }
      });
    });
  }

  getMetrics() {
    // Update circuit breaker states in metrics
    this.metrics.circuitBreakerState = {};
    for (const [serviceUrl, state] of this.circuitBreakers) {
      this.metrics.circuitBreakerState[serviceUrl] = {
        state: state.state,
        failureCount: state.failureCount,
        successCount: state.successCount,
        lastFailureTime: state.lastFailureTime
      };
    }
    
    // Collect per-method bulkhead stats (только server-side)
    const methodBulkheads = {};
    for (const [methodName, methodState] of this.bulkheadState.methods) {
      methodBulkheads[methodName] = {
        activeRequests: methodState.activeRequests,
        queuedRequests: methodState.queuedRequests.length,
        rejectedRequests: methodState.rejectedRequests,
        config: methodState.config
      };
    }
    
    return {
      ...this.metrics,
      uptime: Date.now() - this.metrics.startTime,
      // Только per-method bulkheads (server-side)
      methodBulkheads: methodBulkheads
    };
  }

  // Get resilience-specific metrics
  getResilienceMetrics() {
    const metrics = this.getMetrics();
    return {
      resilience: {
        timeout: {
          enabled: this.resilience.timeout.enabled,
          requestTimeout: this.resilience.timeout.requestTimeout,
          timeoutCount: metrics.timeoutCount
        },
        circuitBreaker: {
          enabled: this.resilience.circuitBreaker.enabled,
          trips: metrics.circuitBreakerTrips,
          states: metrics.circuitBreakerState
        },
        methodBulkheads: metrics.methodBulkheads,
        bulkheadRejections: metrics.bulkheadRejections,
        retry: {
          enabled: this.resilience.retry.maxRetries > 0,
          maxRetries: this.resilience.retry.maxRetries,
          jitterEnabled: this.resilience.retry.jitterEnabled,
          totalRetries: metrics.retryCount
        }
      }
    };
  }

  // Reset circuit breaker for a specific service
  resetCircuitBreaker(serviceUrl) {
    if (this.circuitBreakers.has(serviceUrl)) {
      const circuit = this.circuitBreakers.get(serviceUrl);
      circuit.state = 'CLOSED';
      circuit.failureCount = 0;
      circuit.successCount = 0;
      circuit.lastFailureTime = 0;
      circuit.nextAttemptTime = 0;
      
      this.logger.info({ serviceUrl }, 'Circuit breaker manually reset to CLOSED state');
    }
  }

  #formatResponse(data, error = null) {
    return error ? { error: error.code, message: error.message, ...error.extra } : { data };
  }

  #sendResponse(res, statusCode, responseData) {
    this.#setCorsHeaders(res);
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseData));
  }

  #setCorsHeaders(res) {
    if (!this.cors) return;
    
    res.setHeader('Access-Control-Allow-Origin', this.corsOptions.origin);
    res.setHeader('Access-Control-Allow-Methods', this.corsOptions.methods);
    res.setHeader('Access-Control-Allow-Headers', this.corsOptions.headers);
  }

  #validateJWT(token) {
    if (!this.jwtAuth || !this.jwtPublicKey) return true;
    
    try {
      const [headerB64, payloadB64, signatureB64] = token.split('.');
      if (!headerB64 || !payloadB64 || !signatureB64) {
        this.logger.warn({ tokenLength: token.length }, 'JWT token has invalid format');
        throw new Error('Invalid token format');
      }

      const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

      this.logger.debug({
        algorithm: header.alg,
        issuer: payload.iss,
        audience: payload.aud,
        expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : 'N/A',
        notBefore: payload.nbf ? new Date(payload.nbf * 1000).toISOString() : 'N/A'
      }, 'JWT token validation details');

      if (header.alg !== DEFAULTS.JWT_ALGORITHM) {
        this.logger.warn({
          expectedAlg: DEFAULTS.JWT_ALGORITHM,
          actualAlg: header.alg
        }, 'JWT algorithm validation failed');
        throw new Error('Invalid algorithm');
      }

      const signatureData = `${headerB64}.${payloadB64}`;
      const signature = Buffer.from(signatureB64, 'base64url');
      
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(signatureData);
      
      if (!verifier.verify(this.jwtPublicKey, signature)) {
        this.logger.warn('JWT signature verification failed');
        throw new Error('Invalid signature');
      }

      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) {
        this.logger.warn({
          expiresAt: new Date(payload.exp * 1000).toISOString(),
          currentTime: new Date().toISOString()
        }, 'JWT token has expired');
        throw new Error('Token expired');
      }
      
      if (payload.nbf && payload.nbf > now) {
        this.logger.warn({
          notBefore: new Date(payload.nbf * 1000).toISOString(),
          currentTime: new Date().toISOString()
        }, 'JWT token not yet valid');
        throw new Error('Token not yet valid');
      }

      if (this.jwtIssuer && payload.iss !== this.jwtIssuer) {
        this.logger.warn({
          expectedIssuer: this.jwtIssuer,
          actualIssuer: payload.iss
        }, 'JWT issuer validation failed');
        throw new Error('Invalid issuer');
      }
      
      if (this.jwtAudience && payload.aud !== this.jwtAudience) {
        this.logger.warn({
          expectedAudience: this.jwtAudience,
          actualAudience: payload.aud
        }, 'JWT audience validation failed');
        throw new Error('Invalid audience');
      }

      this.logger.debug('JWT token validated successfully');
      return { valid: true, payload };
    } catch (error) {
      this.logger.warn({
        errorMessage: error.message,
        errorType: error.constructor.name
      }, 'JWT token validation failed');
      return { valid: false, error: error.message };
    }
  }

  #checkAuth(req, pathname) {
    if (!this.jwtAuth || this.excludedPaths.has(pathname)) {
      return { authorized: true };
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { authorized: false, error: 'Missing or invalid Authorization header' };
    }

    const token = authHeader.substring(7);
    const validation = this.#validateJWT(token);
    
    if (!validation.valid) {
      this.metrics.authFailures++;
      return { authorized: false, error: validation.error };
    }

    return { authorized: true, user: validation.payload };
  }

  #handleHealthCheck(res) {
    const uptime = Date.now() - this.metrics.startTime;
    
    // Определяем режим работы RPC
    const hasServerMethods = Object.keys(this._methods).length > 0;
    const isServerRunning = this.server && this.server.listening;
    
    let rpcStatus;
    if (hasServerMethods) {
      // Режим сервера или клиент+сервер - нужен запущенный сервер
      rpcStatus = isServerRunning ? {
        status: "ok",
        mode: "server",
        details: "RPC server is running and accepting requests"
      } : {
        status: "error", 
        error: "RPC server is not initialized",
        details: "RPC server is not available",
        critical: true
      };
    } else {
      // Режим только клиента - сервер не нужен
      rpcStatus = {
        status: "ok",
        mode: "client-only", 
        details: "RPC client mode - server not required"
      };
    }
    
    const healthData = {
      status: 'ok',
      uptime: uptime,
      timestamp: new Date().toISOString(),
      rpc: rpcStatus,
      metrics: this.metrics,
      methods: Object.keys(this._methods),
      auth: this.jwtAuth ? 'JWT RS256' : 'disabled'
    };
    
    this.logger.debug({ healthData }, 'Health check requested');
    const successResponse = this.#formatResponse(healthData);
    this.#sendResponse(res, 200, successResponse);
  }

  #updateMetrics(responseTime, isError = false) {
    this.metrics.requestCount++;
    if (isError) this.metrics.errorCount++;
    
    this.metrics.averageResponseTime = 
      (this.metrics.averageResponseTime * (this.metrics.requestCount - 1) + responseTime) / 
      this.metrics.requestCount;
  }

  #handleRequest(req, res) {
    const startTime = Date.now();
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname.slice(1);

    this.logger.debug({
      method: req.method,
      url: req.url,
      pathname,
      userAgent: req.headers['user-agent']
    }, 'Incoming request');

    if (req.method === 'OPTIONS') {
      this.#setCorsHeaders(res);
      res.writeHead(200);
      res.end();
      return;
    }

    if (pathname === 'health-check') {
      this.#handleHealthCheck(res);
      return;
    }

    const authResult = this.#checkAuth(req, pathname);
    if (!authResult.authorized) {
      this.logger.warn({
        pathname,
        authError: authResult.error,
        userAgent: req.headers['user-agent']
      }, 'Authorization failed for request');
      
      const errorResponse = this.#formatResponse(null, { 
        code: 'UNAUTHORIZED', 
        message: authResult.error 
      });
      this.#sendResponse(res, 401, errorResponse);
      this.#updateMetrics(Date.now() - startTime, true);
      return;
    }

    let body = '';
    let requestProcessed = false;

    req.on('error', (error) => {
      this.logger.error({
        error: error.message,
        pathname,
        requestUrl: req.url
      }, 'Request stream error occurred');
      
      if (!requestProcessed && !res.headersSent) {
        requestProcessed = true;
        const errorResponse = this.#formatResponse(null, { 
          code: 'BAD_REQUEST', 
          message: 'Bad request', 
          extra: { details: error.message } 
        });
        this.#sendResponse(res, 400, errorResponse);
        this.#updateMetrics(Date.now() - startTime, true);
      }
    });

    req.on('data', chunk => { 
      body += chunk.toString(); 
      if (body.length > DEFAULTS.MAX_REQUEST_SIZE) {
        if (!requestProcessed && !res.headersSent) {
          requestProcessed = true;
          this.logger.warn({
            pathname,
            bodySize: body.length,
            maxSize: 1024 * 1024
          }, 'Request payload too large');
          
          const errorResponse = this.#formatResponse(null, { 
            code: 'PAYLOAD_TOO_LARGE', 
            message: 'Request too large', 
            extra: { 
              maxSize: '1MB',
              currentSize: `${Math.round(body.length / 1024)}KB`
            } 
          });
          this.#sendResponse(res, 413, errorResponse);
          this.#updateMetrics(Date.now() - startTime, true);
        }
        req.destroy();
      }
    });

    req.on('end', async () => {
      if (requestProcessed) return;
      
      try {
        const method = this._methods[pathname];
        if (!method) {
          this.logger.warn({
            requestedMethod: pathname,
            availableMethods: Object.keys(this._methods)
          }, 'Method not found');
          
          const errorResponse = this.#formatResponse(null, { 
            code: 'METHOD_NOT_FOUND', 
            message: 'Method not found', 
            extra: {
              method: pathname,
              availableMethods: Object.keys(this._methods)
            } 
          });
          this.#sendResponse(res, 404, errorResponse);
          this.#updateMetrics(Date.now() - startTime, true);
          return;
        }

        let params = {};
        if (body) {
          try {
            params = JSON.parse(body);
          } catch (parseError) {
            this.logger.error({
              parseError: parseError.message,
              bodyLength: body.length,
              pathname
            }, 'JSON parsing failed for request body');
            
            const errorResponse = this.#formatResponse(null, { 
              code: 'INVALID_JSON', 
              message: 'Invalid JSON format', 
              extra: { details: parseError.message } 
            });
            this.#sendResponse(res, 400, errorResponse);
            this.#updateMetrics(Date.now() - startTime, true);
            return;
          }
        }

        if (authResult.user) {
          params._user = authResult.user;
        }

        this.logger.info({
          method: pathname,
          paramsKeys: Object.keys(params).filter(k => k !== '_user'),
          hasUser: !!authResult.user
        }, 'Executing method');
        
        // === ADD PER-METHOD BULKHEAD HERE ===
        
        // Step 1: Acquire method bulkhead permit
        let methodBulkheadPermit;
        try {
          methodBulkheadPermit = await this.#acquireMethodBulkheadPermit(pathname);
        } catch (bulkheadError) {
          this.logger.warn({ 
            method: pathname, 
            error: bulkheadError.message 
          }, 'Method bulkhead rejected request');
          
          const errorResponse = this.#formatResponse(null, {
            code: 'METHOD_BULKHEAD_EXCEEDED',
            message: `Method ${pathname} is overloaded`,
            extra: { method: pathname, reason: 'bulkhead_capacity_exceeded' }
          });
          this.#sendResponse(res, 503, errorResponse);
          this.#updateMetrics(Date.now() - startTime, true);
          return;
        }

        try {
          // Step 2: Execute method with bulkhead protection
          this.logger.info({
            method: pathname,
            methodBulkhead: this.getMethodBulkheadStatus(pathname)
          }, 'Executing method with bulkhead protection');
          
          const result = await method(params);

          const successResponse = this.#formatResponse(result);
          this.#sendResponse(res, 200, successResponse);
          this.#updateMetrics(Date.now() - startTime);
          
          this.logger.debug({
            method: pathname,
            responseTime: Date.now() - startTime,
            resultType: typeof result,
            methodBulkhead: this.getMethodBulkheadStatus(pathname)
          }, 'Method executed successfully with bulkhead');
          
        } finally {
          // Step 3: Always release method bulkhead permit
          this.#releaseMethodBulkheadPermit(pathname);
        }

      } catch (error) {
        this.logger.error({
          method: pathname,
          error: error.message,
          stack: error.stack
        }, 'Unhandled error in request processing');
        
        if (!res.headersSent) {
          const errorResponse = this.#formatResponse(null, { 
            code: 'INTERNAL_ERROR', 
            message: 'Internal server error', 
            extra: { details: error.message } 
          });
          this.#sendResponse(res, 500, errorResponse);
          this.#updateMetrics(Date.now() - startTime, true);
        }
      }
    });
  }

  // Missing helper methods
  async #makeRequest(serviceUrl, methodName, params, options) {
    const url = new URL(serviceUrl);
    const postData = JSON.stringify(params);
    
    const requestOptions = {
      ':method': 'POST',
      ':path': `/${methodName}`,
      ':scheme': url.protocol.slice(0, -1),
      ':authority': url.host,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(postData)
    };

    if (options.token) {
      requestOptions['authorization'] = `Bearer ${options.token}`;
    }

    return new Promise((resolve, reject) => {
      const http2 = require('http2');
      let client;
      let connectionTimeout;
      let requestTimeout;
      
      try {
        client = http2.connect(serviceUrl);
        
        connectionTimeout = setTimeout(() => {
          if (client && !client.destroyed) {
            client.destroy();
          }
          reject(new Error(`Connection timeout after ${this.resilience.timeout.connectionTimeout}ms`));
        }, this.resilience.timeout.connectionTimeout);

        client.on('error', (error) => {
          clearTimeout(connectionTimeout);
          clearTimeout(requestTimeout);
          reject(error);
        });

        client.on('connect', () => {
          clearTimeout(connectionTimeout);
          
          const req = client.request(requestOptions);
          
          requestTimeout = setTimeout(() => {
            req.destroy();
            if (client && !client.destroyed) {
              client.destroy();
            }
            reject(new Error(`Request timeout after ${this.resilience.timeout.requestTimeout}ms`));
          }, this.resilience.timeout.requestTimeout);

          let data = '';
          req.setEncoding('utf8');

          req.on('data', (chunk) => {
            data += chunk;
          });

          req.on('end', () => {
            clearTimeout(requestTimeout);
            
            // Close client after a small delay to ensure all data is received
            setTimeout(() => {
              if (client && !client.destroyed) {
                client.destroy();
              }
            }, 10);
            
            try {
              if (!data) {
                reject(new Error('Empty response from server'));
                return;
              }
              
              const response = JSON.parse(data);
              if (response.error) {
                const error = new Error(response.message || 'RPC Error');
                error.code = response.error;
                error.status = response.status || 500;
                reject(error);
              } else {
                resolve(response.data);
              }
            } catch (parseError) {
              reject(new Error(`Invalid JSON response: ${parseError.message}`));
            }
          });

          req.on('error', (error) => {
            clearTimeout(requestTimeout);
            if (client && !client.destroyed) {
              client.destroy();
            }
            reject(error);
          });

          // Write data and end request
          req.write(postData);
          req.end();
        });

      } catch (error) {
        clearTimeout(connectionTimeout);
        clearTimeout(requestTimeout);
        if (client && !client.destroyed) {
          client.destroy();
        }
        reject(error);
      }
    });
  }

  #shouldRetry(error, retryOn) {
    if (!retryOn || retryOn.length === 0) return false;
    
    // Check status code
    if (error.status && retryOn.includes(error.status)) {
      return true;
    }
    
    // Check error code
    if (error.code && retryOn.includes(error.code)) {
      return true;
    }
    
    // Check for timeout errors
    if (retryOn.includes('ETIMEDOUT') && error.message?.includes('timeout')) {
      return true;
    }
    
    return false;
  }

  #sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getMethodBulkheadStatus(methodName) {
    const methodState = this.bulkheadState.methods.get(methodName);
    if (!methodState) {
      return { error: 'Method not found' };
    }
    
    return {
      methodName,
      config: methodState.config,
      activeRequests: methodState.activeRequests,
      queuedRequests: methodState.queuedRequests.length,
      rejectedRequests: methodState.rejectedRequests
    };
  }

  #setupGracefulShutdown() {
    // Only setup signal handlers if we're not in test environment
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    
    const shutdown = async (signal) => {
      this.logger.info({ signal }, 'Received shutdown signal, starting graceful shutdown');
      
      try {
        await this.stop();
        this.logger.info('Graceful shutdown completed');
        process.exit(0);
      } catch (error) {
        this.logger.error({ error: error.message }, 'Error during graceful shutdown');
        process.exit(1);
      }
    };

    // Store the handlers for potential cleanup
    this._shutdownHandlers = {
      sigterm: () => shutdown('SIGTERM'),
      sigint: () => shutdown('SIGINT')
    };

    process.on('SIGTERM', this._shutdownHandlers.sigterm);
    process.on('SIGINT', this._shutdownHandlers.sigint);
  }
}

module.exports = Http2RPC;