/**
 * Local, rule-based English writing checker. Deterministic and transparent: every
 * suggestion comes from a named rule with an explanation. It does NOT claim the coverage
 * of a statistical grammar model; the UI labels it "Rule-based checks (English)".
 * Swahili and other languages are reported as unsupported rather than run through English rules.
 */

export type Suggestion = {
  ruleId: string;
  category: 'spelling' | 'grammar' | 'punctuation' | 'capitalization' | 'repeated_word' | 'sentence_structure' | 'clarity' | 'concision' | 'tone' | 'terminology';
  start: number;
  end: number;
  original: string;
  replacement: string | null; // null = advisory only
  explanation: string;
};

export type CheckOptions = {
  variant: 'en-US' | 'en-GB';
  dictionary?: string[];
  terminology?: { term: string; preferred: string | null; note?: string | null }[];
  formalTone?: boolean;
};

const MISSPELLINGS: Record<string, string> = {
  recieve: 'receive', recieved: 'received', teh: 'the', seperate: 'separate', definately: 'definitely', occured: 'occurred',
  untill: 'until', wich: 'which', accomodate: 'accommodate', acheive: 'achieve', arguement: 'argument', beleive: 'believe',
  begining: 'beginning', calender: 'calendar', commited: 'committed', enviroment: 'environment', existance: 'existence',
  goverment: 'government', independant: 'independent', neccessary: 'necessary', noticable: 'noticeable', occurence: 'occurrence',
  persue: 'pursue', publically: 'publicly', refered: 'referred', relevent: 'relevant', succesful: 'successful',
  tommorow: 'tomorrow', truely: 'truly', wierd: 'weird', alot: 'a lot', thier: 'their', adress: 'address', apparant: 'apparent',
  basicly: 'basically', buisness: 'business', concious: 'conscious', embarass: 'embarrass', foriegn: 'foreign', grammer: 'grammar',
  knowlege: 'knowledge', millenium: 'millennium', posession: 'possession', prefered: 'preferred', reccomend: 'recommend',
  threshhold: 'threshold', resaerch: 'research', reasearch: 'research', analysys: 'analysis', significent: 'significant',
  developement: 'development', enviromental: 'environmental', particulary: 'particularly', sucess: 'success', becuase: 'because',
};

// American → British. The reverse map is derived.
const US_GB: Record<string, string> = {
  color: 'colour', colors: 'colours', behavior: 'behaviour', behaviors: 'behaviours', favor: 'favour', labor: 'labour',
  honor: 'honour', neighbor: 'neighbour', neighbors: 'neighbours', center: 'centre', centers: 'centres', defense: 'defence',
  analyze: 'analyse', analyzed: 'analysed', analyzing: 'analysing', organize: 'organise', organized: 'organised',
  organization: 'organisation', organizations: 'organisations', recognize: 'recognise', recognized: 'recognised',
  realize: 'realise', realized: 'realised', emphasize: 'emphasise', summarize: 'summarise', catalog: 'catalogue',
  program: 'programme', traveled: 'travelled', modeling: 'modelling', fulfill: 'fulfil', gray: 'grey', utilize: 'utilise',
};
const GB_US = Object.fromEntries(Object.entries(US_GB).filter(([us]) => us !== 'program').map(([us, gb]) => [gb, us]));

const WORDY: [RegExp, string, string][] = [
  [/\bin order to\b/gi, 'to', '"In order to" can usually be shortened to "to".'],
  [/\bdue to the fact that\b/gi, 'because', '"Due to the fact that" is wordy; "because" says the same.'],
  [/\bat this point in time\b/gi, 'now', '"At this point in time" can be "now".'],
  [/\ba large number of\b/gi, 'many', '"A large number of" can be "many".'],
  [/\bin spite of the fact that\b/gi, 'although', 'Use "although" instead of a long phrase.'],
  [/\bfor the purpose of\b/gi, 'to', '"For the purpose of" can often be "to" or "for".'],
  [/\bhas the ability to\b/gi, 'can', '"Has the ability to" can be "can".'],
  [/\bin the event that\b/gi, 'if', '"In the event that" can be "if".'],
  [/\bwith regard to\b/gi, 'regarding', '"With regard to" can be "regarding".'],
  [/\bthe majority of\b/gi, 'most', '"The majority of" can usually be "most".'],
  [/\bit is important to note that\b/gi, 'notably,', 'This opener adds length without meaning.'],
];

const CONTRACTIONS: Record<string, string> = {
  "don't": 'do not', "doesn't": 'does not', "can't": 'cannot', "won't": 'will not', "isn't": 'is not', "aren't": 'are not',
  "wasn't": 'was not', "weren't": 'were not', "it's": 'it is', "didn't": 'did not', "shouldn't": 'should not', "couldn't": 'could not',
  "wouldn't": 'would not', "haven't": 'have not', "hasn't": 'has not', "they're": 'they are', "we're": 'we are', "i'm": 'I am',
};
const INFORMAL: Record<string, string | null> = { gonna: 'going to', wanna: 'want to', kinda: 'somewhat', sorta: 'somewhat', stuff: null, 'a lot of': null };

export const LESSONS: Record<string, { rule: string; practice: { prompt: string; answer: string } }> = {
  spelling: { rule: 'Some English words are commonly misspelled. Check the dictionary form, especially with doubled letters and "ie/ei".', practice: { prompt: 'Correct: "We recieved a seperate report."', answer: 'We received a separate report.' } },
  repeated_word: { rule: 'A word typed twice in a row is usually a typing slip.', practice: { prompt: 'Correct: "The the results were clear."', answer: 'The results were clear.' } },
  double_space: { rule: 'Use one space between words and after punctuation.', practice: { prompt: 'Correct: "The  sample was small."', answer: 'The sample was small.' } },
  space_before_punct: { rule: 'Do not put a space before commas, full stops, colons, semicolons, question marks or exclamation marks.', practice: { prompt: 'Correct: "However , the data differ ."', answer: 'However, the data differ.' } },
  space_after_punct: { rule: 'Put one space after a comma, semicolon or colon.', practice: { prompt: 'Correct: "First,second;third"', answer: 'First, second; third' } },
  sentence_case: { rule: 'Start every sentence with a capital letter.', practice: { prompt: 'Correct: "the study ended. results follow."', answer: 'The study ended. Results follow.' } },
  pronoun_i: { rule: 'The pronoun "I" is always capitalised.', practice: { prompt: 'Correct: "Then i measured it."', answer: 'Then I measured it.' } },
  a_an: { rule: 'Use "an" before a vowel sound and "a" before a consonant sound.', practice: { prompt: 'Correct: "a analysis" / "an university"', answer: 'an analysis / a university' } },
  variant: { rule: 'Keep to one spelling convention (British or American) throughout a document.', practice: { prompt: 'In British English, write "color" as…', answer: 'colour' } },
  long_sentence: { rule: 'Very long sentences are harder to follow. Consider splitting at a natural break.', practice: { prompt: 'Split a 40-word sentence into two sentences of about 20 words.', answer: 'Answers vary.' } },
  passive: { rule: 'Passive voice hides who did the action. It is acceptable in methods sections, but active voice is often clearer.', practice: { prompt: 'Rewrite actively: "The samples were collected by the team."', answer: 'The team collected the samples.' } },
  wordy: { rule: 'Shorter phrases often say the same thing more clearly.', practice: { prompt: 'Shorten: "in order to improve"', answer: 'to improve' } },
  contraction: { rule: 'Academic writing usually avoids contractions.', practice: { prompt: 'Formalise: "The results don\'t support it."', answer: 'The results do not support it.' } },
  informal: { rule: 'Informal words weaken an academic tone.', practice: { prompt: 'Formalise: "We\'re gonna test it."', answer: 'We are going to test it.' } },
  terminology: { rule: 'Your institution prefers a specific term for consistency.', practice: { prompt: 'Use the preferred term in your next sentence.', answer: 'Answers vary.' } },
};

const SWAHILI_MARKERS = new Set(['na', 'ya', 'wa', 'kwa', 'ni', 'katika', 'za', 'la', 'cha', 'kuwa', 'hii', 'hiyo', 'pia', 'sana', 'lakini', 'kwamba', 'wanafunzi', 'elimu']);

/** Rough language screen: avoids running English rules on Swahili text and presenting the output as valid. */
export function detectLanguage(text: string): 'en' | 'sw' | 'unknown' {
  const words = (text.toLowerCase().match(/\p{L}+/gu) ?? []).slice(0, 400);
  if (words.length < 5) return 'unknown';
  const sw = words.filter((w) => SWAHILI_MARKERS.has(w)).length / words.length;
  const en = words.filter((w) => ['the', 'and', 'of', 'to', 'is', 'in', 'that', 'it', 'for', 'was', 'with', 'are'].includes(w)).length / words.length;
  if (sw > 0.08 && sw > en) return 'sw';
  if (en > 0.05) return 'en';
  return 'unknown';
}

function matchCase(src: string, repl: string) {
  if (src[0] === src[0].toUpperCase() && src[0] !== src[0].toLowerCase()) return repl[0].toUpperCase() + repl.slice(1);
  return repl;
}

export function checkText(text: string, opts: CheckOptions): Suggestion[] {
  const out: Suggestion[] = [];
  const dict = new Set((opts.dictionary ?? []).map((w) => w.toLowerCase()));
  const add = (s: Suggestion) => out.push(s);

  // spelling, variant, terminology (word level)
  for (const m of text.matchAll(/[\p{L}]+(?:'[\p{L}]+)?/gu)) {
    const w = m[0];
    const lw = w.toLowerCase();
    if (dict.has(lw)) continue;
    const start = m.index!;
    const end = start + w.length;
    if (MISSPELLINGS[lw]) {
      add({ ruleId: 'spelling', category: 'spelling', start, end, original: w, replacement: matchCase(w, MISSPELLINGS[lw]), explanation: `"${w}" looks misspelled.` });
      continue;
    }
    const variantMap = opts.variant === 'en-GB' ? US_GB : GB_US;
    if (variantMap[lw]) {
      add({ ruleId: 'variant', category: 'spelling', start, end, original: w, replacement: matchCase(w, variantMap[lw]), explanation: `Your document is set to ${opts.variant === 'en-GB' ? 'British' : 'American'} English.` });
    }
    if (lw === 'i' && w === 'i') {
      add({ ruleId: 'pronoun_i', category: 'capitalization', start, end, original: w, replacement: 'I', explanation: 'The pronoun "I" is always capitalised.' });
    }
  }

  for (const t of opts.terminology ?? []) {
    if (!t.preferred) continue;
    const re = new RegExp(`\\b${t.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    for (const m of text.matchAll(re)) {
      add({ ruleId: 'terminology', category: 'terminology', start: m.index!, end: m.index! + m[0].length, original: m[0], replacement: t.preferred, explanation: t.note || `Your institution prefers "${t.preferred}".` });
    }
  }

  for (const m of text.matchAll(/\b([\p{L}]+)(\s+)(\1)\b/giu)) {
    if (m[1].toLowerCase() !== m[3].toLowerCase() || ['had', 'that'].includes(m[1].toLowerCase())) continue;
    const start = m.index! + m[1].length;
    add({ ruleId: 'repeated_word', category: 'repeated_word', start, end: start + m[2].length + m[3].length, original: m[2] + m[3], replacement: '', explanation: `"${m[1]}" is repeated.` });
  }

  for (const m of text.matchAll(/(?<=\S) {2,}(?=\S)/g)) {
    add({ ruleId: 'double_space', category: 'punctuation', start: m.index!, end: m.index! + m[0].length, original: m[0], replacement: ' ', explanation: 'Extra space between words.' });
  }
  for (const m of text.matchAll(/(?<=\p{L}) +([,.;:!?])(?!\d)/gu)) {
    add({ ruleId: 'space_before_punct', category: 'punctuation', start: m.index!, end: m.index! + m[0].length, original: m[0], replacement: m[1], explanation: 'No space is needed before this punctuation mark.' });
  }
  for (const m of text.matchAll(/(?<=\p{Ll})([,;])(?=\p{L})/gu)) {
    add({ ruleId: 'space_after_punct', category: 'punctuation', start: m.index!, end: m.index! + 1, original: m[1], replacement: m[1] + ' ', explanation: 'Add a space after this punctuation mark.' });
  }

  // sentence starts: beginning of a block or after . ! ? followed by space
  for (const m of text.matchAll(/(?:^|\n\n|[.!?]\s+)(["“(]?)(\p{Ll})/gu)) {
    const pos = m.index! + m[0].length - 1;
    // skip common abbreviations like "e.g. the" / "i.e. it"
    const before = text.slice(Math.max(0, m.index! - 4), m.index! + 1).toLowerCase();
    if (/(e\.g|i\.e|etc|vs|al)\.$/.test(before)) continue;
    add({ ruleId: 'sentence_case', category: 'capitalization', start: pos, end: pos + 1, original: m[2], replacement: m[2].toUpperCase(), explanation: 'Sentences start with a capital letter.' });
  }

  for (const m of text.matchAll(/\b(a|an) ([\p{L}]+)/giu)) {
    const art = m[1];
    const next = m[2].toLowerCase();
    const vowelSound = /^[aeio]/.test(next) || (/^u/.test(next) && !/^(uni|use|usu|uti|eu)/.test(next)) || /^(hour|honest|honou?r|heir)/.test(next);
    const consonantSound = /^(uni|use|usu|uti|eu|one|once)/.test(next) || !/^[aeiou]/.test(next);
    const wanted = vowelSound ? 'an' : consonantSound ? 'a' : null;
    if (wanted && art.toLowerCase() !== wanted && next.length > 1) {
      add({ ruleId: 'a_an', category: 'grammar', start: m.index!, end: m.index! + art.length, original: art, replacement: matchCase(art, wanted), explanation: `Use "${wanted}" before "${m[2]}".` });
    }
  }

  for (const [re, repl, why] of WORDY) {
    for (const m of text.matchAll(re)) add({ ruleId: 'wordy', category: 'concision', start: m.index!, end: m.index! + m[0].length, original: m[0], replacement: matchCase(m[0], repl), explanation: why });
  }

  if (opts.formalTone !== false) {
    for (const m of text.matchAll(/\b[\p{L}]+n't\b|\b(it|they|we|i)'(s|re|m)\b/giu)) {
      const repl = CONTRACTIONS[m[0].toLowerCase().replace('’', "'")];
      if (repl) add({ ruleId: 'contraction', category: 'tone', start: m.index!, end: m.index! + m[0].length, original: m[0], replacement: matchCase(m[0], repl), explanation: 'Academic writing usually avoids contractions.' });
    }
    for (const [w, repl] of Object.entries(INFORMAL)) {
      for (const m of text.matchAll(new RegExp(`\\b${w}\\b`, 'gi'))) add({ ruleId: 'informal', category: 'tone', start: m.index!, end: m.index! + m[0].length, original: m[0], replacement: repl, explanation: `"${m[0]}" is informal for academic writing.` });
    }
  }

  // sentence-level: length and passive voice (advisory, no automatic replacement)
  for (const s of sentences(text)) {
    const words = s.text.split(/\s+/).filter(Boolean).length;
    if (words > 35) add({ ruleId: 'long_sentence', category: 'sentence_structure', start: s.start, end: s.end, original: s.text, replacement: null, explanation: `This sentence has ${words} words. Consider splitting it.` });
    const pm = /\b(is|are|was|were|be|been|being)\s+(\w+ed)\b/i.exec(s.text);
    if (pm) add({ ruleId: 'passive', category: 'clarity', start: s.start + pm.index, end: s.start + pm.index + pm[0].length, original: pm[0], replacement: null, explanation: 'Possible passive voice. Active voice can be clearer about who acted.' });
  }

  // de-duplicate overlapping suggestions, keeping the first by position then priority
  out.sort((a, b) => a.start - b.start || (b.replacement ? 1 : 0) - (a.replacement ? 1 : 0));
  const kept: Suggestion[] = [];
  for (const s of out) {
    if (s.replacement !== null && kept.some((k) => k.replacement !== null && s.start < k.end && k.start < s.end)) continue;
    kept.push(s);
  }
  return kept;
}

export function sentences(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const re = /[^.!?\n]+(?:[.!?]+|$)/g;
  for (const m of text.matchAll(re)) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t.length < 2) continue;
    out.push({ text: t, start: m.index! + lead, end: m.index! + lead + t.length });
  }
  return out;
}

function syllables(word: string) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

/** Readability indicators with their method; null when the text is too short to be meaningful. */
export function readability(text: string) {
  const words = text.match(/[A-Za-z]+(?:'[a-z]+)?/g) ?? [];
  const sents = sentences(text).length;
  const method = 'Flesch Reading Ease = 206.835 − 1.015 × (words ÷ sentences) − 84.6 × (syllables ÷ words). Syllables are estimated by vowel groups. English only; an indicator of sentence and word length, not of quality or correctness.';
  if (words.length < 100 || sents === 0) return { available: false, reason: 'Needs at least 100 English words.', method };
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  const fre = 206.835 - 1.015 * (words.length / sents) - 84.6 * (syl / words.length);
  return {
    available: true,
    fleschReadingEase: Math.round(fre * 10) / 10,
    averageSentenceLength: Math.round((words.length / sents) * 10) / 10,
    words: words.length,
    sentences: sents,
    method,
  };
}
