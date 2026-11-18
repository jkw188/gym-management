import type { Connection } from 'mongoose';
export interface UatSnapshot {
  version: number;
  capturedAt: string;
  collections: Record<string, { count: number; sha256: string; indexes: unknown[] }>;
  finance: { receipts: { amount: string; count: number }; payouts: { amount: string; count: number } };
  inventory: { checked: number; consistent: boolean; issues: { productId: string; codes: string[] }[] };
  sourceIssues: { relation: string; count: number }[];
}
export function assertUat(env: NodeJS.ProcessEnv, demo?: boolean): void;
export function assertRestoreTarget(source: string, target: string): void;
export function indexContract(index: { key: Record<string, number>; [key: string]: unknown }): unknown;
export function compareSnapshots(before: UatSnapshot, after: UatSnapshot): { matched: boolean; issues: string[] };
export function snapshot(connection: Connection): Promise<UatSnapshot>;
export function fileHash(file: string): Promise<string>;
export function run(args?: string[]): Promise<void>;
