// Test setup and utilities
const { beforeEach, afterEach } = require('node:test');

// Global test configuration
global.testConfig = {
  timeout: 30000,
  retries: 2
};

// Clean up any running processes
process.on('exit', () => {
  // Cleanup code if needed
});

// Unhandled promise rejection handler for tests
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

module.exports = {
  testConfig: global.testConfig
};