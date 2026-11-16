import { defineConfig } from 'vitest/config';

// Tests run against a separate database (elimuwrite_test) that global-setup wipes and migrates.
const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://elimu_app:elimu_app@localhost:5432/elimuwrite_test';
const TEST_OWNER_DB = process.env.TEST_OWNER_DATABASE_URL ?? 'postgres://elimu_owner:elimu_owner@localhost:5432/elimuwrite_test';

export default defineConfig({
  test: {
    globalSetup: './test/global-setup.ts',
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      DATABASE_URL: TEST_DB,
      OWNER_DATABASE_URL: TEST_OWNER_DB,
      RUN_WORKER: 'false',
      STORAGE_DIR: '/tmp/elimuwrite-test-storage',
      ANTHROPIC_API_KEY: '',
      OCR_ENDPOINT: '',
      EXTERNAL_SIMILARITY_ENDPOINT: '',
      PAYMENT_PROVIDER: 'testpay',
      PAYMENT_WEBHOOK_SECRET: 'test-webhook-secret',
    },
  },
});
