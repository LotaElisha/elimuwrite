// Central configuration. Everything brand- or deployment-specific is read from
// the environment so the product name, colours, domain and providers stay configurable.
const env = process.env;

export const config = {
  brand: {
    name: env.BRAND_NAME ?? 'ElimuWrite',
    tagline: env.BRAND_TAGLINE ?? 'Write better. Understand your sources. Submit with confidence.',
    primaryColor: env.BRAND_PRIMARY ?? '#14284b',
    accentColor: env.BRAND_ACCENT ?? '#1f8a84',
    domain: env.PUBLIC_URL ?? 'http://localhost:5173',
  },
  port: Number(env.PORT ?? 3000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://elimu_app:elimu_app@localhost:5432/elimuwrite',
  ownerDatabaseUrl: env.OWNER_DATABASE_URL ?? 'postgres://elimu_owner:elimu_owner@localhost:5432/elimuwrite',
  storageDir: env.STORAGE_DIR ?? new URL('../../storage', import.meta.url).pathname,
  sessionDays: Number(env.SESSION_DAYS ?? 14),
  cookieSecure: env.COOKIE_SECURE === 'true',
  maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? 15) * 1024 * 1024,
  runWorker: env.RUN_WORKER !== 'false',
  providers: {
    llm: {
      // Provider-neutral adapter; only Anthropic is wired in Phase 1.
      anthropicKey: env.ANTHROPIC_API_KEY ?? '',
      model: env.LLM_MODEL ?? 'claude-sonnet-5-5',
      timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 30000),
    },
    ocr: { endpoint: env.OCR_ENDPOINT ?? '' },
    malwareScan: { endpoint: env.MALWARE_SCAN_ENDPOINT ?? '' },
    externalSimilarity: { endpoint: env.EXTERNAL_SIMILARITY_ENDPOINT ?? '', key: env.EXTERNAL_SIMILARITY_KEY ?? '' },
    payments: {
      provider: env.PAYMENT_PROVIDER ?? '',
      webhookSecret: env.PAYMENT_WEBHOOK_SECRET ?? '',
    },
    crossref: { enabled: env.CROSSREF_ENABLED !== 'false', mailto: env.CROSSREF_MAILTO ?? '' },
  },
  guestDemo: { perMinute: Number(env.GUEST_DEMO_PER_MINUTE ?? 5), maxChars: 3000 },
};

export type ProviderStatus = { key: string; name: string; status: 'configured' | 'not_configured'; detail: string };

export function providerStatuses(): ProviderStatus[] {
  const p = config.providers;
  return [
    { key: 'llm', name: 'AI writing assistance (paraphrase modes, translation, tutor)', status: p.llm.anthropicKey ? 'configured' : 'not_configured', detail: p.llm.anthropicKey ? `Model ${p.llm.model}` : 'Set ANTHROPIC_API_KEY to enable. Local rule-based tools remain available.' },
    { key: 'ocr', name: 'OCR for scanned PDFs', status: p.ocr.endpoint ? 'configured' : 'not_configured', detail: 'Set OCR_ENDPOINT. Scanned PDFs are held for OCR, never treated as empty.' },
    { key: 'malware', name: 'Malware scanning of uploads', status: p.malwareScan.endpoint ? 'configured' : 'not_configured', detail: 'Set MALWARE_SCAN_ENDPOINT (e.g. ClamAV REST).' },
    { key: 'external_similarity', name: 'Licensed external similarity service', status: p.externalSimilarity.endpoint ? 'configured' : 'not_configured', detail: 'Requires a commercial agreement and credentials. Local-corpus matching works without it.' },
    { key: 'payments', name: 'Payment processing', status: p.payments.provider && p.payments.webhookSecret ? 'configured' : 'not_configured', detail: 'Choose a provider after verifying Tanzanian merchant and mobile-money support.' },
    { key: 'crossref', name: 'DOI lookup (Crossref)', status: p.crossref.enabled ? 'configured' : 'not_configured', detail: 'Public API; requires outbound network access to api.crossref.org.' },
    { key: 'lti', name: 'LMS integration (LTI 1.3 / Moodle)', status: 'not_configured', detail: 'Planned for Phase 2.' },
    { key: 'sso', name: 'Institutional SSO', status: 'not_configured', detail: 'Planned for Phase 2.' },
    { key: 'ai_detection', name: 'AI-text detection', status: 'not_configured', detail: 'Optional later integration; results show "Unavailable".' },
  ];
}
