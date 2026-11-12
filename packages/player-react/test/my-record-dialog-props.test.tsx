import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MyRecord } from '../src/MyRecord.js';
import { FIXED, renderUi } from './render.js';
import { ALICE, playerWorld } from './world.js';

// MyRecord opens AppealDialog with the props the dialog takes and nothing else: not the host's own appealUrl, appeals or refreshKey.

const seen: Array<Record<string, unknown>> = [];
vi.mock('../src/AppealDialog.js', () => ({
  AppealDialog: (props: Record<string, unknown>) => {
    seen.push(props);
    return <p>the dialog</p>;
  },
}));

describe('MyRecord hands AppealDialog only its own props', () => {
  it('the common props and the dialog-host props go, the three of the record itself do not', async () => {
    const w = await playerWorld({ appeals: {} });
    await w.warn(ALICE);
    const container = document.createElement('div');
    document.body.append(container);
    const { user } = renderUi(
      <MyRecord client={w.client} appeals appealUrl="https://game.test/appeal" refreshKey={3} container={container} returnFocusTo={() => null} theme="dark" className="mine" {...FIXED} now={w.now} />,
    );
    await user.click(await screen.findByRole('button', { name: 'Think this is a mistake?' }));
    await screen.findByText('the dialog');
    const props = seen[seen.length - 1] as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['className', 'client', 'container', 'locale', 'noticeId', 'now', 'onClose', 'returnFocusTo', 'theme', 'timeZone'].sort());
    expect(props.noticeId).toBe(w.noticeOf(ALICE));
    expect(props.container).toBe(container);
    expect(props.theme).toBe('dark');
    expect('appealUrl' in props).toBe(false);
    expect('appeals' in props).toBe(false);
    expect('refreshKey' in props).toBe(false);
  });

  it('props the host did not set are not passed as undefined keys', async () => {
    const w = await playerWorld({ appeals: {} });
    await w.warn(ALICE);
    const { user } = renderUi(<MyRecord client={w.client} appeals />);
    await user.click(await screen.findByRole('button', { name: 'Think this is a mistake?' }));
    await screen.findByText('the dialog');
    const props = seen[seen.length - 1] as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['client', 'noticeId', 'onClose']);
  });
});
