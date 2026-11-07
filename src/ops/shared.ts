export type OpInputs = Record<string, string | undefined> & { repository: string }
export interface OpDeps {
  sleep(ms: number): Promise<void>
  log(line: string): void
}
export const list = (raw: string): string[] =>
  raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)

/** Strip the token from any text before it reaches a log. */
export const scrub = (text: string, token: string): string => (token ? text.split(token).join('***') : text)
