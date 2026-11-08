export interface TestDatabase {
  name: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}
export function validateTestEnvironment(env: NodeJS.ProcessEnv): string;
export function testDatabaseName(base: string, runId: string, worker: string, suite: string): string;
export function createTestDatabase(env: NodeJS.ProcessEnv, suite: string): Promise<TestDatabase>;
