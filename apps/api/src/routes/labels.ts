import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { fail } from '../middleware.js'

export const labelsRouter = Router()

const labelBody = z.object({
  title: z.string().trim().min(1).max(120),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
})

labelsRouter.get('/labels', async (req, res) => {
  res.json(await prisma.label.findMany({ where: { ownerId: req.uid! }, orderBy: { title: 'asc' } }))
})

labelsRouter.post('/labels', async (req, res) => {
  const body = labelBody.safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.label_title_required', 'invalid')
  try {
    const label = await prisma.label.create({ data: { ...body.data, ownerId: req.uid! } })
    res.status(201).json(label)
  } catch {
    fail(res, 409, 'err.label_exists', 'conflict')
  }
})

labelsRouter.patch('/labels/:id', async (req, res) => {
  const label = await prisma.label.findFirst({ where: { id: req.params.id, ownerId: req.uid! } })
  if (!label) return fail(res, 404, 'err.label_not_found', 'not_found')
  const body = labelBody.partial().safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid_label', 'invalid')
  res.json(await prisma.label.update({ where: { id: label.id }, data: body.data }))
})

labelsRouter.delete('/labels/:id', async (req, res) => {
  const label = await prisma.label.findFirst({ where: { id: req.params.id, ownerId: req.uid! } })
  if (!label) return fail(res, 404, 'err.label_not_found', 'not_found')
  await prisma.label.delete({ where: { id: label.id } })
  res.json({ ok: true })
})
