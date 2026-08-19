import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    environment: 'node',
    // resilience 测试会 chdir 到临时仓库,文件级串行避免互相干扰
    fileParallelism: false,
  },
});
