// jsdom ships no types and the repo does not add @types/jsdom for one test (nor the DOM lib to a service that has no DOM): the small part of
// the DOM the page test touches.
declare module 'jsdom' {
  export interface El {
    textContent: string | null;
    hidden: boolean;
    className: string;
    click(): void;
    querySelector(selector: string): El | null;
    querySelectorAll(selector: string): Iterable<El> & { length: number; [index: number]: El };
  }
  export interface Doc extends El {
    body: El;
    getElementById(id: string): El | null;
  }
  export interface Win {
    document: Doc;
    fetch: unknown;
    eval(code: string): unknown;
  }
  export class JSDOM {
    constructor(html?: string, options?: { url?: string; runScripts?: 'dangerously' | 'outside-only' });
    readonly window: Win;
  }
}
