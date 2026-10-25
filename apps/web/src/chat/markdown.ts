import DOMPurify from 'dompurify'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { marked } from 'marked'
import { extractMath, PLACEHOLDER_RE } from './math'

// Model replies are untrusted (a PDF could carry a prompt injection), so the Markdown
// HTML is sanitized before KaTeX's own output is put back in.

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

export function renderMarkdown(src: string): string {
  const { text, math } = extractMath(src)
  const html = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }))
  return html.replace(PLACEHOLDER_RE, (_, n: string) => {
    const m = math[Number(n)]
    if (!m) return ''
    return katex.renderToString(m.tex, {
      displayMode: m.display,
      throwOnError: false,
      output: 'htmlAndMathml',
    })
  })
}
