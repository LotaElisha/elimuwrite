import { createContext, useContext, useState, type ReactNode } from 'react';

/**
 * Interface translations (English and Swahili). Interface language is independent of the
 * languages supported by the analysis engines. Swahili strings need review by a native
 * speaker before production (see docs/HANDOVER.md).
 */
const en = {
  'nav.home': 'Home', 'nav.tools': 'Tools', 'nav.pricing': 'Pricing', 'nav.signin': 'Sign in', 'nav.signup': 'Create account', 'nav.signout': 'Sign out',
  'nav.dashboard': 'Dashboard', 'nav.documents': 'Documents', 'nav.library': 'References & sources', 'nav.reports': 'Reports', 'nav.billing': 'Plan & usage',
  'nav.courses': 'Courses', 'nav.assignments': 'Assignments', 'nav.institution': 'Institution', 'nav.admin': 'Platform admin', 'nav.progress': 'Learning progress',
  'ws.personal': 'Personal workspace', 'ws.switch': 'Workspace',
  'hero.title': 'Write better. Understand your sources. Submit with confidence.',
  'hero.body': 'A writing studio, source similarity checker, citation manager and assignment workflow for students, researchers and institutions in East Africa and beyond.',
  'hero.try': 'Try the sample editor', 'hero.individual': 'Start free as an individual', 'hero.institution': 'Set up an institution',
  'demo.title': 'Sample editor', 'demo.note': 'Guest demo: your text is processed in memory and not stored. Limited to a few checks per minute.',
  'demo.check': 'Check writing and similarity', 'demo.loadSample': 'Load sample text',
  'common.save': 'Save', 'common.cancel': 'Cancel', 'common.loading': 'Loading…', 'common.retry': 'Try again', 'common.empty': 'Nothing here yet.', 'common.create': 'Create', 'common.delete': 'Delete', 'common.download': 'Download',
  'common.denied': 'You do not have access to this page.', 'common.notConfigured': 'Not configured', 'common.beta': 'Beta', 'common.unavailable': 'Unavailable', 'common.demoData': 'Demonstration data',
  'auth.email': 'Email', 'auth.password': 'Password', 'auth.name': 'Full name', 'auth.optional': 'Optional', 'auth.goals': 'Writing goals', 'auth.level': 'Academic level', 'auth.language': 'Interface language',
  'studio.saved': 'Saved', 'studio.saving': 'Saving…', 'studio.offline': 'Offline: saved on this device only', 'studio.conflict': 'Changed elsewhere', 'studio.unsaved': 'Unsaved changes',
  'studio.writing': 'Writing', 'studio.similarity': 'Similarity', 'studio.citations': 'Citations', 'studio.tools': 'Rewrite & summarize', 'studio.history': 'History', 'studio.comments': 'Comments', 'studio.feedback': 'Feedback',
  'studio.words': 'words', 'studio.outdated': 'Outdated: the document has changed since this analysis.',
  'sim.zero': 'No qualifying matches found in the checked sources.', 'sim.noText': 'Not enough eligible text', 'sim.noSources': 'No sources were available to compare against. This is not a clean result.',
  'policy.title': 'Assistance rules for this assignment',
  'a11y.textSize': 'Text size', 'a11y.theme': 'Theme', 'a11y.skip': 'Skip to content',
};

type Key = keyof typeof en;

const sw: Partial<Record<Key, string>> = {
  'nav.home': 'Mwanzo', 'nav.tools': 'Zana', 'nav.pricing': 'Bei', 'nav.signin': 'Ingia', 'nav.signup': 'Fungua akaunti', 'nav.signout': 'Toka',
  'nav.dashboard': 'Dashibodi', 'nav.documents': 'Nyaraka', 'nav.library': 'Marejeo na vyanzo', 'nav.reports': 'Ripoti', 'nav.billing': 'Mpango na matumizi',
  'nav.courses': 'Kozi', 'nav.assignments': 'Kazi', 'nav.institution': 'Taasisi', 'nav.admin': 'Usimamizi wa jukwaa', 'nav.progress': 'Maendeleo ya kujifunza',
  'ws.personal': 'Eneo binafsi', 'ws.switch': 'Eneo la kazi',
  'hero.title': 'Andika vizuri zaidi. Elewa vyanzo vyako. Wasilisha kwa kujiamini.',
  'hero.body': 'Studio ya uandishi, kikagua ufanano wa vyanzo, kidhibiti cha marejeo na mtiririko wa kazi za darasani kwa wanafunzi, watafiti na taasisi za Afrika Mashariki na kwingineko.',
  'hero.try': 'Jaribu kihariri cha mfano', 'hero.individual': 'Anza bure kama mtu binafsi', 'hero.institution': 'Sajili taasisi',
  'demo.title': 'Kihariri cha mfano', 'demo.note': 'Onyesho la mgeni: maandishi yako yanachakatwa kwenye kumbukumbu na hayahifadhiwi. Ukaguzi ni mchache kwa dakika.',
  'demo.check': 'Kagua uandishi na ufanano', 'demo.loadSample': 'Weka maandishi ya mfano',
  'common.save': 'Hifadhi', 'common.cancel': 'Ghairi', 'common.loading': 'Inapakia…', 'common.retry': 'Jaribu tena', 'common.empty': 'Hakuna kitu bado.', 'common.create': 'Unda', 'common.delete': 'Futa', 'common.download': 'Pakua',
  'common.denied': 'Huna ruhusa ya kuona ukurasa huu.', 'common.notConfigured': 'Haijasanidiwa', 'common.beta': 'Majaribio', 'common.unavailable': 'Haipatikani', 'common.demoData': 'Data ya maonyesho',
  'auth.email': 'Barua pepe', 'auth.password': 'Nenosiri', 'auth.name': 'Jina kamili', 'auth.optional': 'Si lazima', 'auth.goals': 'Malengo ya uandishi', 'auth.level': 'Kiwango cha masomo', 'auth.language': 'Lugha ya kiolesura',
  'studio.saved': 'Imehifadhiwa', 'studio.saving': 'Inahifadhi…', 'studio.offline': 'Nje ya mtandao: imehifadhiwa kwenye kifaa hiki tu', 'studio.conflict': 'Imebadilishwa mahali pengine', 'studio.unsaved': 'Mabadiliko hayajahifadhiwa',
  'studio.writing': 'Uandishi', 'studio.similarity': 'Ufanano', 'studio.citations': 'Manukuu', 'studio.tools': 'Andika upya na fupisha', 'studio.history': 'Historia', 'studio.comments': 'Maoni', 'studio.feedback': 'Mrejesho',
  'studio.words': 'maneno', 'studio.outdated': 'Imepitwa na wakati: hati imebadilika tangu uchambuzi huu.',
  'sim.zero': 'Hakuna mfanano unaostahili uliopatikana katika vyanzo vilivyokaguliwa.', 'sim.noText': 'Hakuna maandishi ya kutosha yanayostahili', 'sim.noSources': 'Hakukuwa na vyanzo vya kulinganisha. Haya si matokeo safi.',
  'policy.title': 'Kanuni za usaidizi kwa kazi hii',
  'a11y.textSize': 'Ukubwa wa maandishi', 'a11y.theme': 'Mandhari', 'a11y.skip': 'Ruka hadi maudhui',
};

type Lang = 'en' | 'sw';
const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: (k: Key) => string }>({ lang: 'en', setLang: () => {}, t: (k) => en[k] });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => (localStorage.getItem('ew.lang') as Lang) || (navigator.language.startsWith('sw') ? 'sw' : 'en'));
  const setLang = (l: Lang) => {
    localStorage.setItem('ew.lang', l);
    document.documentElement.lang = l;
    setLangState(l);
  };
  const t = (k: Key) => (lang === 'sw' ? sw[k] ?? en[k] : en[k]);
  return <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
