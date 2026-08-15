/**
 * Shareable download links.
 *
 * Two things about the URL are load-bearing and neither is obvious:
 *
 *   host   gateway.ethswarm.org/bzz/<ref> serves the gateway's own web app and
 *          answers 200 with an HTML page. A link built from it looks correct,
 *          returns 200, and downloads nothing. download.gateway.ethswarm.org
 *          serves the bytes. Verified against a real upload: 326,163 bytes,
 *          content-type image/png, byte-identical to the file sent.
 *
 *   slash  without a trailing slash the gateway answers 308 to add one. Some
 *          clients follow that and some do not, so the link carries it.
 */
import { describe, expect, it } from 'bun:test';
import { loadConfig } from '../src/config';
import { applySettings } from '../src/settings';

const REF = '628b6857540580b70acc0461a67518e8afafd94dc523da0eb166386500440296';
const base = { BEE_URL: 'http://bee:1633' } as any;

/** Mirrors shareUrl() in the dashboard. */
const shareUrl = (gw: string, ref: string) => `${gw.replace(/\/+$/, '')}/bzz/${ref}/`;

describe('gateway configuration', () => {
  it('defaults to the host that actually serves files', () => {
    const cfg = loadConfig(base);
    expect(cfg.publicGatewayUrl).toBe('https://download.gateway.ethswarm.org');
    // The one that looks right and is not.
    expect(cfg.publicGatewayUrl).not.toContain('//gateway.ethswarm.org');
  });

  it('is overridable, for a private or self-hosted gateway', () => {
    expect(loadConfig({ ...base, PUBLIC_GATEWAY_URL: 'https://swarm.example.org' }).publicGatewayUrl)
      .toBe('https://swarm.example.org');
  });

  it('strips trailing slashes so links never double up', () => {
    expect(loadConfig({ ...base, PUBLIC_GATEWAY_URL: 'https://x.org//' }).publicGatewayUrl)
      .toBe('https://x.org');
    expect(applySettings(loadConfig(base), { publicGatewayUrl: 'https://y.org/' }).publicGatewayUrl)
      .toBe('https://y.org');
  });
});

describe('shareUrl', () => {
  it('keeps the trailing slash, which avoids a 308', () => {
    expect(shareUrl('https://download.gateway.ethswarm.org', REF))
      .toBe(`https://download.gateway.ethswarm.org/bzz/${REF}/`);
  });

  it('does not double the slash when the base has one', () => {
    expect(shareUrl('https://download.gateway.ethswarm.org/', REF))
      .toBe(`https://download.gateway.ethswarm.org/bzz/${REF}/`);
  });

  it('produces exactly the URL verified against the live gateway', () => {
    // curl -o file -w '%{http_code} %{size_download}' on this URL returned
    // 200 / 326163 and the bytes matched the upload.
    expect(shareUrl(loadConfig(base).publicGatewayUrl, REF))
      .toBe('https://download.gateway.ethswarm.org/bzz/628b6857540580b70acc0461a67518e8afafd94dc523da0eb166386500440296/');
  });
});
