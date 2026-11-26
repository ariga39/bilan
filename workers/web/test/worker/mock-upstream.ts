export interface UpstreamCall {
  url: string;
  method: string;
  authorization: string | null;
  redirect: RequestInit["redirect"] | undefined;
}

export interface UpstreamReply {
  status?: number;
  body?: unknown;
}

export interface UpstreamMock {
  calls: Array<UpstreamCall>;
  restore(): void;
}

export function mockUpstream(handler: (call: UpstreamCall) => UpstreamReply): UpstreamMock {
  const originalFetch = globalThis.fetch;
  const calls: Array<UpstreamCall> = [];

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : "url" in input ? input.url : String(input);
    const headers = new Headers(init?.headers);
    const call: UpstreamCall = {
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      redirect: init?.redirect,
    };
    calls.push(call);

    const reply = handler(call);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };

  globalThis.fetch = fakeFetch;

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}
