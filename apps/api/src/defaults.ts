import { prisma } from './db.js'
import { t } from './i18n.js'

/**
 * Every new account starts with these labels, so nobody meets an empty
 * list before they can start sorting anything.
 * They can be renamed, recoloured or deleted.
 */
export const DEFAULT_LABELS = [
  { title: 'Bug', color: '#c1322c' },
  { title: 'Feature', color: '#a86107' },
  { title: 'Improvement', color: '#2a6597' },
  { title: 'Design', color: '#8e4ec6' },
  { title: 'Docs', color: '#0e8f9e' },
  { title: 'Research', color: '#257a53' },
  { title: 'Chore', color: '#8b8378' },
  { title: 'Blocked', color: '#9c1f1a' },
] as const

/**
 * Kanban columns for a new project. They can be renamed, added to or
 * removed; they exist only so a board does not start empty.
 */
export const DEFAULT_BUCKETS = [
  { title: t('bucket.todo'), position: 100, isDoneBucket: false },
  { title: t('bucket.doing'), position: 200, isDoneBucket: false },
  { title: t('bucket.done'), position: 300, isDoneBucket: true },
]

export async function createDefaultLabels(userId: string): Promise<void> {
  await prisma.label.createMany({
    data: DEFAULT_LABELS.map(label => ({ ...label, ownerId: userId })),
    skipDuplicates: true,
  })
}
