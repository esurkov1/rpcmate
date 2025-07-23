const http2 = require('http2');
const url = require('url');
const crypto = require('crypto');

class Http2RPC {
  constructor(options = {}) {
    this.port = options.port || 3000;
    this.host = options.host || 'localhost';
    this._methods = {};
    this.server = null;
    
    this.logger = options.logger || console;
    
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
    
    this.retryOptions = {
      maxRetries: 3,
      initialDelay: 500,
      maxDelay: 10000,
      backoffFactor: 2,
      retryOn: [500, 502, 503, 504],
      ...options.retryOptions
    };
    
    this.metrics = {
      requestCount: 0,
      errorCount: 0,
      averageResponseTime: 0,
      startTime: Date.now(),
      retryCount: 0,
      authFailures: 0
    };

    if (options.methods) {
      Object.entries(options.methods).forEach(([name, handler]) => {
        this.addMethod(name, handler);
      });
    }

    this._setupGracefulShutdown();
    
    // Запускаем сервер только если есть методы или явно указано startServer: true
    const shouldStartServer = options.methods || options.startServer === true;
    if (shouldStartServer) {
      this.start();
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

  addMethod(name, handler) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('Method name must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new Error('Method handler must be a function');
    }
    
    this._methods[name] = handler;
    this.logger.info(`Added method: ${name}`);
    return this;
  }

  async request(serviceUrl, methodName, params = {}, options = {}) {
    const requestOptions = { ...this.retryOptions, ...options };
    const { maxRetries, initialDelay, maxDelay, backoffFactor, retryOn } = requestOptions;
    
    let lastError;
    let delay = initialDelay;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          this.logger.info(`Retry attempt ${attempt}/${maxRetries} for ${methodName} after ${delay}ms`);
          await this.#sleep(delay);
          delay = Math.min(delay * backoffFactor, maxDelay);
          this.metrics.retryCount++;
        }

        const result = await this.#makeRequest(serviceUrl, methodName, params, options);
        
        if (attempt > 0) {
          this.logger.info(`Request succeeded on attempt ${attempt + 1}`);
        }
        
        return result;
        
      } catch (error) {
        lastError = error;
        
        if (attempt === maxRetries) break;
        
        const shouldRetry = this.#shouldRetry(error, retryOn);
        if (!shouldRetry) {
          this.logger.info(`Not retrying due to error type: ${error.message}`);
          break;
        }
        
        this.logger.warn(`Request failed (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}`);
      }
    }

    this.logger.error(`Request failed after ${maxRetries + 1} attempts: ${lastError.message}`);
    throw lastError;
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.server = http2.createServer((req, res) => {
        this.#handleRequest(req, res);
      });

      this.server.on('error', (error) => {
        this.logger.error('Server error:', error);
        reject(error);
      });

      this.server.listen(this.port, this.host, () => {
        this.logger.info(`RPC Server running on ${this.host}:${this.port}`);
        if (this.jwtAuth) {
          this.logger.info('JWT RS256 authentication enabled');
        }
        resolve(this.server);
      });
    });
  }

  async stop(timeout = 5000) {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      const forceShutdown = setTimeout(() => {
        this.logger.warn('Force closing server due to timeout');
        this.server.close();
        resolve();
      }, timeout);

      this.server.close((err) => {
        clearTimeout(forceShutdown);
        if (err) {
          this.logger.error('Error during server shutdown:', err);
          reject(err);
        } else {
          this.logger.info('Server stopped gracefully');
          resolve();
        }
      });
    });
  }

  getMetrics() {
    return {
      ...this.metrics,
      uptime: Date.now() - this.metrics.startTime
    };
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
        throw new Error('Invalid token format');
      }

      const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

      if (header.alg !== 'RS256') {
        throw new Error('Invalid algorithm');
      }

      const signatureData = `${headerB64}.${payloadB64}`;
      const signature = Buffer.from(signatureB64, 'base64url');
      
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(signatureData);
      
      if (!verifier.verify(this.jwtPublicKey, signature)) {
        throw new Error('Invalid signature');
      }

      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) {
        throw new Error('Token expired');
      }
      
      if (payload.nbf && payload.nbf > now) {
        throw new Error('Token not yet valid');
      }

      if (this.jwtIssuer && payload.iss !== this.jwtIssuer) {
        throw new Error('Invalid issuer');
      }
      
      if (this.jwtAudience && payload.aud !== this.jwtAudience) {
        throw new Error('Invalid audience');
      }

      return { valid: true, payload };
    } catch (error) {
      this.logger.warn('JWT validation failed:', error.message);
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
    const healthData = {
      status: 'ok',
      uptime: uptime,
      timestamp: new Date().toISOString(),
      metrics: this.metrics,
      methods: Object.keys(this._methods),
      auth: this.jwtAuth ? 'JWT RS256' : 'disabled'
    };
    
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
      this.logger.error('Request error:', error);
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
      if (body.length > 1024 * 1024) {
        if (!requestProcessed && !res.headersSent) {
          requestProcessed = true;
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
            this.logger.error('JSON parse error:', parseError);
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

        this.logger.info(`Calling method: ${pathname}`, { ...params, _user: undefined });
        const result = await method(params);

        const successResponse = this.#formatResponse(result);
        this.#sendResponse(res, 200, successResponse);
        this.#updateMetrics(Date.now() - startTime);
        
      } catch (error) {
        this.logger.error('Method execution error:', error);
        if (!res.headersSent) {
          const errorResponse = this.#formatResponse(null, { 
            code: 'INTERNAL_ERROR', 
            message: 'Internal server error', 
            extra: {
              details: error.message,
              method: pathname
            } 
          });
          this.#sendResponse(res, 500, errorResponse);
        }
        this.#updateMetrics(Date.now() - startTime, true);
      }
    });
  }

  #setupGracefulShutdown() {
    const gracefulShutdown = async (signal) => {
      this.logger.info(`Received ${signal}, starting graceful shutdown...`);
      try {
        await this.stop();
        this.logger.info('Graceful shutdown completed');
        process.exit(0);
      } catch (error) {
        this.logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2'));
  }

  async #makeRequest(serviceUrl, methodName, params, options) {
    return new Promise((resolve, reject) => {
      const parsedUrl = url.parse(serviceUrl);
      const client = http2.connect(`${parsedUrl.protocol}//${parsedUrl.host}`);

      const headers = {
        ':method': 'POST',
        ':path': `/${methodName}`,
        'content-type': 'application/json'
      };

      if (options.token) {
        headers.authorization = `Bearer ${options.token}`;
      }

      const req = client.request(headers);
      let responseData = '';

      req.on('data', (chunk) => { responseData += chunk; });
      
      req.on('end', () => {
        client.close();
        try {
          const response = JSON.parse(responseData);
          resolve(response);
        } catch (error) {
          reject(new Error(`Failed to parse response: ${error.message}`));
        }
      });

      req.on('error', (error) => {
        client.close();
        reject(error);
      });

      req.on('response', (headers) => {
        const status = headers[':status'];
        if (status >= 400) {
          const error = new Error(`HTTP ${status}`);
          error.status = status;
          error.response = responseData;
          reject(error);
        }
      });

      req.end(JSON.stringify(params));
    });
  }

  #shouldRetry(error, retryOn) {
    if (error.status && retryOn.includes(error.status)) {
      return true;
    }
    
    const networkErrors = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'];
    return networkErrors.includes(error.code);
  }

  #sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = Http2RPC; 