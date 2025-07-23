# RPCMate

Легковесный HTTP/2 RPC сервер с поддержкой JWT аутентификации и механизмом повторных запросов.

## Установка

```bash
npm install rpcmate
```

## Быстрый старт

```javascript
const Http2RPC = require('rpcmate');

// Создание RPC сервера с методами (автоматически запускается)
const rpc = new Http2RPC({
  port: 3000,
  methods: {
    hello: async (params) => {
      return { message: `Hello, ${params.name}!` };
    },
    add: async (params) => {
      return { result: params.a + params.b };
    }
  }
});

// Сервер работает, можно вызывать методы:
// GET http://localhost:3000/health-check - проверка состояния
// POST http://localhost:3000/hello - вызов метода

// Тот же экземпляр можно использовать как клиент для вызовов других сервисов:
const result = await rpc.request(
  'http://localhost:3001', 
  'remoteMethod', 
  { data: 'test' }
);
console.log(result); // { data: { ... } }
```

## Только клиент (без сервера)

```javascript
const Http2RPC = require('rpcmate');

// Создание только клиента (без методов = без сервера)
const client = new Http2RPC();

// Вызов удаленного метода
const result = await client.request(
  'http://localhost:3000',
  'hello',
  { name: 'World' }
);

console.log(result); // { data: { message: "Hello, World!" } }
```

## Пустой сервер (без методов)

```javascript
const Http2RPC = require('rpcmate');

// Запуск пустого сервера (методы можно добавить позже)
const rpc = new Http2RPC({ 
  port: 3000, 
  startServer: true 
});

// Добавление методов после создания
rpc.addMethod('newMethod', async (params) => {
  return { status: 'ok', data: params };
});
```

## API

### Конструктор

```javascript
new Http2RPC(options)
```

#### Опции

| Параметр | Тип | По умолчанию | Описание |
|----------|-----|--------------|----------|
| `port` | number | 3000 | Порт сервера |
| `host` | string | 'localhost' | Хост сервера |
| `startServer` | boolean | auto | Запуск сервера (auto = true если есть методы) |
| `logger` | object | console | Объект логгера |
| `cors` | boolean | true | Включить CORS |
| `corsOptions` | object | {...} | CORS настройки |
| `jwtAuth` | boolean | false | JWT аутентификация |
| `jwtPublicKey` | string | null | Публичный ключ для JWT |
| `jwtIssuer` | string | null | Проверка issuer в JWT |
| `jwtAudience` | string | null | Проверка audience в JWT |
| `excludedPaths` | array | [] | Пути без аутентификации |
| `retryOptions` | object | {...} | Настройки повторов |
| `methods` | object | {} | Начальные методы |

### Методы

#### `addMethod(name, handler)`
Добавляет RPC метод.

```javascript
server.addMethod('getData', async (params) => {
  return { data: params.id };
});
```

#### `request(serviceUrl, methodName, params, options)`
Выполняет удаленный вызов метода.

```javascript
const result = await client.request(
  'http://api.example.com',
  'getUser',
  { id: 123 },
  { token: 'jwt_token' }
);
```

#### `start()` / `stop(timeout)`
Управление жизненным циклом сервера.

```javascript
await server.start();
await server.stop(5000); // 5 секунд на graceful shutdown
```

#### `getMetrics()`
Получение метрик сервера.

```javascript
const metrics = server.getMetrics();
// {
//   requestCount: 100,
//   errorCount: 5,
//   averageResponseTime: 45.2,
//   uptime: 3600000,
//   retryCount: 12,
//   authFailures: 2
// }
```

### Геттеры/Сеттеры

```javascript
// Получение всех методов
const methods = server.methods;

// Замена всех методов
server.methods = {
  newMethod: async (params) => ({ success: true })
};
```

## JWT Аутентификация

```javascript
const server = new Http2RPC({
  port: 3000,
  jwtAuth: true,
  jwtPublicKey: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
-----END PUBLIC KEY-----`,
  jwtIssuer: 'your-service',
  jwtAudience: 'your-api',
  excludedPaths: ['health-check', 'public-method']
});
```

Для вызовов с аутентификацией:

```javascript
const result = await client.request(
  'http://localhost:3000',
  'protected-method',
  { data: 'value' },
  { token: 'your.jwt.token' }
);
```

## Настройка повторных запросов

```javascript
const client = new Http2RPC({
  retryOptions: {
    maxRetries: 5,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffFactor: 2,
    retryOn: [500, 502, 503, 504, 408]
  }
});
```

## CORS настройки

```javascript
const server = new Http2RPC({
  cors: true,
  corsOptions: {
    origin: 'https://your-domain.com',
    methods: 'GET, POST, PUT, DELETE',
    headers: 'Content-Type, Authorization, X-Custom-Header'
  }
});
```

## Примеры использования

### Микросервис пользователей

```javascript
const Http2RPC = require('rpcmate');

const userService = new Http2RPC({
  port: 3001,
  jwtAuth: true,
  jwtPublicKey: process.env.JWT_PUBLIC_KEY,
  methods: {
    getUser: async (params) => {
      // params._user содержит данные из JWT
      const user = await db.findUser(params.id);
      return { user };
    },
    
    createUser: async (params) => {
      const user = await db.createUser(params.userData);
      return { user, created: true };
    },
    
    updateUser: async (params) => {
      const user = await db.updateUser(params.id, params.userData);
      return { user, updated: true };
    }
  }
});
```

### API Gateway

```javascript
const Http2RPC = require('rpcmate');

const gateway = new Http2RPC({
  port: 3000,
  methods: {
    proxy: async (params) => {
      const { service, method, data } = params;
      
      const serviceUrl = getServiceUrl(service);
      const result = await gateway.request(serviceUrl, method, data);
      
      return result;
    }
  }
});

function getServiceUrl(service) {
  const services = {
    users: 'http://users-service:3001',
    orders: 'http://orders-service:3002',
    payments: 'http://payments-service:3003'
  };
  return services[service];
}
```

### Клиент для фронтенда

```javascript
class ApiClient {
  constructor(baseUrl, token) {
    this.rpc = new Http2RPC();
    this.baseUrl = baseUrl;
    this.token = token;
  }
  
  async call(method, params) {
    return this.rpc.request(
      this.baseUrl,
      method,
      params,
      { token: this.token }
    );
  }
  
  async getUser(id) {
    return this.call('getUser', { id });
  }
  
  async createOrder(orderData) {
    return this.call('createOrder', { orderData });
  }
}

const api = new ApiClient('http://localhost:3000', userToken);
const user = await api.getUser(123);
```

## Форматы ответов

### Успешный ответ
```json
{
  "data": {
    "result": "success"
  }
}
```

### Ошибка
```json
{
  "error": "METHOD_NOT_FOUND",
  "message": "Method not found",
  "method": "unknownMethod",
  "availableMethods": ["hello", "add"]
}
```

## Health Check

GET `/health-check` возвращает состояние сервера:

```json
{
  "data": {
    "status": "ok",
    "uptime": 3600000,
    "timestamp": "2024-01-01T12:00:00.000Z",
    "metrics": {
      "requestCount": 100,
      "errorCount": 5,
      "averageResponseTime": 45.2,
      "startTime": 1704110400000,
      "retryCount": 12,
      "authFailures": 2
    },
    "methods": ["hello", "add"],
    "auth": "JWT RS256"
  }
}
```

## Требования

- Node.js >= 14.0.0
- Поддержка HTTP/2

## Лицензия

MIT 