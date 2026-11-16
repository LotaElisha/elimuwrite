/** Assistance policies (spec §11). Each capability is independently allowed or blocked. */
export const CAPABILITIES = ['grammar', 'paraphrase', 'translation', 'summarization', 'tutoring', 'generative'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type Policy = Record<Capability, boolean> & { disclosure_required: boolean };

export const PRESETS: Record<string, { label: string; policy: Policy }> = {
  proofreading_only: { label: 'Proofreading only', policy: { grammar: true, paraphrase: false, translation: false, summarization: false, tutoring: false, generative: false, disclosure_required: false } },
  guided_learning: { label: 'Guided learning', policy: { grammar: true, paraphrase: false, translation: false, summarization: true, tutoring: true, generative: false, disclosure_required: false } },
  permitted_with_disclosure: { label: 'Permitted AI assistance with disclosure', policy: { grammar: true, paraphrase: true, translation: true, summarization: true, tutoring: true, generative: true, disclosure_required: true } },
  assistance_disabled: { label: 'Assistance disabled', policy: { grammar: false, paraphrase: false, translation: false, summarization: false, tutoring: false, generative: false, disclosure_required: false } },
};

export function resolvePolicy(preset: string, overrides?: Partial<Policy>): Policy {
  const base = PRESETS[preset]?.policy ?? PRESETS.guided_learning.policy;
  return { ...base, ...(overrides ?? {}) };
}
