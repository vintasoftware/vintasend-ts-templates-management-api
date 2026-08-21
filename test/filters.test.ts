/**
 * Capability negotiation: what a query becomes once the backend has had its say.
 *
 * Pinned separately from the route tests because the interesting cases are backends this repo does
 * not ship — a store on a case-insensitive collation, one that keeps no tags — and building a fake
 * for each is cheaper here than standing up an app around it.
 */

import { describe, expect, it } from 'vitest';

import { buildBackendFilter, buildStatusFilter, buildStringFilter } from '../src/domain/filters.js';
import { templateListQuerySchema } from '../src/domain/schemas.js';

function query(search: string) {
  const params = new URLSearchParams(search);
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    raw[key] = values.length === 1 ? (values[0] as string) : values;
  }
  return templateListQuerySchema.parse(raw);
}

describe('buildStringFilter', () => {
  it('prefers a case-insensitive substring match when the backend has one', () => {
    expect(buildStringFilter('welcome', {})).toEqual({
      lookup: 'includes',
      value: 'welcome',
      caseSensitive: false,
    });
  });

  it('asks for a case-sensitive substring when the backend cannot fold case', () => {
    expect(buildStringFilter('welcome', { 'stringLookups.caseInsensitive': false })).toEqual({
      lookup: 'includes',
      value: 'welcome',
      caseSensitive: true,
    });
  });

  it('falls back to a case-insensitive exact match without substring support', () => {
    expect(buildStringFilter('welcome', { 'stringLookups.includes': false })).toEqual({
      lookup: 'exact',
      value: 'welcome',
      caseSensitive: false,
    });
  });

  it('falls back to a bare equality match when the backend has neither', () => {
    expect(
      buildStringFilter('welcome', {
        'stringLookups.includes': false,
        'stringLookups.caseInsensitive': false,
      }),
    ).toBe('welcome');
  });
});

describe('buildStatusFilter', () => {
  it('makes one status a bare exact match', () => {
    expect(buildStatusFilter(['active'])).toBe('active');
  });

  it('makes several an in lookup', () => {
    expect(buildStatusFilter(['active', 'draft'])).toEqual({
      lookup: 'in',
      value: ['active', 'draft'],
    });
  });
});

describe('buildBackendFilter', () => {
  it('applies the one-row-per-key default without being asked', () => {
    expect(buildBackendFilter(query(''), {})).toEqual({ mostRecentActiveVersion: true });
  });

  it('sends no filter at all when the default is switched off', () => {
    // `false` would ask the backend for the *complement* — the older and retired rows on their own
    // — which is not what turning a default off means.
    expect(buildBackendFilter(query('mostRecentActiveVersion=false'), {})).toEqual({});
  });

  it('treats isAbstract=false as a filter rather than an absent parameter', () => {
    expect(buildBackendFilter(query('mostRecentActiveVersion=false&isAbstract=false'), {})).toEqual(
      { isAbstract: false },
    );
  });

  it('combines every field with AND', () => {
    const filter = buildBackendFilter(
      query('key=welcome&version=2&status=active&includesAllTags=a&includesAllTags=b'),
      {},
    );

    expect(filter).toMatchObject({
      key: { lookup: 'includes', value: 'welcome', caseSensitive: false },
      version: 2,
      status: 'active',
      includesAllTags: ['a', 'b'],
      mostRecentActiveVersion: true,
    });
  });

  it('builds a date range from either bound alone', () => {
    const from = buildBackendFilter(query('createdAtFrom=2026-01-01T00:00:00Z'), {});
    const to = buildBackendFilter(query('updatedAtTo=2026-02-01T00:00:00Z'), {});

    expect(from.createdAtRange).toEqual({ from: new Date('2026-01-01T00:00:00Z') });
    expect(to.updatedAtRange).toEqual({ to: new Date('2026-02-01T00:00:00Z') });
  });

  it('drops every field the backend declares it cannot filter on', () => {
    const filter = buildBackendFilter(
      query('key=welcome&name=hi&version=2&status=active&includesAllTags=a&isAbstract=true'),
      {
        'fields.key': false,
        'fields.name': false,
        'fields.version': false,
        'fields.status': false,
        'fields.includesAllTags': false,
        'fields.isAbstract': false,
        'fields.mostRecentActiveVersion': false,
      },
    );

    expect(filter).toEqual({});
  });
});

describe('templateListQuerySchema', () => {
  it('accepts a repeated parameter and a single one alike', () => {
    expect(query('status=draft').status).toEqual(['draft']);
    expect(query('status=draft&status=active').status).toEqual(['draft', 'active']);
  });

  it('drops blank tags but refuses a list that was nothing but blanks', () => {
    expect(query('includesAllTags=a&includesAllTags=%20').includesAllTags).toEqual(['a']);
    expect(() => query('includesAllTags=%20')).toThrow(/At least one non-empty tag/);
  });

  it('refuses a tag list past the documented maximum', () => {
    const tooMany = Array.from({ length: 51 }, (_, index) => `includesAllTags=t${index}`).join('&');

    expect(() => query(tooMany)).toThrow();
  });

  it('refuses a boolean that is neither true nor false', () => {
    expect(() => query('mostRecentActiveVersion=maybe')).toThrow();
  });
});
