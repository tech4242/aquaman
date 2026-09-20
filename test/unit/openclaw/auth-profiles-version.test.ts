import { describe, it, expect } from 'vitest';
import {
  parseCalendarVersion,
  authProfilesAreSqliteOnly,
  legacyAuthProfilesBlockProviders,
  pluginInstallNeedsCapabilityConsent,
} from 'aquaman-proxy';

describe('parseCalendarVersion', () => {
  it('parses an OpenClaw calendar version', () => {
    expect(parseCalendarVersion('2026.6.6')).toEqual([2026, 6, 6]);
  });

  it('extracts a version from noisy output', () => {
    expect(parseCalendarVersion('openclaw 2026.5.12')).toEqual([2026, 5, 12]);
  });

  it('returns null for missing/unparseable input', () => {
    expect(parseCalendarVersion(undefined)).toBeNull();
    expect(parseCalendarVersion('')).toBeNull();
    expect(parseCalendarVersion('nightly')).toBeNull();
  });
});

describe('authProfilesAreSqliteOnly', () => {
  // openclaw/openclaw#89102 removed the runtime auth-profiles.json read path
  // in 2026.6.5; provider auth profiles moved to openclaw-agent.sqlite.
  it('is true at the 2026.6.5 boundary', () => {
    expect(authProfilesAreSqliteOnly('2026.6.5')).toBe(true);
  });

  it('is true for later versions', () => {
    expect(authProfilesAreSqliteOnly('2026.6.6')).toBe(true);
    expect(authProfilesAreSqliteOnly('2026.7.1')).toBe(true);
    expect(authProfilesAreSqliteOnly('2027.1.1')).toBe(true);
  });

  it('is false before the boundary', () => {
    expect(authProfilesAreSqliteOnly('2026.6.4')).toBe(false);
    expect(authProfilesAreSqliteOnly('2026.5.12')).toBe(false);
    expect(authProfilesAreSqliteOnly('2026.4.24')).toBe(false);
    expect(authProfilesAreSqliteOnly('2025.12.31')).toBe(false);
  });

  it('defaults to false (legacy JSON path) for unknown versions', () => {
    expect(authProfilesAreSqliteOnly(undefined)).toBe(false);
    expect(authProfilesAreSqliteOnly('nightly')).toBe(false);
  });
});

describe('OpenClaw 2.0 (2026.8.1+) gates', () => {
  // #114033: a legacy auth-profiles.json now BLOCKS providers
  // (AUTH_PROFILE_MIGRATION_REQUIRED) instead of being ignored. Verified on
  // 2026.9.1; 2026.7.33 still ignores it.
  it.each([
    ['2026.7.33', false],
    ['2026.7.99', false],
    ['2026.8.1', true],
    ['2026.8.1-beta.3', true],
    ['2026.9.1', true],
    ['2026.9.4', true],
    ['2027.1.1', true],
    [undefined, false],
  ])('legacyAuthProfilesBlockProviders(%s) → %s', (version, expected) => {
    expect(legacyAuthProfilesBlockProviders(version as string | undefined)).toBe(expected);
  });

  // Capability consent for third-party plugin install/enable arrived with the
  // same line; 2026.7.33 rejects --accept-capabilities as unknown.
  it.each([
    ['2026.7.33', false],
    ['2026.8.1', true],
    ['2026.9.1', true],
    [null, false],
  ])('pluginInstallNeedsCapabilityConsent(%s) → %s', (version, expected) => {
    expect(pluginInstallNeedsCapabilityConsent(version as string | null)).toBe(expected);
  });
});
