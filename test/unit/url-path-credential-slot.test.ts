/**
 * Unit tests for the url-path credential slot parser (v0.15.0+).
 *
 * Telegram carries its token as a path segment rather than a header, so a
 * client pointed at the proxy sends the segment itself. Finding it wrong means
 * either stacking two tokens (request fails) or treating a method name as a
 * credential (request goes somewhere unexpected).
 */

import { describe, it, expect } from 'vitest';
import { findUrlPathCredentialSlot } from 'aquaman-proxy';

const TELEGRAM = '/bot{token}';
const find = (path: string, template = TELEGRAM) =>
  findUrlPathCredentialSlot(path.split('/').filter(s => s), template);

describe('findUrlPathCredentialSlot', () => {
  it('finds the bot segment at the front', () => {
    expect(find('/bot123:ABC/sendMessage')).toEqual({ index: 0, presented: '123:ABC' });
  });

  it('finds the bot segment in the file-download shape', () => {
    expect(find('/file/bot123:ABC/photos/f.jpg')).toEqual({ index: 1, presented: '123:ABC' });
  });

  it('returns null when the client sent no credential segment', () => {
    expect(find('/sendMessage')).toBeNull();
    expect(find('/')).toBeNull();
  });

  it('ignores a bare prefix with nothing after it', () => {
    expect(find('/bot/sendMessage')).toBeNull();
  });

  it('does not scan past the first two segments', () => {
    // A file_path that happens to start with "bot" is not a credential.
    expect(find('/file/bot123:ABC/bot-pictures/x.jpg')).toEqual({
      index: 1,
      presented: '123:ABC'
    });
    expect(find('/getUpdates/photos/botNOTATOKEN')).toBeNull();
  });

  it('keeps the query string out of a leading slot', () => {
    expect(find('/bot123:ABC/getUpdates?offset=1')).toEqual({ index: 0, presented: '123:ABC' });
  });

  it('handles a template with no leading slash', () => {
    expect(find('/bot123:ABC/getMe', 'bot{token}')).toEqual({ index: 0, presented: '123:ABC' });
  });

  it('handles a template with a suffix around the token', () => {
    expect(find('/v1-abc-key/send', '/v1-{token}-key')).toEqual({ index: 0, presented: 'abc' });
  });

  it('returns null for a multi-segment template it cannot place', () => {
    expect(find('/bot123/getMe', '/a/{token}')).toBeNull();
  });

  it('returns null for a template with no token placeholder', () => {
    expect(find('/bot123/getMe', '/static')).toBeNull();
  });
});
