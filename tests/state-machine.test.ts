import { ReaderStateMachine } from '../src/core/state-machine';

describe('ReaderStateMachine', () => {
  let sm: ReaderStateMachine;

  beforeEach(() => {
    sm = new ReaderStateMachine();
  });

  test('initial state is idle with no session', () => {
    expect(sm.state).toBe('idle');
    expect(sm.sessionId).toBe('');
    expect(sm.lastError).toBeNull();
  });

  test('startSession transitions to acquiring and binds sessionId', () => {
    const session = 'session-101';
    const res = sm.startSession(session);
    expect(res.from).toBe('idle');
    expect(res.to).toBe('acquiring');
    expect(sm.state).toBe('acquiring');
    expect(sm.sessionId).toBe(session);
  });

  test('valid state progression: acquiring -> preparing -> playing -> paused -> playing -> stopping -> idle', () => {
    const session = 'session-progression';
    sm.startSession(session);

    sm.transitionTo('preparing', session);
    expect(sm.state).toBe('preparing');

    sm.transitionTo('playing', session);
    expect(sm.state).toBe('playing');

    sm.transitionTo('paused', session);
    expect(sm.state).toBe('paused');

    sm.transitionTo('playing', session);
    expect(sm.state).toBe('playing');

    sm.transitionTo('stopping', session);
    expect(sm.state).toBe('stopping');

    sm.transitionTo('idle', session);
    expect(sm.state).toBe('idle');
  });

  test('rejects stale or mismatched sessionId', () => {
    sm.startSession('valid-session');
    expect(() => {
      sm.transitionTo('preparing', 'stale-session');
    }).toThrow(/Session mismatch/);
  });

  test('rejects invalid state transitions', () => {
    sm.startSession('session-1');
    expect(() => {
      sm.transitionTo('playing', 'session-1');
    }).toThrow(/Invalid state transition/);
  });

  test('records error state and error message', () => {
    const session = 'error-session';
    sm.startSession(session);
    sm.transitionTo('error', session, 'Network timeout');
    expect(sm.state).toBe('error');
    expect(sm.lastError).toBe('Network timeout');
  });
});
