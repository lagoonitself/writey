import { describe, expect, it } from 'vitest'
import { sayMath, sentences, speakable } from './speech'
import { addressed, voiceCommand } from './trigger'

describe('addressed', () => {
  it('wakes on "Hey" at the start', () => {
    expect(addressed("Hey, what's next?")).toEqual({ request: "what's next?" })
    expect(addressed('hey Writey solve this')).toEqual({ request: 'solve this' })
    expect(addressed('Hey Righty, is this right')).toEqual({ request: 'is this right' })
    expect(addressed('ok hey. explain the full adder')).toEqual({
      request: 'explain the full adder',
    })
    expect(addressed('Hey.')).toEqual({ request: '' })
  })

  it('still answers to the name', () => {
    expect(addressed("Writey, what's next?")).toEqual({ request: "what's next?" })
  })

  it('ignores everything else', () => {
    expect(addressed('so the derivative of x squared is 2x')).toBeNull()
    expect(addressed('')).toBeNull()
    expect(addressed('write it down')).toBeNull()
    expect(addressed('they said hey to me')).toBeNull()
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
