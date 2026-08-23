/**
 * In-package copy for the `ui.gitBranch` locale namespace. Both shipped
 * languages are required by the typed two-locale registration overload.
 */

/** Locale keys of the ui.gitBranch namespace. */
export type GitBranchLocaleKey = 'hint' | 'detachedHead'

/** English copy. */
export const en: Record<GitBranchLocaleKey, string> = {
  hint: 'Git branch of this session\'s working directory',
  detachedHead: 'Detached HEAD',
}

/** Simplified Chinese copy. */
export const zh: Record<GitBranchLocaleKey, string> = {
  hint: '本会话工作目录所在的 Git 分支',
  detachedHead: '分离 HEAD',
}
