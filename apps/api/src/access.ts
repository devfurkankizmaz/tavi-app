import { prisma } from './db.js'
import type { Role } from '@prisma/client'

const rank: Record<Role, number> = { VIEWER: 1, EDITOR: 2, ADMIN: 3 }

export function atLeast(role: Role | null | undefined, min: Role): boolean {
  return !!role && rank[role] >= rank[min]
}

/** Effective role on a project: owner beats membership beats team share. */
export async function projectRole(uid: string, projectId: string): Promise<Role | null> {
  const p = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: {
      ownerId: true,
      members: { where: { userId: uid }, select: { role: true } },
      teamShares: {
        where: { team: { members: { some: { userId: uid } } } },
        select: { role: true },
      },
    },
  })
  if (!p) return null
  if (p.ownerId === uid) return 'ADMIN'
  let best: Role | null = null
  for (const r of [...p.members.map(m => m.role), ...p.teamShares.map(t => t.role)]) {
    if (!best || rank[r] > rank[best]) best = r
  }
  return best
}

export async function taskRole(uid: string, taskId: string): Promise<{ projectId: string; role: Role | null } | null> {
  const t = await prisma.task.findFirst({ where: { id: taskId, deletedAt: null }, select: { projectId: true } })
  if (!t) return null
  return { projectId: t.projectId, role: await projectRole(uid, t.projectId) }
}

/** Every project id this user can see. */
export const accessibleProjectsWhere = (uid: string) => ({
  deletedAt: null,
  OR: [
    { ownerId: uid },
    { members: { some: { userId: uid } } },
    { teamShares: { some: { team: { members: { some: { userId: uid } } } } } },
  ],
})

export async function accessibleProjectIds(uid: string): Promise<string[]> {
  const ps = await prisma.project.findMany({ where: accessibleProjectsWhere(uid), select: { id: true } })
  return ps.map(p => p.id)
}

export async function documentRole(uid: string, documentId: string): Promise<{ projectId: string; role: Role | null } | null> {
  const doc = await prisma.document.findFirst({ where: { id: documentId, deletedAt: null }, select: { projectId: true } })
  if (!doc) return null
  return { projectId: doc.projectId, role: await projectRole(uid, doc.projectId) }
}

/** Comments and files hang off a task or a doc; either way the project decides access. */
export async function parentRole(
  uid: string,
  parent: { taskId: string | null; documentId: string | null },
): Promise<{ projectId: string; role: Role | null } | null> {
  if (parent.taskId) return taskRole(uid, parent.taskId)
  if (parent.documentId) return documentRole(uid, parent.documentId)
  return null
}
