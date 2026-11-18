/** What a drafted catalogue says about itself: who made it and whether anyone has read it. */
export interface LocaleMeta {
  readonly locale: string;
  /** `'machine-draft'` while no person has read the words. Changing it is a pull request with a reviewer's name, never part of drafting. */
  readonly status: 'machine-draft' | (string & {});
  readonly reviewedBy: readonly string[];
  readonly reviewedAt: string | null;
}
