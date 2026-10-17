import sanitizeHtml from 'sanitize-html'

// Mirrors the tags the composer's rich-text editor can produce (frontend/lib/sanitize.ts).
const ALLOWED_TAGS = [
  'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del',
  'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'a', 'font',
]

/** Server-side sanitization: stored HTML is what gets sent, so never trust the client's markup. */
export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href', 'rel'], font: ['size'], '*': ['align', 'style'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedStyles: { '*': { 'text-align': [/^(left|right|center|justify)$/] } },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
    },
    disallowedTagsMode: 'discard',
  }).trim()
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }

/** Plain-text alternative derived from sanitized HTML. */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-3]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
  const stripped = sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} })
  return stripped
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function toPreview(text: string, length = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > length ? `${flat.slice(0, length).trimEnd()}…` : flat
}
