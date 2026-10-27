import { afterEach, describe, expect, it, vi } from "vitest";
import { CodesurfCardStream } from "./native/codesurf-card-stream";

const streams: CodesurfCardStream[] = [];
afterEach(() => { for (const stream of streams.splice(0)) stream.close(); vi.restoreAllMocks(); });
function makeClient() {
  const client = new CodesurfCardStream("http://localhost:1", "secret", "card-a");
  streams.push(client);
  return client;
}
function source() {
  let sink!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: c => { sink = c; } });
  return { stream, emit: (event: object) => sink.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\r\n\r\n`)), end: () => sink.close() };
}
const event = (jobId: string, sequence: number, type = "text") => ({ jobId, sequence, type, text: `${jobId}-${sequence}` });

describe("persistent CodeSurf card SSE", () => {
  it("opens before submission and reuses one connection across jobs, including early events", async () => {
    const upstream = source();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(upstream.stream));
    const client = makeClient();
    expect(await client.prepare()).toBe(true);
    upstream.emit(event("one", 1));
    await Promise.resolve();
    const first = client.openJob("one", 0, new AbortController().signal).body!.getReader();
    expect(new TextDecoder().decode((await first.read()).value)).toContain("one-1");
    upstream.emit(event("one", 2, "done"));
    expect(new TextDecoder().decode((await first.read()).value)).toContain('"done"');
    await first.cancel();
    client.finishJob("one");
    expect(await client.prepare()).toBe(true);
    const second = client.openJob("two", 0, new AbortController().signal).body!.getReader();
    upstream.emit(event("one", 3)); // stale previous job must never enter this turn
    upstream.emit(event("two", 1));
    expect(new TextDecoder().decode((await second.read()).value)).toContain("two-1");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain("/chat/card/events?cardId=card-a");
    await second.cancel();
  });

  it("reconnects with the active job cursor and drops duplicate replay", async () => {
    const a = source(), b = source();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(a.stream)).mockResolvedValueOnce(new Response(b.stream));
    const client = makeClient();
    await client.prepare();
    const reader = client.openJob("job", 0, new AbortController().signal).body!.getReader();
    a.emit(event("job", 1));
    await reader.read();
    a.end();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(String(fetch.mock.calls[1][0])).toContain("jobId=job&since=1");
    b.emit(event("job", 1));
    b.emit(event("job", 2));
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("job-2");
    await reader.cancel();
  });

  it("aborts a turn without aborting the physical connection", async () => {
    const upstream = source();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(upstream.stream));
    const client = makeClient();
    await client.prepare();
    const abort = new AbortController();
    const reader = client.openJob("job", 0, abort.signal).body!.getReader();
    const read = reader.read();
    abort.abort();
    await expect(read).rejects.toThrow("Aborted");
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
    client.close();
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("only falls back for an unsupported endpoint, not an authentication error", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 404 }));
    const client = makeClient();
    expect(await client.prepare()).toBe(false);
    expect(await client.prepare()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(new Response("", { status: 401 }));
    await expect(makeClient().prepare()).rejects.toThrow("401");
  });
});
