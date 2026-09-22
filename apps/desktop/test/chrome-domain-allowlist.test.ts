import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  normalizeDomain,
  isCookieDomainApproved,
} from '../src/main/chrome-sync/domain-allowlist.ts'

describe('normalizeDomain', () => {
  test('lowercases, trims, and strips leading dots', () => {
    assert.equal(normalizeDomain('  .Example.COM '), 'example.com')
    assert.equal(normalizeDomain('..sub.example.com'), 'sub.example.com')
    assert.equal(normalizeDomain('example.com'), 'example.com')
  })
})

describe('isCookieDomainApproved', () => {
  const approved = ['example.com', 'google.com']

  test('matches the exact domain (with or without a leading dot host_key)', () => {
    assert.equal(isCookieDomainApproved('example.com', approved), true)
    assert.equal(isCookieDomainApproved('.example.com', approved), true)
  })

  test('matches subdomains of an approved domain', () => {
    assert.equal(isCookieDomainApproved('mail.google.com', approved), true)
    assert.equal(isCookieDomainApproved('.accounts.google.com', approved), true)
  })

  test('does NOT match a sibling that merely shares the suffix (dot-boundary guard)', () => {
    assert.equal(isCookieDomainApproved('evilexample.com', approved), false)
    assert.equal(isCookieDomainApproved('notgoogle.com', approved), false)
  })

  test('does not match unrelated domains', () => {
    assert.equal(isCookieDomainApproved('facebook.com', approved), false)
  })

  test('returns false for an empty allowlist (caller decides inject-all separately)', () => {
    assert.equal(isCookieDomainApproved('example.com', []), false)
  })

  test('ignores blank/whitespace entries in the allowlist', () => {
    assert.equal(isCookieDomainApproved('example.com', ['', '   ', 'example.com']), true)
    assert.equal(isCookieDomainApproved('example.com', ['', '   ']), false)
  })

  test('is case-insensitive on both sides', () => {
    assert.equal(isCookieDomainApproved('MAIL.GOOGLE.COM', ['Google.com']), true)
  })
})
