import { useEffect, useMemo, useState } from "react"
import { DesktopAppShell, DesktopContentHeader, DesktopPage, useProductAppearance } from "@moirasia/desktop-shell/react"
import { Alert, AlertDescription, AlertTitle } from "@moirasia/ui-react/components/alert"
import { Badge } from "@moirasia/ui-react/components/badge"
import { Button } from "@moirasia/ui-react/components/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@moirasia/ui-react/components/card"
import { Progress } from "@moirasia/ui-react/components/progress"
import { AlertCircle, ChevronLeft, RefreshCw, Square } from "@moirasia/ui-react/lib/icons"
import type { ChartSegment, NodeSummary, OrbisSnapshot } from "@shared/contracts"
import { Sunburst, formatBytes } from "./Sunburst"

interface SelectedNode {
  readonly id: string | null
  readonly name: string
  readonly kind: "directory" | "file" | "other"
  readonly sizeBytes: number
  readonly percentage: number
}

export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<OrbisSnapshot>()
  const [appearance, setAppearance] = useProductAppearance(window.desktopShell)
  const [selected, setSelected] = useState<SelectedNode>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const unsubscribe = window.orbis.subscribe((next) => { if (alive) { setSnapshot(next); setError(undefined) } })
    void window.orbis.getSnapshot().then((next) => { if (alive) setSnapshot(next) }).catch((reason: unknown) => { if (alive) setError(message(reason)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false; unsubscribe() }
  }, [])

  const run = async (operation: () => Promise<OrbisSnapshot>): Promise<void> => {
    setError(undefined)
    try { setSnapshot(await operation()) }
    catch (reason) { setError(message(reason)) }
  }

  const focus = snapshot?.focus
  const scan = snapshot?.scan
  const isScanning = scan?.status === "scanning"
  const displayTotal = useMemo(() => focus && snapshot ? focus.sizeBytes + (focus.id === "n-1" && snapshot.target.isStartup ? snapshot.volume.unscannedBytes : 0) : 0, [focus, snapshot])
  const selectedPercent = selected ? selected.percentage : 0

  const activateSegment = (segment: ChartSegment): void => {
    const segmentId = segment.id
    if (segment.kind === "directory" && segmentId && segment.drillable) {
      setSelected(undefined)
      void run(() => window.orbis.focusNode(segmentId))
      return
    }
    if (segment.id !== null) setSelected({ id: segment.id, name: segment.name, kind: segment.kind === "file" ? "file" : "directory", sizeBytes: segment.sizeBytes, percentage: segment.percentage })
  }
  const selectLargest = (item: NodeSummary): void => {
    const percentage = displayTotal > 0 ? (item.sizeBytes / displayTotal) * 100 : 0
    if (item.kind === "directory" && item.directChildren > 0) {
      setSelected(undefined)
      void run(() => window.orbis.focusNode(item.id))
    } else setSelected({ id: item.id, name: item.name, kind: item.kind, sizeBytes: item.sizeBytes, percentage })
  }

  return <DesktopAppShell product="Orbis" appearance={appearance} onAppearanceChange={setAppearance}>
    <DesktopPage width="full" scroll="contained" className="orbis-page">
      <DesktopContentHeader title="Disk usage" description={snapshot ? `Scanning ${snapshot.target.name}` : "Read-only storage visualizer"} actions={<div className="orbis-actions">
        <Button size="sm" variant="outline" onClick={() => void run(() => window.orbis.chooseFolder())}>Choose Folder</Button>
        {isScanning ? <Button size="sm" variant="destructive" onClick={() => void run(() => window.orbis.cancelScan())}><Square />Cancel</Button> : <Button size="sm" onClick={() => void run(() => window.orbis.rescan())}><RefreshCw />Rescan</Button>}
      </div>} />
      {error && <Alert variant="destructive" className="orbis-alert"><AlertCircle /><AlertTitle>Orbis could not complete that action</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {loading && <div className="orbis-state" role="status">Loading Orbis…</div>}
      {!loading && snapshot && <>
        <ScanStatus snapshot={snapshot} onCancel={() => void run(() => window.orbis.cancelScan())} onRescan={() => void run(() => window.orbis.rescan())} />
        {snapshot.scan.status === "fatal-error" && <Alert variant="destructive" className="orbis-alert"><AlertCircle /><AlertTitle>Scan failed</AlertTitle><AlertDescription><span>{snapshot.scan.error ?? "Orbis could not read this folder."}</span><Button size="sm" variant="outline" onClick={() => void run(async () => { await window.orbis.openFullDiskAccess(); return snapshot })}>Open Full Disk Access</Button></AlertDescription></Alert>}
        {snapshot.scan.status === "canceled" && <Alert className="orbis-alert"><AlertTitle>Scan canceled</AlertTitle><AlertDescription>The last completed index remains available. Rescan when you are ready.</AlertDescription></Alert>}
        {snapshot.scan.totals && (snapshot.scan.totals.unreadableItems > 0 || snapshot.scan.totals.skippedItems > 0) && <PermissionWarning snapshot={snapshot} onOpen={() => void run(async () => { await window.orbis.openFullDiskAccess(); return snapshot })} />}
        <VolumeSummary snapshot={snapshot} />
        {focus ? <div className="orbis-workspace">
          <section className="orbis-chart-panel" aria-labelledby="chart-heading">
            <div className="orbis-panel-heading"><div><p className="orbis-eyebrow">LOCATION</p><h2 id="chart-heading">{focus.name}</h2></div>{focus.parentId && <Button size="sm" variant="ghost" onClick={() => void run(() => window.orbis.focusNode(focus.parentId!))}><ChevronLeft />Up</Button>}</div>
            <Breadcrumbs snapshot={snapshot} onFocus={(id) => void run(() => window.orbis.focusNode(id))} />
            {focus.directChildren === 0 && !(focus.id === "n-1" && snapshot.target.isStartup && snapshot.volume.unscannedBytes > 0) ? <div className="orbis-empty" role="status"><strong>This folder is empty</strong><span>No readable child files or folders were found.</span></div> : <Sunburst segments={snapshot.chart} onActivate={activateSegment} />}
          </section>
          <Inspector snapshot={snapshot} selected={selected} selectedPercent={selectedPercent} onSelect={selectLargest} onReveal={() => selected?.id && void run(async () => { await window.orbis.revealNode(selected.id!); return snapshot })} />
        </div> : <EmptyScanState snapshot={snapshot} onStart={() => void run(() => window.orbis.startScan())} />}
      </>}
    </DesktopPage>
  </DesktopAppShell>
}

function ScanStatus({ snapshot, onCancel, onRescan }: { readonly snapshot: OrbisSnapshot; readonly onCancel: () => void; readonly onRescan: () => void }): React.JSX.Element {
  const progress = snapshot.scan.progress
  const percent = progress && snapshot.volume.scannedBytes > 0 ? Math.min(99, progress.discoveredBytes / Math.max(progress.discoveredBytes, snapshot.volume.scannedBytes) * 100) : progress ? Math.min(95, progress.scannedItems > 0 ? 8 + Math.log10(progress.scannedItems + 1) * 12 : 4) : snapshot.scan.status === "completed" ? 100 : 0
  return <div className="scan-status" aria-live="polite">
    <div className="scan-status__copy"><strong>{snapshot.scan.status === "scanning" ? progress?.stage === "indexing" ? "Building index…" : "Scanning…" : snapshot.scan.status === "completed" ? "Scan complete" : snapshot.scan.status === "canceled" ? "Scan canceled" : snapshot.scan.status === "fatal-error" ? "Scan unavailable" : "Waiting to scan"}</strong><span>{progress ? `${progress.scannedItems.toLocaleString()} items · ${formatBytes(progress.discoveredBytes)} · ${progress.currentItem}` : snapshot.scan.totals ? `${snapshot.scan.totals.scannedItems.toLocaleString()} items · ${formatBytes(snapshot.scan.totals.discoveredBytes)} in ${(snapshot.scan.totals.elapsedMs / 1000).toFixed(1)}s` : ""}</span></div>
    {snapshot.scan.status === "scanning" ? <><Progress value={percent} max={100} className="scan-progress" /><Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button></> : snapshot.scan.status === "canceled" ? <Button size="sm" onClick={onRescan}>Rescan</Button> : null}
  </div>
}

function PermissionWarning({ snapshot, onOpen }: { readonly snapshot: OrbisSnapshot; readonly onOpen: () => void }): React.JSX.Element {
  const totals = snapshot.scan.totals!
  return <Alert className="orbis-alert permission-warning"><AlertCircle /><AlertTitle>Some paths were skipped</AlertTitle><AlertDescription><span>{totals.skippedItems.toLocaleString()} item{totals.skippedItems === 1 ? "" : "s"} could not be included. Protected or unreadable paths remain in unscanned space.</span><Button size="sm" variant="outline" onClick={onOpen}>Open Full Disk Access</Button></AlertDescription></Alert>
}

function VolumeSummary({ snapshot }: { readonly snapshot: OrbisSnapshot }): React.JSX.Element {
  const { capacityBytes, freeBytes, scannedBytes, unscannedBytes } = snapshot.volume
  return <div className="volume-summary" aria-label="Storage summary">
    <Metric label="Capacity" value={formatBytes(capacityBytes)} />
    <Metric label="Free" value={formatBytes(freeBytes)} />
    <Metric label="Readable scanned" value={formatBytes(scannedBytes)} />
    {unscannedBytes > 0 && <Metric label="Unscanned or system data" value={formatBytes(unscannedBytes)} muted />}
  </div>
}

function Metric({ label, value, muted = false }: { readonly label: string; readonly value: string; readonly muted?: boolean }): React.JSX.Element {
  return <div className={`volume-metric${muted ? " volume-metric--muted" : ""}`}><span>{label}</span><strong>{value}</strong></div>
}

function Breadcrumbs({ snapshot, onFocus }: { readonly snapshot: OrbisSnapshot; readonly onFocus: (id: string) => void }): React.JSX.Element {
  return <nav className="orbis-breadcrumbs" aria-label="Folder breadcrumbs">{snapshot.breadcrumbs.map((breadcrumb, index) => <span key={breadcrumb.id}><button type="button" onClick={() => onFocus(breadcrumb.id)} aria-current={index === snapshot.breadcrumbs.length - 1 ? "location" : undefined}>{breadcrumb.name}</button>{index < snapshot.breadcrumbs.length - 1 && <span aria-hidden="true">/</span>}</span>)}</nav>
}

function Inspector({ snapshot, selected, selectedPercent, onSelect, onReveal }: { readonly snapshot: OrbisSnapshot; readonly selected: SelectedNode | undefined; readonly selectedPercent: number; readonly onSelect: (item: NodeSummary) => void; readonly onReveal: () => void }): React.JSX.Element {
  return <aside className="orbis-inspector" aria-labelledby="largest-heading">
    {selected ? <Card className="selection-card"><CardHeader><div className="orbis-panel-heading"><div><p className="orbis-eyebrow">SELECTED ITEM</p><CardTitle>{selected.name}</CardTitle></div><Badge variant="outline">{selected.kind}</Badge></div><CardDescription>{formatBytes(selected.sizeBytes)} · {selectedPercent.toFixed(1)}% of this folder</CardDescription></CardHeader><CardContent><Button size="sm" variant="outline" disabled={!selected.id} onClick={onReveal}>Reveal in Finder</Button></CardContent></Card> : <Card className="selection-card selection-card--empty"><CardHeader><CardTitle>Select an item</CardTitle><CardDescription>Choose a file in the chart or list to see its size and reveal it in Finder.</CardDescription></CardHeader></Card>}
    <Card className="largest-card"><CardHeader><CardTitle id="largest-heading">Largest items</CardTitle><CardDescription>Direct children of {snapshot.focus?.name ?? snapshot.target.name}, sorted by allocated space.</CardDescription></CardHeader><CardContent>{snapshot.largestItems.length === 0 ? <p className="orbis-muted">No readable items in this folder.</p> : <ul className="largest-list">{snapshot.largestItems.map((item) => <li key={item.id}><button type="button" onClick={() => onSelect(item)} aria-label={`${item.name}, ${item.kind}, ${formatBytes(item.sizeBytes)}`}><span className="largest-list__name"><span className={`node-dot node-dot--${item.kind}`} aria-hidden="true" />{item.name}</span><span className="largest-list__size">{formatBytes(item.sizeBytes)}</span></button></li>)}</ul>}</CardContent></Card>
  </aside>
}

function EmptyScanState({ snapshot, onStart }: { readonly snapshot: OrbisSnapshot; readonly onStart: () => void }): React.JSX.Element {
  return <div className="orbis-empty orbis-empty--large"><h2>No completed scan</h2><p>{snapshot.scan.error ?? "Orbis has not indexed a folder yet."}</p><Button onClick={onStart}>Scan {snapshot.target.name}</Button></div>
}

function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
