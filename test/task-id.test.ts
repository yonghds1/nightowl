import { describe, it, expect } from 'vitest';
import { isValidTaskId, assertTaskId } from '../src/task-id.js';

describe('Task ID 规范校验', () => {
  it('合法的任务ID应通过校验', () => {
    expect(isValidTaskId('T1')).toBe(true);
    expect(isValidTaskId('TASK_101')).toBe(true);
    expect(isValidTaskId('feat-auth')).toBe(true);
    expect(isValidTaskId('A'.repeat(64))).toBe(true);
  });

  it('非法的任务ID应被拒绝', () => {
    expect(isValidTaskId('')).toBe(false);
    expect(isValidTaskId('../escape')).toBe(false);
    expect(isValidTaskId('T1/sub')).toBe(false);
    expect(isValidTaskId('T 1')).toBe(false);
    expect(isValidTaskId('-invalid-leading-dash')).toBe(false);
    expect(isValidTaskId('A'.repeat(65))).toBe(false);
  });

  it('assertTaskId 异常断言', () => {
    expect(() => assertTaskId('T1')).not.toThrow();
    expect(() => assertTaskId('../hack')).toThrow(/INVALID_TASK_ID/);
  });
});
