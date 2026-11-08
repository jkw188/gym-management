module.exports = {
  ...require('./jest.config.cjs'),
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/'],
  maxWorkers: 1,
};
