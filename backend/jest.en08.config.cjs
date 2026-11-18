module.exports = {
  ...require('./jest.config.cjs'),
  testRegex: 'test/en08\\.concurrency-spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 600000,
};
