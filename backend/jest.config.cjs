module.exports = {
  testEnvironment: 'node',
  testRegex: '(?:test/.*(?:\\.|-)spec|src/.*\\.spec)\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '\\.e2e-spec\\.ts$', 'en05\\.concurrency-spec\\.ts$', 'en06\\.concurrency-spec\\.ts$'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }] },
  testTimeout: 60000,
  clearMocks: true,
};
