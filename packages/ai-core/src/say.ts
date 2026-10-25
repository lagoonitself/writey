// Spoken replies (docs §7.2): a chat answer may open with <say>…</say>, the words Writey says
// out loud. Both arrive as one stream, so they're split as they come in.

const OPEN = '<say>'
const CLOSE = '</say>'

/** Keeps the end of `s` that could be the start of `tag`, so a tag split across chunks isn't lost. */
function partial(s: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
    if (tag.startsWith(s.slice(-n))) return n
  }
  return 0
}

export class SaySplitter {
  private state: 'start' | 'say' | 'text' = 'start'
  private buf = ''

  /** Returns the spoken and the written text in this chunk (either may be empty). */
  push(chunk: string): { say: string; text: string } {
    this.buf += chunk
    let say = ''
    let text = ''
    if (this.state === 'start') {
      const lead = this.buf.trimStart()
      if (lead.startsWith(OPEN)) {
        this.state = 'say'
        this.buf = lead.slice(OPEN.length)
      } else if (OPEN.startsWith(lead)) {
        return { say, text }
      } else {
        this.state = 'text'
      }
    }
    if (this.state === 'say') {
      const end = this.buf.indexOf(CLOSE)
      if (end === -1) {
        const keep = partial(this.buf, CLOSE)
        say = this.buf.slice(0, this.buf.length - keep)
        this.buf = this.buf.slice(this.buf.length - keep)
        return { say, text }
      }
      say = this.buf.slice(0, end)
      this.buf = this.buf.slice(end + CLOSE.length).replace(/^\s+/, '')
      this.state = 'text'
    }
    text = this.buf
    this.buf = ''
    return { say, text }
  }

  /** Whatever is still held back when the stream ends. */
  end(): { say: string; text: string } {
    const rest = this.buf
    this.buf = ''
    if (this.state === 'say') return { say: rest, text: '' }
    return { say: '', text: rest }
  }
}

/** Collects streamed words and hands out whole sentences, so speech can start early. */
export class SentenceBuffer {
  private buf = ''

  push(text: string): string[] {
    this.buf += text
    const out: string[] = []
    const re = /[^.!?]*[.!?]+["')\]]*\s+/y
    let m: RegExpExecArray | null
    let at = 0
    re.lastIndex = 0
    // biome-ignore lint/suspicious/noAssignInExpressions: a sticky regex walks the buffer
    while ((m = re.exec(this.buf))) {
      const s = m[0].trim()
      if (s) out.push(s)
      at = re.lastIndex
    }
    this.buf = this.buf.slice(at)
    return out
  }

  flush(): string[] {
    const rest = this.buf.trim()
    this.buf = ''
    return rest ? [rest] : []
  }
}
