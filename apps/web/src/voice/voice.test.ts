import { describe, expect, it } from 'vitest'
import { sayMath, sentences, speakable } from './speech'
import { addressed, voiceCommand } from './trigger'

describe('addressed', () => {
  it('hears the name at the start, after fillers, or at the end', () => {
    expect(addressed("Writey, what's next?")).toEqual({ kind: 'strong', request: "what's next?" })
    expect(addressed('Hey Righty solve this')).toEqual({ kind: 'strong', request: 'solve this' })
    expect(addressed('ok so wrighty. is this right')).toEqual({
      kind: 'strong',
      request: 'is this right',
    })
    expect(addressed("What's next, Writey?")).toEqual({ kind: 'strong', request: "What's next" })
    expect(addressed("Riety, what's the next step?")?.kind).toBe('strong')
  })

  it('asks before acting on a sound-alike', () => {
    expect(addressed('Ready, what is the next step')).toEqual({
      kind: 'weak',
      request: 'what is the next step',
    })
    expect(addressed('Right he, check this')).toEqual({ kind: 'weak', request: 'check this' })
  })

  it('ignores everything else', () => {
    expect(addressed('so the derivative of x squared is 2x')).toBeNull()
    expect(addressed('')).toBeNull()
    expect(addressed('write it down')).toBeNull()
  })
})

describe('voiceCommand', () => {
  it('maps short commands', () => {
    expect(voiceCommand('keep it')).toBe('accept')
    expect(voiceCommand('Scrap that.')).toBe('discard')
    expect(voiceCommand('scrapped that.')).toBe('discard')
    expect(voiceCommand('Kept it')).toBe('accept')
    expect(voiceCommand('try that again')).toBe('redo')
    expect(voiceCommand('try again')).toBe('redo')
    expect(voiceCommand('stop')).toBe('stop')
  })

  it('leaves questions alone', () => {
    expect(voiceCommand("what's next")).toBeNull()
    expect(voiceCommand('stop and explain why the integral of this one is different')).toBeNull()
  })
})

describe('speech text', () => {
  it('reads simple math aloud', () => {
    expect(sayMath(String.raw`x^2 + \frac{1}{2} = 3`)).toBe('x squared plus 1 over 2 equals 3')
    expect(sayMath(String.raw`\sqrt{a} \cdot \pi`)).toBe('the square root of a times pi')
  })

  it('keeps the first paragraphs of an answer, without Markdown', () => {
    const md = '**Good start.** You used $u = x$.\n\nThen integrate.\n\n- a list\n\n```code```'
    expect(speakable(md)).toBe('Good start. You used u equals x. Then integrate. a list')
  })

  it('splits sentences', () => {
    expect(sentences('One. Two! Three')).toEqual(['One.', 'Two!', 'Three'])
  })
})
