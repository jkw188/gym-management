module.exports = {
  testEnvironment: 'node',
  testRegex: 'test/.*(?:\\.|-)spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }] },
  testTimeout: 60000,
  clearMocks: true,
};
