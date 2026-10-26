import { describe, expect, it } from 'vitest'
import { produceSystem, SaySplitter, SentenceBuffer } from '../src'

function split(chunks: string[]) {
  const s = new SaySplitter()
  let say = ''
  let text = ''
  for (const c of [...chunks.map((x) => s.push(x)), s.end()]) {
    say += c.say
    text += c.text
  }
  return { say, text }
}

describe('SaySplitter', () => {
  it('separates the spoken part, even when tags are split across chunks', () => {
    expect(
      split(['<sa', 'y>Sure, look at', ' the second line.</s', 'ay>\n\nThe **idea**']),
    ).toEqual({
      say: 'Sure, look at the second line.',
      text: 'The **idea**',
    })
  })

  it('passes a reply without <say> straight through', () => {
    expect(split(['The ', 'answer is $2$.'])).toEqual({ say: '', text: 'The answer is $2$.' })
  })

  it('treats an unclosed <say> as all spoken', () => {
    expect(split(['  <say>Hi there', '!'])).toEqual({ say: 'Hi there!', text: '' })
  })
})

describe('SentenceBuffer', () => {
  it('hands out whole sentences as they complete', () => {
    const b = new SentenceBuffer()
    expect(b.push('Good question. The bound')).toEqual(['Good question.'])
    expect(b.push('ary term is zero! Does that')).toEqual(['The boundary term is zero!'])
    expect(b.flush()).toEqual(['Does that'])
  })
})

describe('spoken prompts', () => {
  it('asks for a say part only when Writey is talking', () => {
    expect(produceSystem('write', 'next_step', true)).toContain('"type":"say"')
    expect(produceSystem('write', 'next_step')).not.toContain('"type":"say"')
    expect(produceSystem('explain', 'next_step', true)).toContain('<say>')
    expect(produceSystem('write', 'next_step')).toContain('must NOT copy the page')
  })
})
