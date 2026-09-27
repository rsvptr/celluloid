/**
 * Prisma `where` filter for a tag name, matched case-insensitively like the
 * (userId, lower(name)) unique index.
 *
 * Prisma compiles `equals` with `mode: "insensitive"` to `"name" ILIKE $n` and
 * sends the value unescaped, so `%` and `_` in a tag name acted as wildcards
 * that matched other tags, and a trailing `\` made Postgres reject the pattern
 * (PR-02). Escaping `\`, `%` and `_` with backslash, ILIKE's default escape
 * character, leaves an exact case-insensitive comparison. The mode is part of
 * the filter because the escaping is only right for ILIKE: a case-sensitive
 * `equals` compiles to `=`, where the backslashes would be literal.
 */
export function tagNameFilter(name: string) {
  return { equals: name.replace(/[\\%_]/g, "\\$&"), mode: "insensitive" as const };
}
