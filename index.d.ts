declare module 'rpcmate' {
  import { Server } from 'http2';

  export interface LoggerConfig {
    title?: string;
    level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
    isDev?: boolean;
  }

  export interface CorsOptions {
    origin?: string;
    methods?: string;
    headers?: string;
  }

  export interface TimeoutConfig {
    enabled?: boolean;
    requestTimeout?: number;
    connectionTimeout?: number;
  }

  export interface CircuitBreakerConfig {
    enabled?: boolean;
    failureThreshold?: number;
    recoveryTimeout?: number;
    successThreshold?: number;
  }

  export interface RetryConfig {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
    backoffFactor?: number;
    retryOn?: (number | string)[];
    jitterEnabled?: boolean;
  }

  export interface BulkheadConfig {
    enabled?: boolean;
    maxConcurrentRequests?: number;
    maxQueueSize?: number;
    queueTimeout?: number;
  }

  export interface ResilienceConfig {
    timeout?: TimeoutConfig;
    circuitBreaker?: CircuitBreakerConfig;
    retry?: RetryConfig;
  }

  export interface Http2RPCOptions {
    port?: number;
    host?: string;
    startServer?: boolean;
    logger?: LoggerConfig;
    cors?: boolean;
    corsOptions?: CorsOptions;
    jwtAuth?: boolean;
    jwtPublicKey?: string;
    jwtIssuer?: string;
    jwtAudience?: string;
    excludedPaths?: string[];
    resilience?: ResilienceConfig;
    retryOptions?: RetryConfig; // Backward compatibility
    methods?: Record<string, (params: any) => Promise<any>>;
  }

  export interface RequestOptions {
    token?: string;
    retryOptions?: RetryConfig;
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
    backoffFactor?: number;
    retryOn?: (number | string)[];
    jitterEnabled?: boolean;
  }

  export interface Metrics {
    requestCount: number;
    errorCount: number;
    averageResponseTime: number;
    uptime: number;
    retryCount: number;
    authFailures: number;
    timeoutCount: number;
    circuitBreakerTrips: number;
    bulkheadRejections: number;
    circuitBreakerState: Record<string, {
      state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
      failureCount: number;
      successCount: number;
      lastFailureTime: number;
    }>;
    methodBulkheads: Record<string, {
      activeRequests: number;
      queuedRequests: number;
      rejectedRequests: number;
      config: BulkheadConfig;
    }>;
  }

  export interface ResilienceMetrics {
    resilience: {
      timeout: {
        enabled: boolean;
        requestTimeout: number;
        timeoutCount: number;
      };
      circuitBreaker: {
        enabled: boolean;
        trips: number;
        states: Record<string, any>;
      };
      methodBulkheads: Record<string, any>;
      bulkheadRejections: number;
      retry: {
        enabled: boolean;
        maxRetries: number;
        jitterEnabled: boolean;
        totalRetries: number;
      };
    };
  }

  export interface MethodBulkheadStatus {
    methodName: string;
    config: BulkheadConfig;
    activeRequests: number;
    queuedRequests: number;
    rejectedRequests: number;
  }

  export interface ResponseData<T = any> {
    data: T;
  }

  export interface ErrorResponse {
    error: string;
    message: string;
    details?: any;
  }

  export type RPCResponse<T = any> = ResponseData<T> | ErrorResponse;

  export type MethodHandler = (params: any) => Promise<any>;

  export default class Http2RPC {
    constructor(options?: Http2RPCOptions);

    // Properties
    get methods(): Record<string, MethodHandler>;
    set methods(methodsObject: Record<string, MethodHandler>);

    // Core methods
    addMethod(name: string, handler: MethodHandler, bulkheadConfig?: BulkheadConfig): this;
    
    request<T = any>(
      serviceUrl: string, 
      methodName: string, 
      params?: Record<string, any>, 
      options?: RequestOptions
    ): Promise<T>;

    start(): Promise<Server>;
    stop(): Promise<void>;

    // Metrics and status
    getMetrics(): Metrics;
    getResilienceMetrics(): ResilienceMetrics;
    getMethodBulkheadStatus(methodName: string): MethodBulkheadStatus | { error: string };

    // Circuit breaker management
    resetCircuitBreaker(serviceUrl: string): void;
  }

  export = Http2RPC;
}