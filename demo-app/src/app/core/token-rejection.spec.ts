import { isTokenRejected } from './spacetime.service';

class WebSocketTokenError extends Error {
  constructor(readonly status: number) {
    super(`Failed to verify token: ${status} X`);
    this.name = 'WebSocketTokenError';
  }
}

describe('isTokenRejected', () => {
  it('is true for 401/403 token verification failures', () => {
    expect(isTokenRejected(new WebSocketTokenError(401))).toBe(true);
    expect(isTokenRejected(new WebSocketTokenError(403))).toBe(true);
    expect(isTokenRejected(new Error('Failed to verify token: 401 Unauthorized'))).toBe(true);
  });

  it('is false for unreachable-server and server-side errors', () => {
    expect(isTokenRejected(new TypeError('Failed to fetch'))).toBe(false);
    expect(isTokenRejected(new WebSocketTokenError(502))).toBe(false);
    expect(isTokenRejected(new Error('WebSocket connection failed'))).toBe(false);
    expect(isTokenRejected(undefined)).toBe(false);
  });
});
