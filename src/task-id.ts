export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidTaskId(id: string): boolean {
  return typeof id === 'string' && TASK_ID_RE.test(id.trim());
}

export function assertTaskId(id: string): void {
  if (!isValidTaskId(id)) {
    throw new Error(
      `INVALID_TASK_ID: "${id}" 不符合规范，必须匹配 ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ 且不得包含路径穿越字符`,
    );
  }
}
