/**
 * Capture page screenshots over the DevTools protocol.
 *
 * Chromium's own --screenshot cannot write to disk in this environment, but
 * Page.captureScreenshot returns base64 over the wire, so this process writes
 * the file instead.
 *
 * Usage: bun shoot.ts <out-dir> <base-url> <spec.json>
 * spec: [{ name, path, width, height, scrollTo?, waitMs? }, ...]
 */
const [outDir, baseUrl, specPath] = process.argv.slice(2);
const spec = JSON.parse(await Bun.file(specPath).text());

const endpoint = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9222}/json/version`)).json();
const ws = new WebSocket(endpoint.webSocketDebuggerUrl);
await new Promise<void>((r) => { ws.onopen = () => r(); });

let id = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (e) => {
  const msg = JSON.parse(String(e.data));
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg.result); pending.delete(msg.id); }
};
const send = (method: string, params: any = {}, sessionId?: string): Promise<any> => {
  const mid = ++id;
  return new Promise((resolve) => {
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
};

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const s = (m: string, p: any = {}) => send(m, p, sessionId);

await s('Page.enable');
await s('Runtime.enable');

for (const shot of spec) {
  await s('Emulation.setDeviceMetricsOverride', {
    width: shot.width, height: shot.height, deviceScaleFactor: shot.scale ?? 2, mobile: !!shot.mobile,
  });
  await s('Page.navigate', { url: baseUrl + shot.path });
  await new Promise((r) => setTimeout(r, shot.waitMs ?? 3000));
  if (shot.scrollTo != null) {
    await s('Runtime.evaluate', { expression: `window.scrollTo(0, ${shot.scrollTo}); 1` });
    await new Promise((r) => setTimeout(r, 500));
  }
  if (shot.js) {
    await s('Runtime.evaluate', { expression: shot.js, awaitPromise: true });
    await new Promise((r) => setTimeout(r, shot.afterJsMs ?? 700));
  }
  const { data } = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await Bun.write(`${outDir}/${shot.name}.png`, Buffer.from(data, 'base64'));
  console.log(`  wrote ${shot.name}.png  (${shot.width}x${shot.height} @${shot.scale ?? 2}x)`);
}

ws.close();
process.exit(0);
