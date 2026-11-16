module.exports = {
  ...require('./jest.config.cjs'),
  testRegex: 'test/en06\\.concurrency-spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 600000,
};
