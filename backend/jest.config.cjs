module.exports = {
  testEnvironment: 'node',
  testRegex: '(?:test/.*(?:\\.|-)spec|src/.*\\.spec)\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '\\.e2e-spec\\.ts$'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }] },
  testTimeout: 60000,
  clearMocks: true,
};
