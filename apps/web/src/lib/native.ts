import { Channel, invoke } from '@tauri-apps/api/core'

// The Rust side of the desktop app (apps/desktop): notebooks on disk, keys in the keychain,
// model calls, sign-ins and voice. Its errors come back as { code, message }.

export const isDesktop = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

/** A failed native call, with the Rust error code (`not_found`, `no_key`, …). */
export class NativeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function toError(e: unknown): Error {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    const { code, message } = e as { code: string; message: string }
    return new NativeError(code, message)
  }
  return e instanceof Error ? e : new NativeError('unknown', String(e))
}

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args)
  } catch (e) {
    throw toError(e)
  }
}

/** Sends bytes as the request body, with string headers (page saves, imported files). */
export async function callBytes<T>(
  cmd: string,
  body: Uint8Array | ArrayBuffer,
  headers: Record<string, string>,
): Promise<T> {
  try {
    return await invoke<T>(cmd, body instanceof ArrayBuffer ? new Uint8Array(body) : body, {
      headers,
    })
  } catch (e) {
    throw toError(e)
  }
}

/** A command that answers with raw bytes. */
export async function callForBytes(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<Uint8Array> {
  const out = await call<ArrayBuffer | number[]>(cmd, args)
  return out instanceof ArrayBuffer ? new Uint8Array(out) : new Uint8Array(out)
}

type StreamEvent =
  | { kind: 'head'; status: number; content_type: string }
  | { kind: 'data'; text: string }
  | { kind: 'end' }
  | { kind: 'error'; message: string }

let nextStream = 1

/**
 * Runs a streaming command and hands back an ordinary `Response` whose body fills as the
 * model's reply arrives, so the SSE parsers in ai-core work unchanged. Aborting `signal`
 * stops the upstream request in Rust.
 */
export function streamResponse(
  cmd: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const id = nextStream++
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let settled = false
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
    cancel() {
      void invoke('ai_abort', { id }).catch(() => {})
    },
  })
  return new Promise<Response>((resolve, reject) => {
    const fail = (err: Error) => {
      if (!settled) {
        settled = true
        reject(err)
      } else {
        try {
          controller?.error(err)
        } catch {}
      }
    }
    const onAbort = () => {
      void invoke('ai_abort', { id }).catch(() => {})
      fail(new DOMException('The request was aborted.', 'AbortError'))
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })

    const channel = new Channel<StreamEvent>()
    channel.onmessage = (ev) => {
      switch (ev.kind) {
        case 'head':
          settled = true
          resolve(
            new Response(body, {
              status: ev.status,
              headers: { 'Content-Type': ev.content_type },
            }),
          )
          break
        case 'data':
          try {
            controller?.enqueue(encoder.encode(ev.text))
          } catch {}
          break
        case 'end':
          signal.removeEventListener('abort', onAbort)
          try {
            controller?.close()
          } catch {}
          break
        case 'error':
          signal.removeEventListener('abort', onAbort)
          fail(new TypeError(ev.message))
          break
      }
    }
    invoke(cmd, { ...args, id, onEvent: channel }).catch((e) => fail(toError(e)))
  })
}
