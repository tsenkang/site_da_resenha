import ptBR from '../i18n/pt-BR.json'

export type Dictionary = Record<string, string>
const DICT: Dictionary = ptBR

/** Fixed Brazilian Portuguese lookup with `{name}` placeholders. */
export class I18n {
  readonly locale = 'pt-BR'
  constructor() {
    document.documentElement.lang = 'pt-BR'
  }
  t(key: string, vars: Record<string, string | number> = {}): string {
    const text = DICT[key] ?? key
    return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`))
  }
}

export function translate(key: string, vars: Record<string, string | number> = {}): string {
  const text = DICT[key] ?? key
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`))
}

export const DICTIONARY_KEYS = Object.keys(ptBR)
