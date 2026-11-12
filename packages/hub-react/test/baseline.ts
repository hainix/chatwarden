// The pages as 0.1.7 drew them, kept as files so "byte for byte what it is today" is a comparison and not a claim. Normalised: the ids React makes for
// `useId` (they depend on how many were made before), the random ids and refs a new world makes each run, and the exact times in `title` attributes
// (they are written in the machine's time zone).
export const normalized = (el: Element): string =>
  el.outerHTML
    .replace(/[«:]r[0-9a-z]+[»:]/g, 'ID')
    .replace(/(#\/(?:reports|people|appeals)\/)[A-Za-z0-9_-]+/g, '$1REF')
    .replace(/\bs_[A-Za-z0-9_-]{6,}/g, 's_REF')
    .replace(/ title="[^"]*"/g, ' title="T"')
    .replace(/_r_[0-9a-z]+_/g, 'ID');
export const baseline = (name: string): string => `./baselines/${name}.html`;
