/**
 * Regenerates the screenshots in docs/screenshots.
 *
 * Drives the running dev server through the system Chrome, signing in as the
 * seeded demo account so every image shows the same data. Run it after
 * `npm run db:seed -- --reset` and the pictures in the README stay honest.
 *
 *   npm run dev            # in one terminal
 *   npm run screenshots    # in another
 *
 * Uses playwright-core against an already-installed Chrome, so nothing large
 * is downloaded.
 */
import 'dotenv/config'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'

const WEB = process.env.SCREENSHOT_ORIGIN ?? 'http://localhost:5173'
const OUT = path.resolve('../../docs/screenshots')
const EMAIL = 'ada@tavi.local'
const PASSWORD = 'tavi-demo-1234'

/** Wide enough for the sidebar and a full board, short enough to read in a README. */
const VIEWPORT = { width: 1440, height: 900 }

interface Shot {
  name: string
  path: string
  /** Anything that has to happen after the page loads. */
  prepare?: (page: Page) => Promise<void>
}

/*
 * A handful of screens, not a gallery. Enough for someone browsing the repo
 * to picture the product without scrolling past twenty pictures.
 */
const SHOTS: Shot[] = [
  { name: 'overview', path: '/' },
  {
    name: 'board',
    path: '/',
    prepare: async page => {
      await page.getByRole('link', { name: /Tavi v1 Launch/ }).first().click()
      await page.getByRole('button', { name: 'Kanban', exact: true }).click()
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'task',
    path: '/',
    prepare: async page => {
      await page.getByRole('link', { name: /Tavi v1 Launch/ }).first().click()
      await page.waitForTimeout(500)
      await page.locator('.task-row').first().click()
      await page.waitForTimeout(800)
    },
  },
  { name: 'calendar', path: '/calendar' },
  {
    // Only captured when an assistant key is configured; skipped otherwise
    name: 'assistant',
    path: '/',
    prepare: async page => {
      const bubble = page.locator('.assistant-bubble')
      if (!(await bubble.count())) throw new SkipShot('no assistant key configured')
      await bubble.click()
      await page.locator('.assistant-input textarea').fill(
        'What is overdue or due this week? One line each.',
      )
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      /*
       * Wait for a real answer, not the busy indicator: that one also carries
       * .assistant-turn.agent, so it has to be excluded explicitly.
       */
      await page.locator('.assistant-turn.agent:not(.working)').first()
        .waitFor({ timeout: 90_000 })
      await page.waitForTimeout(1500)
    },
  },
]

/** Thrown by a shot that cannot run in this environment. */
class SkipShot extends Error {}

/*
 * The login screen is the one thing the signed-in context can never show, so
 * it gets a context of its own, opened before anybody signs in. What it offers
 * follows the server's configuration: run it with GOOGLE_CLIENT_ID set and
 * DEV_LOGIN=0 to capture the screen a self-hosted instance actually presents.
 */
async function captureLogin(browser: Browser) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  })
  const page = await context.newPage()
  await page.goto(WEB)
  // Sign-in options are drawn from /auth/config, so wait for them, not the page
  await page.locator('.login-card').waitFor({ timeout: 15_000 })
  await page.waitForTimeout(900)
  const file = path.join(OUT, 'login.png')
  await page.screenshot({ path: file })
  console.log('wrote', path.relative(process.cwd(), file))
  await context.close()
}

async function main() {
  await mkdir(OUT, { recursive: true })

  // Headless: a visible window is not needed and stalls in some environments
  const browser = await chromium.launch({ channel: 'chrome', headless: true })

  await captureLogin(browser)

  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  })

  // Sign in through the API, so the session cookie is set before the first paint
  const page = await context.newPage()
  await page.goto(WEB)
  const status = await page.evaluate(async ({ email, password }) => {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    return res.status
  }, { email: EMAIL, password: PASSWORD })

  if (status !== 200) {
    throw new Error(`could not sign in as ${EMAIL} (${status}). Run: npm run db:seed`)
  }

  for (const shot of SHOTS) {
    try {
      await page.goto(`${WEB}${shot.path}`)
      await page.waitForTimeout(900)
      await shot.prepare?.(page)
      // Let the entry animations settle so nothing is caught mid-flight
      await page.waitForTimeout(700)
      const file = path.join(OUT, `${shot.name}.png`)
      await page.screenshot({ path: file })
      console.log('wrote', path.relative(process.cwd(), file))
    } catch (err) {
      if (err instanceof SkipShot) {
        console.log(`skipped ${shot.name}: ${err.message}`)
        continue
      }
      throw err
    }
  }

  await browser.close()
}

main().catch(err => {
  console.error('could not take screenshots:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
