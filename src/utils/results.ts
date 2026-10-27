import type { AccountSyncResult } from '../types.js';

export function summarizeAccountResult(result: AccountSyncResult): string {
  if (result.status === 'success') return 'Success';
  if (result.status === 'partial') return 'Partial';
  return 'Failed';
}
