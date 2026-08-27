import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test, expect, _electron as electron } from "@playwright/test"

test("shows the file-tree sunburst while a scan is still running", async () => {
  const root = resolve(import.meta.dirname, "../..")
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "orbis-live-visualization-"))
  const scanRoot = join(fixtureDirectory, "fixture")
  const userData = join(fixtureDirectory, "user-data")
  await mkdir(scanRoot, { recursive: true })
  await writeFile(join(scanRoot, "a-visible.dat"), "data")
  await Promise.all(Array.from({ length: 2_000 }, async (_, index) => {
    const child = join(scanRoot, `z-directory-${String(index).padStart(4, "0")}`)
    await mkdir(child)
    await writeFile(join(child, "nested.dat"), "data")
  }))
  const application = await electron.launch({ args: [root], cwd: root, env: { ...process.env, ORBIS_SCAN_ROOT: scanRoot, ORBIS_USER_DATA: userData } })
  try {
    const page = await application.firstWindow()
    await page.getByRole("button", { name: "Scan", exact: true }).click()
    await expect(page.getByText("Scanning…", { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole("group", { name: "Disk usage sunburst" })).toBeVisible()
    await expect(page.getByRole("button", { name: /a-visible\.dat, file/ })).toBeVisible()
    await expect(page.getByText("Scanning…", { exact: true })).toBeVisible()
    await expect(page.getByText("Scan complete", { exact: true })).toBeVisible({ timeout: 20_000 })
  } finally {
    await application.close()
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})

test("scans the fixture without touching the startup volume", async () => {
  const root = resolve(import.meta.dirname, "../..")
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "orbis-smoke-"))
  const scanRoot = join(fixtureDirectory, "fixture")
  const userData = join(fixtureDirectory, "user-data")
  await mkdir(join(scanRoot, "Photos"), { recursive: true })
  await writeFile(join(scanRoot, "Photos", "large.raw"), Buffer.alloc(32 * 1024))
  await writeFile(join(scanRoot, "notes.txt"), "notes")
  const application = await electron.launch({ args: [root], cwd: root, env: { ...process.env, ORBIS_SCAN_ROOT: scanRoot, ORBIS_USER_DATA: userData } })
  try {
    const page = await application.firstWindow()
    await expect(page.getByText("Orbis", { exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Scan", exact: true }).click()
    await expect(page.getByText("Scan complete", { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText("Largest items", { exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: /large\.raw/ })).toBeVisible()
    await expect(page.getByRole("group", { name: "Disk usage sunburst" })).toBeVisible()
  } finally {
    await application.close()
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})
