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
    await expect(page.getByRole("button", { name: /a-visible\.dat, file/ }).last()).toBeVisible()
    await expect(page.getByText("Scanning…", { exact: true })).toBeVisible()
    await expect(page.getByText("Scan complete", { exact: true })).toBeVisible({ timeout: 20_000 })
  } finally {
    await application.close()
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})

test("shows saved results while resume validation is delayed", async () => {
  const root = resolve(import.meta.dirname, "../..")
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "orbis-resume-preparation-"))
  const scanRoot = join(fixtureDirectory, "fixture")
  const userData = join(fixtureDirectory, "user-data")
  await mkdir(scanRoot, { recursive: true })
  await Promise.all(Array.from({ length: 2_500 }, async (_, index) => {
    const child = join(scanRoot, `directory-${String(index).padStart(4, "0")}`)
    await mkdir(child)
    await writeFile(join(child, "file.dat"), Buffer.alloc(256))
  }))
  let application = await electron.launch({ args: [root], cwd: root, env: { ...process.env, ORBIS_SCAN_ROOT: scanRoot, ORBIS_USER_DATA: userData } })
  try {
    let page = await application.firstWindow()
    await page.getByRole("button", { name: "Scan", exact: true }).click()
    await expect(page.getByRole("group", { name: "Disk usage sunburst" })).toBeVisible({ timeout: 20_000 })
    await page.getByRole("button", { name: "Pause", exact: true }).first().click()
    await expect(page.getByText("Scan paused — progress saved", { exact: true }).first()).toBeVisible({ timeout: 20_000 })
    await application.close()

    application = await electron.launch({
      args: [root], cwd: root,
      env: { ...process.env, ORBIS_SCAN_ROOT: scanRoot, ORBIS_USER_DATA: userData, ORBIS_E2E_RESUME_VALIDATION_DELAY_MS: "1500" }
    })
    page = await application.firstWindow()
    await page.getByRole("button", { name: "Resume", exact: true }).first().click()
    await expect(page.getByText("Preparing resume...", { exact: true })).toBeVisible()
    await expect(page.getByText(/Validating saved scan/)).toBeVisible()
    await expect(page.getByRole("group", { name: "Disk usage sunburst" })).toBeVisible()
    await expect(page.getByText(/^(Scanning…|Scan complete)$/)).toBeVisible({ timeout: 20_000 })
  } finally {
    await application.close().catch(() => undefined)
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})

test("keeps product chrome fixed while disk usage content scrolls", async () => {
  const root = resolve(import.meta.dirname, "../..")
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "orbis-fixed-chrome-"))
  const scanRoot = join(fixtureDirectory, "fixture")
  const userData = join(fixtureDirectory, "user-data")
  await mkdir(scanRoot, { recursive: true })
  await Promise.all(Array.from({ length: 80 }, (_, index) => writeFile(join(scanRoot, `item-${String(index).padStart(3, "0")}.dat`), Buffer.alloc(512))))
  const application = await electron.launch({ args: [root], cwd: root, env: { ...process.env, ORBIS_SCAN_ROOT: scanRoot, ORBIS_USER_DATA: userData } })
  try {
    const page = await application.firstWindow()
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(860, 600))
    await page.getByRole("button", { name: "Scan", exact: true }).click()
    await expect(page.getByText("Scan complete", { exact: true })).toBeVisible({ timeout: 20_000 })

    const sunburst = await page.locator(".orbis-feature-panel__sunburst").boundingBox()
    const contents = await page.locator(".orbis-feature-panel__contents").boundingBox()
    expect(sunburst).not.toBeNull()
    expect(contents).not.toBeNull()
    expect(contents!.y).toBeGreaterThanOrEqual(sunburst!.y + sunburst!.height)

    const productBar = page.locator(".desktop-shell__chrome")
    const contentHeader = page.getByRole("heading", { name: "Disk usage", exact: true })
    const contentPage = page.locator(".orbis-feature-panel__page")
    const productBarBefore = await productBar.boundingBox()
    const contentHeaderBefore = await contentHeader.boundingBox()
    expect(productBarBefore).not.toBeNull()
    expect(contentHeaderBefore).not.toBeNull()

    await contentPage.evaluate((element) => { element.scrollTop = 240 })
    await expect.poll(() => contentPage.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

    const productBarAfter = await productBar.boundingBox()
    const contentHeaderAfter = await contentHeader.boundingBox()
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
    expect(productBarAfter?.y).toBe(productBarBefore?.y)
    expect(contentHeaderAfter).not.toBeNull()
    expect(contentHeaderAfter!.y).toBeLessThan(contentHeaderBefore!.y)
  } finally {
    await application.close()
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})

test("animates a folder wedge into its contents with reduced motion enabled", async () => {
  const root = resolve(import.meta.dirname, "../..")
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "orbis-folder-animation-"))
  const scanRoot = join(fixtureDirectory, "fixture")
  const userData = join(fixtureDirectory, "user-data")
  await mkdir(join(scanRoot, "Photos", "Nested"), { recursive: true })
  await mkdir(join(scanRoot, "Videos"), { recursive: true })
  await writeFile(join(scanRoot, "Photos", "Nested", "large.raw"), Buffer.alloc(32 * 1024))
  await writeFile(join(scanRoot, "Videos", "clip.mov"), Buffer.alloc(24 * 1024))
  await writeFile(join(scanRoot, "notes.txt"), "notes")
  const application = await electron.launch({ args: [root], cwd: root, env: { ...process.env, ORBIS_SCAN_ROOT: scanRoot, ORBIS_USER_DATA: userData } })
  try {
    const page = await application.firstWindow()
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.getByRole("button", { name: "Scan", exact: true }).click()
    await expect(page.getByText("Scan complete", { exact: true })).toBeVisible({ timeout: 20_000 })
    await page.evaluate(() => {
      const paths: string[] = []
      const wrap = document.querySelector(".orbis-feature-panel__sunburst-wrap")
      new MutationObserver(() => {
        for (const path of document.querySelectorAll('.orbis-feature-panel__sunburst-transition [data-track-origin]:not([data-track-origin="context"]) path')) {
          const geometry = path.getAttribute("d")
          if (geometry) paths.push(geometry)
        }
      }).observe(wrap!, { attributes: true, childList: true, subtree: true, attributeFilter: ["d"] })
      Object.assign(window, { __orbisNavigationPaths: paths })
    })
    const folderWedge = page.getByRole("button", { name: /Photos, directory, .* percent/ })
    await folderWedge.dispatchEvent("click")
    await expect(page.getByRole("complementary", { name: "Photos contents" })).toBeVisible()
    const transitionLayer = page.locator(".orbis-feature-panel__sunburst-transition")
    await expect(transitionLayer).toHaveCount(1)
    await expect(transitionLayer).toHaveAttribute("data-navigation-direction", "enter")
    await expect(page.locator(".orbis-feature-panel__sunburst-semantic-bars--hidden")).toHaveCSS("opacity", "0")
    await expect(transitionLayer).toHaveAttribute("data-navigation-phase", "morph", { timeout: 2_000 })
    await expect.poll(() => page.evaluate(() => new Set((window as unknown as { __orbisNavigationPaths: string[] }).__orbisNavigationPaths).size)).toBeGreaterThan(1)
    await expect(transitionLayer).toHaveCount(0, { timeout: 3_000 })

    await page.evaluate(() => { (window as unknown as { __orbisNavigationPaths: string[] }).__orbisNavigationPaths.length = 0 })
    await page.getByRole("button", { name: "Up" }).click()
    await expect(page.getByRole("complementary", { name: "fixture contents" })).toBeVisible()
    await expect(transitionLayer).toHaveCount(1)
    await expect(transitionLayer).toHaveAttribute("data-navigation-direction", "exit")
    await expect(transitionLayer).toHaveAttribute("data-navigation-phase", "morph")
    await expect(transitionLayer.locator('[data-track-origin="context"]')).toHaveCount(0)
    await page.waitForTimeout(400)
    await expect(transitionLayer.locator('[data-track-origin="context"]')).toHaveCount(0)
    await expect(transitionLayer).toHaveAttribute("data-navigation-phase", "context", { timeout: 2_000 })
    await page.evaluate(() => { (window as unknown as { __orbisNavigationPaths: string[] }).__orbisNavigationPaths.length = 0 })
    await page.waitForTimeout(200)
    await expect.poll(() => page.evaluate(() => new Set((window as unknown as { __orbisNavigationPaths: string[] }).__orbisNavigationPaths).size)).toBeLessThanOrEqual(1)
    await expect(transitionLayer).toHaveCount(0, { timeout: 3_000 })

    const nestedWedge = page.getByRole("button", { name: /Nested, directory, .* percent/ })
    await nestedWedge.dispatchEvent("click")
    await expect(page.getByRole("complementary", { name: "Nested contents" })).toBeVisible()
    await expect(transitionLayer).toHaveCount(1)
    await expect(transitionLayer).toHaveAttribute("data-navigation-direction", "enter")
    await expect(transitionLayer).toHaveCount(0, { timeout: 3_000 })
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
    const contents = page.getByRole("complementary", { name: "fixture contents" })
    await expect(contents).toBeVisible()
    await expect(contents.getByRole("button", { name: /Photos, directory/ })).toBeVisible()
    await expect(page.getByRole("button", { name: /large\.raw/ })).toBeVisible()
    await expect(page.getByRole("group", { name: "Disk usage sunburst" })).toBeVisible()
  } finally {
    await application.close()
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})
