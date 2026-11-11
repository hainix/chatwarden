import { afterEach, describe, expect, it } from 'vitest';
import { activeIn, byId, isTypingTarget, rootOf } from '../src/dom.js';

// The one module that touches the page: every lookup goes through the root the hub is actually in, which is the document or a
// shadow root (a hub inside another shadow root has that root, not the document, and its focus is not the page's focus).

afterEach(() => {
  document.body.replaceChildren();
});

function shadowWith(html: string, host: HTMLElement = document.body.appendChild(document.createElement('div'))): ShadowRoot {
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = html;
  return shadow;
}

describe('rootOf', () => {
  it('is the document for a node on the page', () => {
    const el = document.body.appendChild(document.createElement('div'));
    expect(rootOf(el)).toBe(document);
    expect(rootOf(document.body)).toBe(document);
    expect(rootOf(document)).toBe(document);
  });

  it('is the shadow root for a node inside one, however deep', () => {
    const shadow = shadowWith('<div id="a"><span id="b"><button id="c">x</button></span></div>');
    expect(rootOf(shadow.getElementById('a') as Element)).toBe(shadow);
    expect(rootOf(shadow.getElementById('c') as Element)).toBe(shadow);
    expect(rootOf(shadow)).toBe(shadow);
  });

  it('is the inner shadow root for a node in a shadow root that itself sits in another', () => {
    const outer = shadowWith('<div id="inner-host"></div>');
    const inner = shadowWith('<button id="deep">x</button>', outer.getElementById('inner-host') as HTMLElement);
    expect(rootOf(inner.getElementById('deep') as Element)).toBe(inner);
    expect(rootOf(inner.host)).toBe(outer);
  });

  it('falls back to the node\'s document for a node that is not attached anywhere', () => {
    const loose = document.createElement('div');
    expect(rootOf(loose)).toBe(document);
  });
});

describe('activeIn', () => {
  it('is the focused element of a document root', () => {
    const b = document.body.appendChild(document.createElement('button'));
    b.focus();
    expect(activeIn(document)).toBe(b);
  });

  it('is the focused element INSIDE a shadow root, where the document only sees the host', () => {
    const shadow = shadowWith('<button id="in">x</button>');
    const button = shadow.getElementById('in') as HTMLElement;
    button.focus();
    expect(activeIn(shadow)).toBe(button);
    expect(activeIn(document)).toBe(shadow.host);
  });

  it('is null in a shadow root when focus is elsewhere', () => {
    const shadow = shadowWith('<button>x</button>');
    const other = document.body.appendChild(document.createElement('button'));
    other.focus();
    expect(activeIn(shadow)).toBeNull();
  });

  it('each nested shadow root answers for itself', () => {
    const outer = shadowWith('<button id="o">o</button><div id="h"></div>');
    const inner = shadowWith('<button id="i">i</button>', outer.getElementById('h') as HTMLElement);
    (inner.getElementById('i') as HTMLElement).focus();
    expect(activeIn(inner)).toBe(inner.getElementById('i'));
    expect(activeIn(outer)).toBe(inner.host);
    expect(activeIn(document)).toBe(outer.host);
  });
});

describe('byId', () => {
  it('finds an id in the root it is asked, and only there', () => {
    const shadow = shadowWith('<input id="same">');
    const light = document.body.appendChild(document.createElement('input'));
    light.id = 'same';
    expect(byId(shadow, 'same')).toBe(shadow.getElementById('same'));
    expect(byId(document, 'same')).toBe(light);
    expect(byId(shadow, 'none')).toBeNull();
    expect(byId(document, 'only-in-shadow')).toBeNull();
  });

  it('does not see into a shadow root from the document', () => {
    shadowWith('<input id="hidden-away">');
    expect(byId(document, 'hidden-away')).toBeNull();
  });
});

describe('isTypingTarget', () => {
  const press = (target: EventTarget | null, path?: EventTarget[]) => ({ target, composedPath: () => path ?? (target === null ? [] : [target]) });

  it('is true for a field and for what is inside an editable region', () => {
    const doc = document.body.appendChild(document.createElement('div'));
    doc.innerHTML = '<input id="i"><textarea id="t"></textarea><select id="s"></select><div contenteditable="true"><b id="e">x</b></div><div role="textbox"><i id="r">x</i></div>';
    for (const id of ['i', 't', 's', 'e', 'r']) expect(isTypingTarget(press(doc.querySelector(`#${id}`))), id).toBe(true);
  });

  it('is false for a button, a link, the body and nothing', () => {
    const doc = document.body.appendChild(document.createElement('div'));
    doc.innerHTML = '<button id="b">x</button><a id="a" href="#x">x</a><div contenteditable="false"><span id="n">x</span></div>';
    for (const id of ['b', 'a', 'n']) expect(isTypingTarget(press(doc.querySelector(`#${id}`))), id).toBe(false);
    expect(isTypingTarget(press(document.body))).toBe(false);
    expect(isTypingTarget(press(null))).toBe(false);
  });

  it('reads the real origin of the event, not the host the browser retargets it to', () => {
    const shadow = shadowWith('<input id="f">');
    const input = shadow.getElementById('f') as HTMLElement;
    // A listener outside the shadow root sees `target` as the host; the path still starts at the input.
    expect(isTypingTarget(press(shadow.host, [input, shadow, shadow.host, document.body]))).toBe(true);
    expect(isTypingTarget(press(input, []))).toBe(true);
  });

  it('is false when the event came from a button in a shadow root even if the host sits in a field-like region', () => {
    const shadow = shadowWith('<button id="b">x</button>');
    const button = shadow.getElementById('b') as HTMLElement;
    expect(isTypingTarget(press(shadow.host, [button, shadow, shadow.host]))).toBe(false);
  });

  it('works on a real dispatched event', () => {
    const shadow = shadowWith('<input id="f">');
    const input = shadow.getElementById('f') as HTMLElement;
    let seen: boolean | null = null;
    document.body.addEventListener('keydown', (e) => {
      seen = isTypingTarget(e);
    });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, composed: true }));
    expect(seen).toBe(true);
  });
});
