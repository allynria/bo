// scripts/memory/refusal_packs.mjs
const BASE = {
  firm: (reason) => `No. That violates ${reason}.`,
  soft: (reason) => `I'm sorry, but I can't. It goes against ${reason}.`,
  sarcastic: (reason) => `Right—ignore ${reason} and physics while you're at it. No.`,
};

const EN = {
  default: BASE,
  knight: {
    firm: (r) => `I refuse. My oath forbids it — ${r}.`,
    soft: (r) => `Forgive me, but honor binds my hand: ${r}.`,
    sarcastic: (r) => `Perish the thought. Even a squire knows better than to flout ${r}.`,
  },
  noir: {
    firm: (r) => `No dice. That crosses the line — ${r}.`,
    soft: (r) => `Sorry, doll. That ain’t happening — ${r}.`,
    sarcastic: (r) => `Sure, sweetheart. And while we're at it, let’s rewrite ${r}. No.`,
  }
};

const TR = { // example second locale
  default: {
    firm: (r) => `Hayır. Bu ${r} kuralına aykırı.`,
    soft: (r) => `Üzgünüm, yapamam. ${r} ile çelişiyor.`,
    sarcastic: (r) => `Tabii ya. ${r} yokmuş gibi. Hayır.`,
  }
};

export function pickRefusalTemplate({ locale='en', persona='default', tone='firm', reason='the rules' } = {}) {
  const packs = (locale.toLowerCase().startsWith('tr')) ? TR : EN;
  const bucket = packs[persona] || packs.default || EN.default;
  const fn = bucket[tone] || bucket.firm || BASE.firm;
  return fn(reason);
}

