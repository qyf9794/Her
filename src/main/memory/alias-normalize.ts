export const normalizeAliasPhrase = (phrase: string) =>
  phrase
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[“”"「」『』]/g, "")
    .replace(/[，。！？、,.!?;；:：]/g, "")
    .replace(/\s+/g, "")
    .trim();
