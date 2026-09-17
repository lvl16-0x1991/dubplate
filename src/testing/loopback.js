import { createMediaBackend } from '../player/ytdlp.js';

// Deliberate test dependency. No production config or IPC accepts a URL policy.
export function createLoopbackTestBackend(origin) {
  const fixture = new URL(origin);
  if (fixture.protocol !== 'http:' || fixture.hostname !== '127.0.0.1' || !fixture.port
    || fixture.username || fixture.password || fixture.pathname !== '/' || fixture.search || fixture.hash) {
    throw new Error('The audio fixture must be an exact http://127.0.0.1:PORT origin.');
  }
  return createMediaBackend((input) => {
    const parsed = new URL(input);
    if (parsed.origin !== fixture.origin || parsed.username || parsed.password) throw new Error('The URL is outside the isolated audio fixture.');
    return parsed.href;
  });
}
