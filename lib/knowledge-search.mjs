const normalize = value => String(value ?? "").normalize("NFKC").toLowerCase();
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Lightweight lexical matching, not semantic/vector search. Require every
// query token; adjacent Han bigrams tolerate spacing around a long phrase.
function matchTerm(text, term) {
  if (text.includes(term)) return 2;
  if (!/^\p{Script=Han}{3,}$/u.test(term)) return 0;
  const characters = [...term];
  const bigrams = characters.slice(0, -1).map((ch, i) => ch + characters[i + 1]);
  return bigrams.every(pair => text.includes(pair)) ? 1 : 0;
}

export function searchKnowledge(records, query, limit = 12) {
  const tokens = [...new Set(normalize(query).match(/[\p{L}\p{N}]+/gu) || [])];
  const ranked = records.map(record => {
    const title = normalize(record.title), content = normalize(record.content), source = normalize(record.source);
    const text = [title, content, source].join(" ");
    const matches = tokens.map(term => matchTerm(text, term));
    return { record, matches, score: matches.reduce((sum, value, index) =>
      sum + value + (title.includes(tokens[index]) ? 4 : 0), 0) };
  }).filter(item => item.matches.every(Boolean));
  ranked.sort((a, b) => b.score - a.score || compare(normalize(a.record.title), normalize(b.record.title)) ||
    compare(String(a.record.id), String(b.record.id)));
  return ranked.slice(0, limit).map(item => item.record);
}
