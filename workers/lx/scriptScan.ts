// Lexical scanning of a candidate LX script.
//
// The previous implementation ran one regular expression over the raw source. That is wrong in two
// directions, and both were observed on real scripts:
//
//   * a URL inside a comment was treated as a network origin. Hei Music's header carries
//     `// 参考文档: https://www.lxmusic.cn/docs/music-source/`, so the registry believed the script
//     needed `www.lxmusic.cn` and parked a perfectly good source in `pending_network_approval`;
//   * a URL used as a request *header value* was treated as a destination. Hei Music sends
//     `Referer: https://music.migu.cn/` on its Migu calls, which made `music.migu.cn` look like an
//     origin the deployment had to approve.
//
// Neither is a security property: the sandbox refuses a request the deployment's `connect-src`
// does not allow, at the moment the request is made (`performControlledFetch`). What the registry
// needs from static analysis is an accurate list of *destinations*, so the Owner can see what a
// script will try to reach before publishing it. A comment is not a destination.
//
// So this module tokenises just enough JavaScript to tell code, comments and string literals apart,
// and then only looks at string literals — a URL cannot appear anywhere else in valid JavaScript.
// String literals that are the value of a header-shaped key (`Referer`, `Origin`, …) are recorded
// separately: they are real data, but they are not where the script connects to.

export interface ScriptLiteral {
  /** The literal's content, escape sequences left as written. */
  value: string
  /** Offset of the first content character in the source. */
  start: number
}

export interface ScriptScan {
  /** String-literal contents, in source order. Comments and code are not included. */
  literals: ScriptLiteral[]
  /** Source with comments removed; used for patterns that must not match inside a comment. */
  withoutComments: string
  /** True when the script contains a NUL byte, i.e. it is not JavaScript text at all. */
  hasNul: boolean
}

const isLineTerminator = (ch: string): boolean => ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029'

/**
 * Splits a script into code, comments and string literals.
 *
 * This is not a parser and does not need to be: it only has to be right about where a string
 * literal starts and ends, because that is the only place a URL can live. A regular-expression
 * literal is the one construct it can misread — a `/` that opens one looks like division — and the
 * worst case is that a `/…/` is scanned as code, which can only ever *hide* a URL, never invent one.
 */
export function scanScript(script: string): ScriptScan {
  const literals: ScriptLiteral[] = []
  const code: string[] = []
  let index = 0

  const pushCode = (chunk: string): void => {
    code.push(chunk)
  }

  while (index < script.length) {
    const ch = script[index]!

    if (ch === '/' && script[index + 1] === '/') {
      // Line comment: drop it, keep the terminator so line structure survives.
      while (index < script.length && !isLineTerminator(script[index]!)) index++
      continue
    }

    if (ch === '/' && script[index + 1] === '*') {
      index += 2
      while (index < script.length && !(script[index] === '*' && script[index + 1] === '/')) index++
      index += 2
      pushCode(' ')
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      const literalStart = index
      const start = index + 1
      index++
      while (index < script.length) {
        const current = script[index]!
        if (current === '\\') {
          index += 2
          continue
        }
        if (current === quote) break
        // An unterminated single- or double-quoted string cannot span a line; stop at the newline so
        // one stray quote does not swallow the rest of the file.
        if (quote !== '`' && isLineTerminator(current)) break
        index++
      }
      literals.push({ value: script.slice(start, index), start })
      index++
      // The literal is kept verbatim in the comment-free text: credential detection needs the
      // value, and only comments have to disappear.
      pushCode(script.slice(literalStart, index))
      continue
    }

    pushCode(ch)
    index++
  }

  return {
    literals,
    withoutComments: code.join(''),
    hasNul: script.includes('\u0000'),
  }
}

/** Header-shaped keys whose value is data the script *sends*, not an origin it connects to. */
const HEADER_KEY =
  /(?:^|[,{[\s])(?:["'`]?)(referer|referrer|origin|host|cookie|authorization|user-agent|accept|accept-language|content-type|x-[a-z0-9-]+)(?:["'`]?)\s*:\s*$/iu

/**
 * True when a string literal is the value of a header-shaped key.
 *
 * Looked up on the text before the literal, not on the literal itself: `{ Referer: 'https://…' }`
 * ends with `Referer: ` immediately before the opening quote. Anything else — a plain variable, a
 * function argument, an object property named `url` — is a destination.
 */
export function isHeaderValue(sourceBeforeLiteral: string): boolean {
  return HEADER_KEY.test(sourceBeforeLiteral)
}
