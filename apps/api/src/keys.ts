import { prisma } from './db.js'

const FOLD: Record<string, string> = {
  ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u',
  Ç: 'C', Ğ: 'G', İ: 'I', Ö: 'O', Ş: 'S', Ü: 'U',
}

/** Derives a prefix like TAV or WEB from a title, folding accents to ASCII. */
export function keyFromTitle(title: string): string {
  const ascii = [...title].map(ch => FOLD[ch] ?? ch).join('')
  const letters = ascii.replace(/[^A-Za-z]/g, '').toUpperCase()
  const words = ascii.trim().split(/\s+/).filter(Boolean)

  // For multi-word titles, initials read better than a truncation
  const initials = words.length >= 2
    ? words.map(w => w[0]).join('').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 4)
    : ''

  const base = (initials.length >= 2 ? initials : letters.slice(0, 3)) || 'PRJ'
  return base.length >= 2 ? base : 'PRJ'
}

/** Appends a number until the key is unique in the database. */
export async function uniqueProjectKey(title: string): Promise<string> {
  const base = keyFromTitle(title)
  for (let i = 0; i < 200; i++) {
    const candidate = i === 0 ? base : `${base}${i + 1}`
    const clash = await prisma.project.findUnique({ where: { key: candidate }, select: { id: true } })
    if (!clash) return candidate
  }
  return `${base}${Date.now().toString(36).toUpperCase().slice(-4)}`
}

export const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,5}$/

/** The task's visible identity: TAV-12 */
export const taskKey = (projectKey: string, number: number) => `${projectKey}-${number}`
